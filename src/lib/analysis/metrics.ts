import type { Language, StaticFunctionMetric, StaticMetrics } from "../schemas.ts";
import type { RawFinding } from "./secrets.ts";

const blank = (s: string) => s.replace(/[^\n]/g, " ");

// Blanks out comments and string literals, keeping every newline so line numbers still line up.
export function stripCode(code: string, language: Language): string {
  const py = language === "python";
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    let j = -1;
    if ((py && c === "#") || (!py && code.startsWith("//", i))) {
      j = code.indexOf("\n", i);
      if (j === -1) j = code.length;
    } else if (!py && code.startsWith("/*", i)) {
      j = code.indexOf("*/", i + 2);
      j = j === -1 ? code.length : j + 2;
    } else if (py && (code.startsWith('"""', i) || code.startsWith("'''", i))) {
      j = code.indexOf(code.slice(i, i + 3), i + 3);
      j = j === -1 ? code.length : j + 3;
    } else if (c === '"' || c === "'" || (!py && c === "`")) {
      j = i + 1;
      while (j < code.length && code[j] !== c && (code[j] !== "\n" || c === "`")) j += code[j] === "\\" ? 2 : 1;
      j = Math.min(j + 1, code.length);
    }
    if (j === -1) {
      out += c;
      i++;
    } else {
      out += blank(code.slice(i, j));
      i = j;
    }
  }
  return out;
}

const JS_FN = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  /^\s*(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/,
];
const JAVA_FN =
  /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|default)\s+)*(?:<[^>]+>\s+)?(?:[\w<>[\],.?]+\s+)?([A-Za-z_]\w*)\s*\([^;=]*$/;
const NOT_FUNCTIONS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "else", "do", "try", "synchronized"]);

const DECISIONS: Record<"python" | "brace", RegExp> = {
  python: /\b(?:if|elif|for|while|except|and|or|case)\b/g,
  brace: /\b(?:if|for|while|case|catch)\b|&&|\|\||\?\?|\?(?![.?:>])/g,
};

const indentOf = (s: string) => s.length - s.trimStart().length;

type Span = { name: string; start: number; end: number }; // 0-based inclusive line indexes

function pythonFunctions(lines: string[]): Span[] {
  const spans: Span[] = [];
  lines.forEach((text, i) => {
    const m = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(text);
    if (!m) return;
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (indentOf(lines[j]) <= m[1].length) break;
      end = j;
    }
    spans.push({ name: m[2], start: i, end });
  });
  return spans;
}

function braceFunctions(lines: string[], language: Language): Span[] {
  const spans: Span[] = [];
  lines.forEach((text, i) => {
    const name =
      language === "java"
        ? JAVA_FN.exec(text)?.[1]
        : JS_FN.map((re) => re.exec(text)).find(Boolean)?.slice(1).find((g) => g) ?? (/\bfunction\b/.test(text) ? "(anonymous)" : undefined);
    if (!name || NOT_FUNCTIONS.has(name)) return;
    // Find the opening brace within the next few lines, then its matching close.
    let depth = 0;
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      if (!opened && j > i + 3) break;
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++;
          opened = true;
        } else if (ch === "}") depth--;
      }
      if (opened && depth <= 0) return spans.push({ name, start: i, end: j });
      if (!opened && /;\s*$/.test(lines[j])) break; // declaration or call, not a body
    }
    if (!opened && language !== "java") spans.push({ name, start: i, end: i }); // expression-bodied arrow
  });
  return spans;
}

function measure(lines: string[], span: Span, language: Language): StaticFunctionMetric {
  const body = lines.slice(span.start, span.end + 1);
  const decisions = body.join("\n").match(DECISIONS[language === "python" ? "python" : "brace"])?.length ?? 0;
  let nesting = 0;
  if (language === "python") {
    const code = body.slice(1).filter((l) => l.trim());
    const base = code.length ? indentOf(code[0]) : 0;
    const step = Math.max(1, base - indentOf(body[0]));
    for (const l of code) nesting = Math.max(nesting, Math.floor((indentOf(l) - base) / step));
  } else {
    let depth = 0;
    for (const ch of body.join("\n")) {
      if (ch === "{") nesting = Math.max(nesting, ++depth);
      else if (ch === "}") depth--;
    }
    nesting = Math.max(0, nesting - 1); // the function's own braces
  }
  return {
    name: span.name,
    start_line: span.start + 1,
    end_line: span.end + 1,
    cyclomatic: 1 + decisions,
    nesting_depth: nesting,
  };
}

// Share of significant lines that belong to a 4-line window appearing more than once.
function duplication(lines: string[]): number {
  const sig = lines
    .map((l, i) => ({ i, t: l.trim().replace(/\s+/g, " ") }))
    .filter(({ t }) => t.length >= 8 && !/^[{}()[\];,]+$/.test(t));
  if (sig.length < 8) return 0;
  const seen = new Map<string, number>();
  const dup = new Set<number>();
  for (let k = 0; k + 4 <= sig.length; k++) {
    const key = sig.slice(k, k + 4).map((s) => s.t).join("\n");
    const prev = seen.get(key);
    if (prev === undefined) seen.set(key, k);
    else for (let d = 0; d < 4; d++) dup.add(sig[prev + d].i).add(sig[k + d].i);
  }
  return Math.round((dup.size / sig.length) * 1000) / 10;
}

// ponytail: regex/brace heuristics, not a real AST. Accurate on typical student/single-file code;
// swap in Tree-sitter grammars if per-function metrics need to be exact on exotic syntax.
export function computeMetrics(stripped: string, language: Language): { metrics: StaticMetrics; findings: RawFinding[] } {
  const lines = stripped.split("\n");
  const spans = language === "python" ? pythonFunctions(lines) : braceFunctions(lines, language);
  const functions = spans.map((s) => measure(lines, s, language));
  const whole = measure(lines, { name: "(file)", start: 0, end: lines.length - 1 }, language);
  const metrics: StaticMetrics = {
    loc: lines.filter((l) => l.trim()).length,
    function_count: functions.length,
    cyclomatic: functions.length ? Math.max(...functions.map((f) => f.cyclomatic)) : whole.cyclomatic,
    nesting_depth: functions.length ? Math.max(...functions.map((f) => f.nesting_depth)) : whole.nesting_depth,
    duplication_pct: duplication(lines),
    functions,
  };

  const findings: RawFinding[] = [];
  const add = (f: StaticFunctionMetric | null, rule: string, message: string, severity: RawFinding["severity"]) =>
    findings.push({
      tool: "metrics",
      rule,
      message,
      category: "maintainability",
      severity,
      start_line: f?.start_line ?? 1,
      end_line: f?.start_line ?? 1,
      cwe: null,
      fix_safety: "needs_review",
      fix_hint: null,
    });
  for (const f of functions) {
    if (f.cyclomatic > 10)
      add(f, "cyclomatic-complexity", `\`${f.name}\` has cyclomatic complexity ${f.cyclomatic} (threshold 10).`, f.cyclomatic > 20 ? "high" : "medium");
    if (f.nesting_depth > 3)
      add(f, "nesting-depth", `\`${f.name}\` nests ${f.nesting_depth} levels deep (threshold 3).`, f.nesting_depth > 5 ? "medium" : "low");
    if (f.end_line - f.start_line + 1 > 60)
      add(f, "function-length", `\`${f.name}\` is ${f.end_line - f.start_line + 1} lines long (threshold 60).`, "low");
  }
  if (metrics.duplication_pct > 15)
    add(null, "duplication", `${metrics.duplication_pct}% of the code is duplicated (threshold 15%).`, "low");
  return { metrics, findings };
}
