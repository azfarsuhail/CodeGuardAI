import { runStaticAnalysis, type StaticAnalysis } from "./analysis/index.ts";
import { generateStructured } from "./ai/llm.ts";
import { mergeFindings, mergeMetrics } from "./ai/merge.ts";
import { IMPROVE_SYSTEM_PROMPT, PROMPT_VERSION, REVIEW_SYSTEM_PROMPT, buildImprovePrompt, buildReviewPrompt } from "./ai/prompt.ts";
import { LANGUAGES } from "./languages.ts";
import { computeScores } from "./scoring.ts";
import {
  AiImproveOutput,
  AiReviewOutput,
  StudentReviewOutput,
  aiImproveJsonSchema,
  aiReviewJsonSchema,
  type ConceptPrimer,
  type CreateReviewRequest,
  type Finding,
  type ReviewMetrics,
  type ScoreReport,
} from "./schemas.ts";

// Leaves headroom inside the route's 90 s maxDuration for the merge and the database write.
// Each provider attempt is capped at 30 s, so this always leaves room for at least two tiers.
export const AI_DEADLINE_MS = 75_000;

export const STATIC_ONLY_NOTICE = "The AI reviewer is unavailable right now, so this report shows static-analysis results only.";

export type ReviewResult = {
  findings: Finding[];
  scores: ScoreReport;
  metrics: ReviewMetrics;
};

// Lint under a canonical name so arbitrary user file names can't change parser behaviour (keeps .tsx/.jsx).
export function lintFileName(fileName: string, language: CreateReviewRequest["language"]): string {
  const exts = LANGUAGES[language].extensions;
  return `main${exts.find((e) => fileName.toLowerCase().endsWith(e)) ?? exts[0]}`;
}

/** Stage 1: deterministic analysis. Fast (<1 s), so the client gets verified findings immediately. */
export function staticReview(req: CreateReviewRequest): ReviewResult & { analysis: StaticAnalysis } {
  const analysis = runStaticAnalysis(req.code, req.language, lintFileName(req.file_name, req.language));
  const findings = mergeFindings({ code: analysis.code, fileName: req.file_name, mode: req.mode, staticFindings: analysis.findings, ai: null });
  return { analysis, findings, scores: computeScores(findings), metrics: mergeMetrics(analysis.metrics, null) };
}

/**
 * FR-050 Improve Code: an AI rewrite of the whole file plus a change list, re-validated like any fix.
 * Throws LlmUnavailableError when no privacy-compliant provider answers.
 */
export async function improveCode(review: {
  original_code: string;
  language: CreateReviewRequest["language"];
  file_name: string;
  mode: CreateReviewRequest["mode"];
  findings: Finding[];
}) {
  const { data, model } = await generateStructured({
    system: IMPROVE_SYSTEM_PROMPT,
    user: buildImprovePrompt({
      code: review.original_code,
      language: review.language,
      fileName: review.file_name,
      mode: review.mode,
      findings: review.findings
        .filter((f) => f.status !== "false_positive")
        .map((f) => ({ id: f.id, severity: f.severity, category: f.category, title: f.title, start_line: f.location.start_line, fix: f.fix })),
    }),
    schema: AiImproveOutput,
    jsonSchema: aiImproveJsonSchema,
    deadlineMs: AI_DEADLINE_MS,
  });
  const lineCount = review.original_code.split("\n").length;
  const known = new Set(review.findings.map((f) => f.id));
  const changes = data.changes.map((c) => {
    const start = Math.min(Math.max(1, c.start_line), lineCount);
    return {
      ...c,
      // PRD 12.4: algorithm replacements need review whatever the model claims; manual_only is forbidden by the
      // prompt, so if one slips through it still needs a human.
      safety: c.safety === "manual_only" || (c.kind === "performance" && c.safety === "safe") ? ("needs_review" as const) : c.safety,
      finding_refs: c.finding_refs.filter((r) => known.has(r)),
      start_line: start,
      end_line: Math.min(Math.max(start, c.end_line), lineCount),
    };
  });
  const code = data.code.replace(/\r\n/g, "\n");
  return { summary: data.summary, code, changes, model, check: validateFixedCode(review.original_code, code, review.language, review.file_name) };
}

