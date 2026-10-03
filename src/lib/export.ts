import type { ReviewDetail, Severity } from "./schemas.ts";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const LABEL: Record<string, string> = {
  bug: "Bug",
  security: "Security",
  performance: "Performance",
  quality: "Quality",
  maintainability: "Maintainability",
  safe: "Safe fix",
  needs_review: "Needs review",
  manual_only: "Manual only",
};
const FENCE_LANG: Record<string, string> = { python: "python", javascript: "javascript", typescript: "typescript", java: "java" };

// A fence longer than any backtick run in the content, so user code can't close it early.
function fence(code: string, lang = "") {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${code.replace(/\n$/, "")}\n${ticks}`;
}

// Escape characters that would turn plain text into Markdown structure inside tables and headings.
const inline = (s: string) => s.replace(/\r?\n/g, " ").replace(/([\\|*_[\]<>#])/g, "\\$1");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** FR-073: the review as a self-contained Markdown report. Code and fixes are already secret-masked. */
export function reviewToMarkdown(r: ReviewDetail): string {
  const lang = FENCE_LANG[r.language] ?? "";
  const open = r.findings.filter((f) => f.status !== "false_positive" && f.status !== "fixed");
  const dismissed = r.findings.length - open.length;
  const out: string[] = [];

  out.push(`# CodeGuard AI review: ${inline(r.file_name)}`, "");
  out.push(
    `- Language: ${cap(r.language)}`,
    `- Mode: ${r.mode === "student" ? "Student" : "Developer"}`,
    `- Reviewed: ${r.created_at.replace("T", " ").slice(0, 16)} UTC`,
    `- Analysis: ${r.static_only ? "Static analysis only" : "Static analysis + AI review"}`,
    `- Findings: ${open.length} open${dismissed ? `, ${dismissed} marked as false positive` : ""}`,
    "",
  );
  if (r.notice) out.push(`> Note: ${inline(r.notice)}`, "");
  if (r.summary) out.push("## Summary", "", r.summary, "");

  if (r.scores) {
    const s = r.scores;
    out.push("## Scores", "", "| Score | Value |", "| --- | --- |");
    out.push(`| **Overall** | **${s.overall}/100** |`);
    for (const k of ["quality", "security", "performance", "maintainability"] as const) out.push(`| ${cap(k)} | ${s[k]}/100 |`);
    out.push("");
    if (s.security_capped) out.push("Security is capped at 60 because of a critical security finding.", "");
    if (s.deductions.length) {
      const title = new Map(r.findings.map((f) => [f.id, f.title]));
      out.push("Deductions (severity penalty scaled by confidence):", "");
      for (const d of s.deductions) out.push(`- -${d.points} ${cap(d.score)}: ${d.finding_ref} ${inline(title.get(d.finding_ref) ?? "")}`);
      out.push("");
    }
  }

  out.push("## Findings", "");
  if (!open.length) out.push("No open findings.", "");
  for (const sev of SEVERITY_ORDER) {
    const group = open.filter((f) => f.severity === sev);
    if (!group.length) continue;
    out.push(`### ${cap(sev)} (${group.length})`, "");
    for (const f of group) {
      const lines = f.location.start_line === f.location.end_line ? `${f.location.start_line}` : `${f.location.start_line}-${f.location.end_line}`;
      out.push(`#### ${f.id}: ${inline(f.title)}`, "");
      const meta = [
        `**${LABEL[f.category]}**`,
        `\`${f.location.file}:${lines}\``,
        f.source === "ai" ? `AI-suggested (${Math.round(f.confidence * 100)}% confidence)` : "Verified by static analysis",
        LABEL[f.fix_safety],
        f.cwe,
        f.owasp,
      ].filter(Boolean);
      out.push(meta.join(" · "), "");
      out.push(`**Problem.** ${f.problem}`, "", `**Why it matters.** ${f.why}`, "", `**Fix.** ${f.fix}`, "");
      if (f.fix_code) {
        if (f.fix_imports.length) out.push(`Requires: ${f.fix_imports.map((i) => `\`${i}\``).join(", ")}`, "");
        out.push(fence(f.fix_code, lang), "");
      }
      if (f.student_explanation) out.push(`> **In plain words:** ${inline(f.student_explanation)}`, "");
    }
  }

  if (r.concept_primers.length) {
    out.push("## Concepts behind these findings", "");
    for (const p of r.concept_primers) out.push(`**${inline(p.concept)}.** ${p.explanation}`, "");
  }

  if (r.metrics) {
    const m = r.metrics;
    out.push("## Complexity", "");
    out.push(
      `Lines of code: ${m.loc}. Functions: ${m.function_count}. Max cyclomatic complexity: ${m.cyclomatic}. Max nesting depth: ${m.nesting_depth}. Duplication: ${m.duplication_pct}%.`,
      "",
    );
    if (m.functions.length) {
      out.push("| Function | Lines | Cyclomatic | Nesting | Time | Space |", "| --- | --- | --- | --- | --- | --- |");
      for (const f of m.functions)
        out.push(`| \`${inline(f.name)}\` | ${f.start_line}-${f.end_line} | ${f.cyclomatic} | ${f.nesting_depth} | ${f.time_complexity ?? "-"} | ${f.space_complexity ?? "-"} |`);
      out.push("");
    }
  }

  out.push("## Submitted code", "", "Hard-coded secrets are masked.", "", fence(r.original_code, lang), "");
  out.push("---", "", `Generated by CodeGuard AI${r.model ? ` (${r.model}, prompt ${r.prompt_version})` : ""}.`, "");
  return out.join("\n");
}
