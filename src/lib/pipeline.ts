import { runStaticAnalysis, type StaticAnalysis } from "./analysis/index.ts";
import { generateStructured } from "./ai/llm.ts";
import { mergeFindings, mergeMetrics } from "./ai/merge.ts";
import { PROMPT_VERSION, REVIEW_SYSTEM_PROMPT, buildReviewPrompt } from "./ai/prompt.ts";
import { LANGUAGES } from "./languages.ts";
import { computeScores } from "./scoring.ts";
import {
  AiReviewOutput,
  StudentReviewOutput,
  aiReviewJsonSchema,
  type ConceptPrimer,
  type CreateReviewRequest,
  type Finding,
  type ReviewMetrics,
  type ScoreReport,
} from "./schemas.ts";

// Leaves headroom inside the route's maxDuration for the merge and the database write.
export const AI_DEADLINE_MS = 60_000;

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
  const findings = mergeFindings({ code: analysis.code, fileName: req.file_name, mode: req.mode, staticFindings: analysis.findings, ai });
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