/**
 * FR-053: re-run parse + static analysis on a fixed version and list anything it introduced.
 * Issues are matched by category and line text, so line shifts don't count as new, and neither does the same
 * issue reported by a different tool (e.g. Ruff's SQL rule goes quiet when a file stops parsing).
 */
export function validateFixedCode(original: string, fixed: string, language: CreateReviewRequest["language"], fileName: string) {
  const name = lintFileName(fileName, language);
  const key = (f: { category: string; rule: string; start_line: number }, lines: string[]) =>
    `${f.rule === "syntax-error" ? "syntax" : f.category}|${(lines[f.start_line - 1] ?? "").replace(/\s+/g, " ").trim()}`;
  const before = runStaticAnalysis(original, language, name);
  const after = runStaticAnalysis(fixed, language, name);
  const beforeLines = before.code.split("\n");
  const afterLines = after.code.split("\n");
  const remaining = new Map<string, number>();
  for (const f of before.findings) remaining.set(key(f, beforeLines), (remaining.get(key(f, beforeLines)) ?? 0) + 1);

  const introduced = after.findings.filter((f) => {
    if (f.tool === "metrics") return false; // size/complexity drift isn't a defect the fix introduced
    const k = key(f, afterLines);
    const left = remaining.get(k) ?? 0;
    if (left > 0) {
      remaining.set(k, left - 1);
      return false;
    }
    return true;
  });
  return {
    validated: introduced.length === 0,
    errors: introduced.map((f) => `Line ${f.start_line}: ${f.message} (${f.tool} ${f.rule})`),
  };
}

/** Stage 2: AI review grounded in the stage-1 evidence, then merge + scoring. Never throws for LLM failures. */
export async function aiReview(
  req: CreateReviewRequest,
  analysis: StaticAnalysis,
  deadlineMs = AI_DEADLINE_MS,
): Promise<ReviewResult & { summary: string | null; conceptPrimers: ConceptPrimer[]; model: string | null; promptVersion: string | null; notice: string | null }> {
  let ai: AiReviewOutput | null = null;
  let model: string | null = null;
  try {
    ({ data: ai, model } = await generateStructured({
      system: REVIEW_SYSTEM_PROMPT,
      user: buildReviewPrompt({
        code: analysis.code,
        language: req.language,
        fileName: req.file_name,
        mode: req.mode,
        focus: req.focus,
        assignmentContext: req.assignment_context,
        intendedBehaviour: req.intended_behaviour,
        staticFindings: analysis.findings,
        metrics: analysis.metrics,
      }),
      schema: req.mode === "student" ? StudentReviewOutput : AiReviewOutput,
      jsonSchema: aiReviewJsonSchema,
      deadlineMs,
    }));
  } catch (e) {
    // Graceful degradation (PRD 9): static findings still make a complete, scored report.
    console.error("[pipeline] AI review unavailable:", e instanceof Error ? e.message : e);
  }
  const findings = mergeFindings({
    code: analysis.code,
    fileName: req.file_name,
    mode: req.mode,
    staticFindings: analysis.findings,
    ai,
    functions: analysis.metrics.functions,
  });
  return {
    findings,
    scores: computeScores(findings),
    metrics: mergeMetrics(analysis.metrics, ai?.complexity ?? null),
    summary: ai?.summary ?? null,
    conceptPrimers: ai && req.mode === "student" ? ai.concept_primers : [],
    model,
    promptVersion: ai ? PROMPT_VERSION : null,
    notice: ai ? null : STATIC_ONLY_NOTICE,
  };
}
