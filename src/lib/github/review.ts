import { Severity, type Finding, type ScoreReport } from "../schemas.ts";

// DB-free PR review logic (FR-082/083): diff mapping, comment formatting, check-run output.

export const MAX_INLINE_COMMENTS = 30;

export type PatchLines = { added: Set<number>; visible: Set<number> };

/** RIGHT-side line numbers from a unified-diff patch: `added` lines, and every line the diff shows (`visible`). */
export function parsePatch(patch: string | undefined): PatchLines {
  const added = new Set<number>();
  const visible = new Set<number>();
  let line = 0;
  let inHunk = false;
  for (const text of (patch ?? "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
    } else if (!inHunk || text.startsWith("-") || text.startsWith("\\")) {
      continue; // preamble, deleted lines and "\ No newline at end of file" don't exist on the RIGHT side
    } else {
      if (text.startsWith("+")) added.add(line);
      visible.add(line++);
    }
  }
  return { added, visible };
}

const range = (f: Finding) => {
  const out: number[] = [];
  for (let n = f.location.start_line; n <= f.location.end_line; n++) out.push(n);
  return out;
};

export const isIntroduced = (f: Finding, added: Set<number>) => range(f).some((n) => added.has(n));

export const bySeverity = (a: Finding, b: Finding) =>
  Severity.options.indexOf(a.severity) - Severity.options.indexOf(b.severity) || a.location.start_line - b.location.start_line;

export function splitFindings(findings: Finding[], added: Set<number>) {
  const introduced = findings.filter((f) => isIntroduced(f, added)).sort(bySeverity);
  return { introduced, preexisting: findings.length - introduced.length };
}

const label = (s: string) => s[0].toUpperCase() + s.slice(1);

export type InlineComment = { path: string; line: number; start_line?: number; side: "RIGHT"; start_side?: "RIGHT"; body: string };

/** One inline comment, anchored only to lines GitHub shows in the diff (otherwise the whole review is rejected). */
export function formatComment(path: string, f: Finding, lines: PatchLines): InlineComment {
  const all = range(f);
  const suggest = f.fix_safety === "safe" && f.fix_code !== null && all.every((n) => lines.added.has(n));
  const changed = all.filter((n) => lines.added.has(n));
  let start = suggest ? f.location.start_line : Math.min(...changed);
  const end = suggest ? f.location.end_line : Math.max(...changed);
  if (!all.slice(all.indexOf(start), all.indexOf(end) + 1).every((n) => lines.visible.has(n))) start = end;

  const body = [
    `**${label(f.severity)} · ${label(f.category)}: ${f.title}**`,
    f.source === "ai" ? `_AI-only finding, confidence ${Math.round(f.confidence * 100)}%_` : null,
    f.problem,
    `**Why it matters:** ${f.why}`,
    `**Fix:** ${f.fix}`,
    suggest ? "```suggestion\n" + f.fix_code!.replace(/\r\n/g, "\n").replace(/\n$/, "") + "\n```" : null,
  ]
    .filter((p) => p !== null)
    .join("\n\n");

  return start < end ? { path, start_line: start, start_side: "RIGHT", line: end, side: "RIGHT", body } : { path, line: end, side: "RIGHT", body };
}

export type CheckConclusion = "failure" | "neutral" | "success";

export function checkConclusion(introduced: Finding[]): CheckConclusion {
  if (introduced.some((f) => f.severity === "critical" || f.severity === "high")) return "failure";
  return introduced.some((f) => f.severity === "medium") ? "neutral" : "success";
}

export type FileOutcome = { path: string; introduced: Finding[]; preexisting: number; scores: ScoreReport | null; note?: string };

/** Markdown used for both the review body and the check-run summary. */
export function buildSummary(files: FileOutcome[], notes: string[]): { title: string; summary: string } {
  const introduced = files.flatMap((f) => f.introduced);
  const preexisting = files.reduce((n, f) => n + f.preexisting, 0);
  const counts = Severity.options.map((s) => [s, introduced.filter((f) => f.severity === s).length] as const);
  const worst = counts.find(([, n]) => n > 0);
  const title = introduced.length
    ? `${introduced.length} new issue${introduced.length === 1 ? "" : "s"} (worst: ${worst![0]})`
    : "No new issues found";

  const out = [`### CodeGuard AI review`, title + (preexisting ? `; ${preexisting} pre-existing issue${preexisting === 1 ? "" : "s"} in touched files (not commented).` : ".")];
  if (introduced.length) {
    out.push("| Severity | New issues |\n|---|---|\n" + counts.filter(([, n]) => n > 0).map(([s, n]) => `| ${label(s)} | ${n} |`).join("\n"));
  }
  if (files.length) {
    out.push(
      "| File | Overall | Security | Quality | New | Pre-existing |\n|---|---|---|---|---|---|\n" +
        files
          .map((f) =>
            f.scores
              ? `| \`${f.path}\` | ${f.scores.overall} | ${f.scores.security} | ${f.scores.quality} | ${f.introduced.length} | ${f.preexisting} |`
              : `| \`${f.path}\` | – | – | – | – | ${f.note ?? "not reviewed"} |`,
          )
          .join("\n"),
    );
  }
  if (introduced.length > MAX_INLINE_COMMENTS) out.push(`Only the ${MAX_INLINE_COMMENTS} most severe new issues are commented inline.`);
  out.push(...notes);
  return { title, summary: out.join("\n\n") };
}
