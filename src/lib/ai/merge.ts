import { SEVERITY_RANK } from "../analysis/index.ts";
import type {
  AiReviewOutput,
  Finding,
  FindingCategory,
  FixSafety,
  ReviewMetrics,
  ReviewMode,
  StaticFinding,
  StaticFunctionMetric,
  StaticMetrics,
} from "../schemas.ts";

const STATIC_CONFIDENCE = 0.9;
const MIN_AI_CONFIDENCE = 0.5;
// The AI can doubt analyzer evidence but can't make it disappear (prompt-injection resistance).
const MIN_CONFIRMED_CONFIDENCE = 0.5;

const WHY_BY_CATEGORY: Record<FindingCategory, string> = {
  bug: "This pattern commonly causes incorrect behaviour or runtime errors.",
  security: "This pattern is a known source of security vulnerabilities.",
  performance: "This does more work than necessary and can slow the program down as input grows.",
  quality: "This makes the code harder to read, review and maintain.",
  maintainability: "Complex code is harder to test, understand and change safely.",
};

const OWASP_BY_CWE: Record<string, string> = {
  "CWE-89": "A03:2021 Injection",
  "CWE-78": "A03:2021 Injection",
  "CWE-95": "A03:2021 Injection",
  "CWE-79": "A03:2021 Injection",
  "CWE-798": "A07:2021 Identification and Authentication Failures",
  "CWE-327": "A02:2021 Cryptographic Failures",
  "CWE-295": "A02:2021 Cryptographic Failures",
  "CWE-502": "A08:2021 Software and Data Integrity Failures",
};

// PRD 12.4 grounding: performance and maintainability fixes replace algorithms or restructure code, which can
// change behaviour, so they never qualify for one-click "Fix All Safe Issues" whatever the model claims.
const SAFETY_FLOOR: Partial<Record<FindingCategory, FixSafety>> = { performance: "needs_review", maintainability: "needs_review" };
const SAFETY_RANK: Record<FixSafety, number> = { safe: 0, needs_review: 1, manual_only: 2 };
const atLeast = (safety: FixSafety, category: FindingCategory) => {
  const floor = SAFETY_FLOOR[category];
  return floor && SAFETY_RANK[floor] > SAFETY_RANK[safety] ? floor : safety;
};

/**
 * Models often echo surrounding lines in fix_code (e.g. repeat the loop above the line they fix). If the fix
 * starts with an exact copy of the lines just above the range, or ends with the lines just below, it means to
 * replace them too, so extend the range. Nothing is lost: those lines reappear verbatim in the fix.
 */
export function absorbEchoedContext(lines: string[], loc: { start: number; end: number }, fixCode: string) {
  const fix = fixCode.replace(/\s+$/, "").split("\n").map((l) => l.trim());
  const orig = (n: number) => (lines[n - 1] ?? "").trim(); // 1-based
  const matches = (fixFrom: number, origFrom: number, k: number) =>
    Array.from({ length: k }, (_, j) => fix[fixFrom + j] === orig(origFrom + j)).every(Boolean) &&
    Array.from({ length: k }, (_, j) => orig(origFrom + j)).some(Boolean); // not just blank lines
  let { start, end } = loc;
  for (let k = Math.min(fix.length - 1, start - 1); k > 0; k--)
    if (matches(0, start - k, k)) {
      start -= k;
      break;
    }
  for (let k = Math.min(fix.length - 1, lines.length - end); k > 0; k--)
    if (matches(fix.length - k, end + 1, k)) {
      end += k;
      break;
    }
  return { start, end };
}

/**
 * A fix that also (re)defines a function living outside its range would leave two definitions behind (seen live:
 * a "docstrings" fix for one function carried a rewritten copy of the next). If that function sits right next to
 * the range (only blank lines between), the fix means to replace it too, so extend the range. If it isn't
 * adjacent, report a conflict so the fix can't be bulk-applied.
 */
