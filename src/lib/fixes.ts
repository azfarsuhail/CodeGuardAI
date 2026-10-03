import type { Finding, FixSafety } from "./schemas.ts";

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;

export type AppliedChange = {
  finding_ref: string;
  title: string;
  safety: FixSafety;
  start_line: number;
  end_line: number;
};

export type FixPlan = {
  code: string;
  applied: AppliedChange[];
  skipped: { finding_ref: string; reason: string }[];
  /** Import statements the applied fixes needed that the file lacked. */
  addedImports: string[];
};

const IMPORT_LINE = /^\s*(?:import\s|from\s+\S+\s+import\s)/;

// Insert after the last top-level import; otherwise after a shebang / Java package line; otherwise at the top.
function addImports(lines: string[], imports: string[]): string[] {
  const present = new Set(lines.map((l) => l.trim()));
  const missing = [...new Set(imports.map((i) => i.trim()))].filter((i) => i && !present.has(i));
  if (!missing.length) return [];
  let at = -1;
  lines.forEach((l, i) => {
    if (IMPORT_LINE.test(l) && !/^\s/.test(l)) at = i;
  });
  if (at === -1) at = lines.findIndex((l) => l.trim() !== "" && !l.startsWith("#!") && !/^\s*package\s/.test(l)) - 1;
  lines.splice(Math.max(0, at + 1), 0, ...missing);
  return missing;
}

/** A finding can be auto-applied only if it carries replacement code and isn't manual-only (PRD 12.4). */
export const isApplicable = (f: Finding) => f.fix_code !== null && f.fix_safety !== "manual_only" && f.status !== "false_positive";

/** "Fix All Safe Issues" default selection: every applicable safe fix. Needs-review fixes require opt-in. */
export const defaultSelection = (findings: Finding[]) =>
  new Set(findings.filter((f) => isApplicable(f) && f.fix_safety === "safe").map((f) => f.id));

/**
 * Builds a new version of the file from the selected findings' replacement code. Pure: the original string
 * is never modified (FR-051). Overlapping fixes can't both apply; the more severe one wins.
 * Used in the browser for the live diff preview and on the server for the saved, validated version.
 */
export function applyFixes(original: string, findings: Finding[], selected: ReadonlySet<string>): FixPlan {
  const skipped: FixPlan["skipped"] = [];
  const candidates = findings
    .filter((f) => selected.has(f.id))
    .filter((f) => {
      if (isApplicable(f)) return true;
      skipped.push({ finding_ref: f.id, reason: f.fix_safety === "manual_only" ? "Manual-only fixes can't be auto-applied." : "No replacement code was suggested." });
      return false;
    })
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.location.start_line - b.location.start_line);

  const accepted: Finding[] = [];
  for (const f of candidates) {
    const clash = accepted.find((a) => f.location.start_line <= a.location.end_line && f.location.end_line >= a.location.start_line);
    if (clash) skipped.push({ finding_ref: f.id, reason: `Overlaps ${clash.id}, which is applied instead.` });
    else accepted.push(f);
  }

  const lines = original.split("\n");
  // Bottom-up so earlier line numbers stay valid while splicing.
  for (const f of [...accepted].sort((a, b) => b.location.start_line - a.location.start_line)) {
    const replacement = f.fix_code!.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    lines.splice(f.location.start_line - 1, f.location.end_line - f.location.start_line + 1, ...replacement);
  }
  // After the splices, so inserting at the top can't shift the ranges above.
  const addedImports = addImports(lines, accepted.flatMap((f) => f.fix_imports));

  return {
    code: lines.join("\n"),
    addedImports,
    applied: accepted
      .sort((a, b) => a.location.start_line - b.location.start_line)
      .map((f) => ({ finding_ref: f.id, title: f.title, safety: f.fix_safety, start_line: f.location.start_line, end_line: f.location.end_line })),
    skipped,
  };
}