export function absorbRedefinedFunctions(lines: string[], loc: { start: number; end: number }, fixCode: string, functions: StaticFunctionMetric[]) {
  const defined = new Set([...fixCode.matchAll(/^\s*(?:export\s+)?(?:async\s+)?(?:def|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  const blank = (from: number, to: number) => lines.slice(from - 1, to).every((l) => !l.trim()); // 1-based, inclusive
  let { start, end } = loc;
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of functions) {
      if (!defined.has(f.name) || (f.start_line >= start && f.end_line <= end)) continue;
      if (f.start_line > end && blank(end + 1, f.start_line - 1)) {
        end = f.end_line;
        grew = true;
      } else if (f.end_line < start && blank(f.end_line + 1, start - 1)) {
        start = f.start_line;
        grew = true;
      }
    }
  }
  const conflict = functions.some((f) => defined.has(f.name) && (f.start_line < start || f.end_line > end));
  return { start, end, conflict };
}

/**
 * Models sometimes return fix_code without the surrounding indentation (a guard inside a function at column 0),
 * which breaks indentation-sensitive code. Shift an under-indented fix to the indentation of the line it replaces.
 */
export function reindentFix(lines: string[], loc: { start: number; end: number }, fixCode: string) {
  const fix = fixCode.split("\n");
  const indentOf = (s: string) => /^[ \t]*/.exec(s)![0];
  const target = indentOf(lines[loc.start - 1] ?? "");
  const code = fix.filter((l) => l.trim());
  if (!code.length) return fixCode;
  const min = Math.min(...code.map((l) => indentOf(l).length));
  const shift = target.length - min;
  if (shift <= 0) return fixCode;
  const pad = (target[0] === "\t" ? "\t" : " ").repeat(shift);
  return fix.map((l) => (l.trim() ? pad + l : l)).join("\n");
}

/**
 * A replacement that ends by leaving the block (return/raise/throw/...) while the original has more code
 * right after the replaced range would orphan that code. Such fixes need a human look, never bulk-apply.
 */
export function orphansNextLine(lines: string[], loc: { start: number; end: number }, fixCode: string) {
  const last = fixCode.replace(/\s+$/, "").split("\n").pop() ?? "";
  if (!/^\s*(return|raise|throw|break|continue)\b/.test(last)) return false;
  const next = lines[loc.end]; // line after the range (0-based index = end)
  if (!next?.trim()) return false;
  const indent = (s: string) => s.length - s.trimStart().length;
  return indent(next) >= indent(last) && !/^\s*[})\]]/.test(next) && !/^\s*(else|elif|except|finally|case|default)\b/.test(next);
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
const normalizeCwe = (cwe: string | null) => {
  const m = cwe && /CWE[-\s]?(\d+)/i.exec(cwe);
  return m ? `CWE-${m[1]}` : null;
};

/**
 * PRD 12.2: every cited line must exist and match the quoted evidence. If the model got the line number
 * wrong but quoted real code, move the finding to the nearest matching line; otherwise reject it.
 */
export function verifyLocation(lines: string[], start: number, end: number, evidence: string) {
  const ev = normalize(evidence.split("\n")[0] ?? "");
  if (!ev) return null;
  const span = Math.max(0, end - start);
  const matches = (n: number) => {
    const l = normalize(lines[n - 1] ?? "");
    return l.length > 0 && (l === ev || (ev.length >= 4 && l.includes(ev)) || (l.length >= 8 && ev.includes(l)));
  };
  let best = start >= 1 && start <= lines.length && matches(start) ? start : -1;
  if (best === -1)
    for (let n = 1; n <= lines.length; n++) if (matches(n) && (best === -1 || Math.abs(n - start) < Math.abs(best - start))) best = n;
  return best === -1 ? null : { start: best, end: Math.min(best + span, lines.length) };
}

/**
 * Models are good at the first line of an issue and sloppy with the last. Fixes replace exactly
 * start..end, so a range that runs past its function would delete the next one. Clamp it.
 */
export function clampToFunction(loc: { start: number; end: number }, functions: StaticFunctionMetric[]) {
  const owner = functions
    .filter((f) => f.start_line <= loc.start && loc.start <= f.end_line)
    .sort((a, b) => a.end_line - a.start_line - (b.end_line - b.start_line))[0];
  if (owner) return { start: loc.start, end: Math.min(loc.end, owner.end_line) };
  // Top-level code: stop before the next function begins.
  const next = functions.filter((f) => f.start_line > loc.start && f.start_line <= loc.end).sort((a, b) => a.start_line - b.start_line)[0];
  return next ? { start: loc.start, end: Math.max(loc.start, next.start_line - 1) } : loc;
}

function fromStatic(s: StaticFinding, file: string): Omit<Finding, "id"> {
  return {
    category: s.category,
    severity: s.severity,
    title: s.message.replace(/\.$/, "").slice(0, 160),
    location: { file, start_line: s.start_line, end_line: s.end_line },
    problem: s.message,
    why: WHY_BY_CATEGORY[s.category],
    fix: s.fix_hint ?? `Resolve the ${s.tool} \`${s.rule}\` issue reported on this line.`,
    fix_code: null,
    fix_imports: [],
    fix_safety: s.fix_safety,
    source: "static",
    confidence: STATIC_CONFIDENCE,
    cwe: s.cwe,
    owasp: s.cwe ? (OWASP_BY_CWE[s.cwe] ?? null) : null,
    student_explanation: null,
    status: "open",
  };
}

// Merge stage (PRD 10.1): reconcile AI findings with analyzer evidence, verify locations, de-duplicate, rank.
export function mergeFindings(args: {
  code: string;
  fileName: string;
  mode: ReviewMode;
  staticFindings: StaticFinding[];
  ai: AiReviewOutput | null;
  /** Analyzer function spans, used to keep AI-cited ranges inside one function. */
  functions?: StaticFunctionMetric[];
}): Finding[] {
  const lines = args.code.split("\n");
  const byId = new Map(args.staticFindings.map((s) => [s.id, s]));
  const used = new Set<string>();
  const merged: Omit<Finding, "id">[] = [];

  for (const a of args.ai?.findings ?? []) {
    if (a.static_ref && used.has(a.static_ref)) continue; // second finding for the same evidence
    let ref = a.static_ref ? byId.get(a.static_ref) : undefined;
    let loc: { start: number; end: number } | null;
    if (ref) {
      loc = { start: ref.start_line, end: ref.end_line }; // analyzer location is authoritative
    } else {
      if (a.confidence < MIN_AI_CONFIDENCE) continue;
      loc = verifyLocation(lines, a.location.start_line, a.location.end_line, a.evidence);
      if (!loc) continue; // hallucinated or mis-quoted location
      loc = clampToFunction(loc, args.functions ?? []);
      const at = loc;
      // The model found something an analyzer also flagged but didn't cite it: still counts as Verified.
      ref = args.staticFindings.find(
        (s) => !used.has(s.id) && s.category === a.category && s.start_line >= at.start && s.start_line <= at.end,
      );
    }
    if (ref) used.add(ref.id);
    const cwe = normalizeCwe(a.cwe) ?? ref?.cwe ?? null;
    let fixCode = a.fix_code?.trim() ? a.fix_code : null;
    let redefinitionConflict = false;
    if (fixCode && !ref) loc = absorbEchoedContext(lines, loc, fixCode);
    if (fixCode) {
      const r = absorbRedefinedFunctions(lines, loc, fixCode, args.functions ?? []);
      loc = { start: r.start, end: r.end };
      redefinitionConflict = r.conflict;
      fixCode = reindentFix(lines, loc, fixCode);
    }
    let safety = atLeast(a.fix_safety, a.category);
    if (safety === "safe" && fixCode && (redefinitionConflict || orphansNextLine(lines, loc, fixCode))) safety = "needs_review";
    merged.push({
      category: a.category,
      severity: a.severity,
      title: a.title,
      location: { file: args.fileName, start_line: loc.start, end_line: loc.end },
      problem: a.problem,
      why: a.why,
      fix: a.fix,
      fix_code: fixCode,
      fix_imports: fixCode ? a.fix_imports.map((i) => i.trim()).filter(Boolean) : [],
      fix_safety: safety,
      source: ref ? "both" : "ai",
      confidence: ref ? Math.max(a.confidence, MIN_CONFIRMED_CONFIDENCE) : a.confidence,
      cwe,
      owasp: a.owasp?.trim() || (cwe ? (OWASP_BY_CWE[cwe] ?? null) : null),
      student_explanation: args.mode === "student" ? a.student_explanation?.trim() || null : null,
      status: "open",
    });
  }

  // Evidence the AI didn't address (or every finding, when the AI is unavailable) is still reported.
  for (const s of args.staticFindings) if (!used.has(s.id)) merged.push(fromStatic(s, args.fileName));

  return merged
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.location.start_line - b.location.start_line)
    .map((f, i) => ({ id: `F-${String(i + 1).padStart(4, "0")}`, ...f }));
}

// Models write "find_duplicates(items)" or "UserService.find"; compare bare identifiers.
const bareName = (n: string) => n.replace(/\([\s\S]*$/, "").split(".").pop()!.trim();

// Attach the AI's Big-O estimates to the analyzer's per-function metrics, matching by name or by line range.
export function mergeMetrics(metrics: StaticMetrics, complexity: AiReviewOutput["complexity"] | null): ReviewMetrics {
  return {
    ...metrics,
    time_complexity: complexity?.time_complexity ?? null,
    space_complexity: complexity?.space_complexity ?? null,
    functions: metrics.functions.map((f) => {
      const c = complexity?.functions
        .filter((c) => bareName(c.name) === f.name || (c.start_line >= f.start_line && c.start_line <= f.end_line))
        .sort((a, b) => Math.abs(a.start_line - f.start_line) - Math.abs(b.start_line - f.start_line))[0];
      return {
        ...f,
        time_complexity: c?.time_complexity ?? null,
        space_complexity: c?.space_complexity ?? null,
        explanation: c?.explanation ?? null,
        suggestion: c?.suggestion ?? null,
      };
    }),
  };
}
