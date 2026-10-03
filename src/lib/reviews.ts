import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { StaticAnalysis } from "@/lib/analysis";
import { STATIC_ONLY_NOTICE, aiReview, staticReview } from "@/lib/pipeline";
import {
  ConceptPrimer,
  ReviewMetrics,
  ScoreReport,
  type CreateReviewRequest,
  type Finding,
  type ReviewDetail,
} from "@/lib/schemas";

export const DAILY_REVIEW_LIMIT = 20; // PRD 9 free tier
const DAY_MS = 24 * 60 * 60 * 1000;
// A review still "analyzing" after this long lost its background run (e.g. function timeout).
const STALE_MS = 3 * 60 * 1000;

const json = (v: unknown) => v as Prisma.InputJsonValue;

const findingRow = (f: Finding) => ({
  ref: f.id,
  category: f.category,
  severity: f.severity,
  title: f.title,
  file: f.location.file,
  startLine: f.location.start_line,
  endLine: f.location.end_line,
  problem: f.problem,
  why: f.why,
  fix: f.fix,
  fixCode: f.fix_code,
  fixSafety: f.fix_safety,
  source: f.source,
  confidence: f.confidence,
  cwe: f.cwe,
  owasp: f.owasp,
  studentExplanation: f.student_explanation,
  status: f.status,
});

const metricsRow = (m: ReviewMetrics) => ({
  loc: m.loc,
  functionCount: m.function_count,
  cyclomatic: m.cyclomatic,
  nestingDepth: m.nesting_depth,
  duplicationPct: m.duplication_pct,
  timeComplexity: m.time_complexity,
  spaceComplexity: m.space_complexity,
  functions: json(m.functions),
});

/** Seconds until this client may submit again, or null if under the daily limit. */
export async function retryAfterSeconds(clientHash: string): Promise<number | null> {
  const recent = await prisma.review.findMany({
    where: { clientHash, createdAt: { gt: new Date(Date.now() - DAY_MS) } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
    take: DAILY_REVIEW_LIMIT,
  });
  if (recent.length < DAILY_REVIEW_LIMIT) return null;
  return Math.max(1, Math.ceil((recent[0].createdAt.getTime() + DAY_MS - Date.now()) / 1000));
}

/** Runs static analysis and stores a scored, static-only report so the client has results right away. */
export async function createReview(req: CreateReviewRequest, clientHash: string | null) {
  const s = staticReview(req);
  const review = await prisma.review.create({
    data: {
      language: req.language,
      mode: req.mode,
      status: "analyzing",
      sourceType: req.source_type,
      fileName: req.file_name,
      originalCode: s.analysis.code, // secret-masked
      focus: req.focus,
      assignmentContext: req.assignment_context ?? null,
      intendedBehaviour: req.intended_behaviour ?? null,
      scores: json(s.scores),
      clientHash,
      findings: { create: s.findings.map(findingRow) },
      metrics: { create: metricsRow(s.metrics) },
    },
    select: { id: true },
  });
  return { id: review.id, analysis: s.analysis };
}

/** Background stage: AI review, merge and rescore, then replace the static-only report. */
export async function completeReview(id: string, req: CreateReviewRequest, analysis: StaticAnalysis, startedAt: number) {
  try {
    const r = await aiReview(req, analysis);
    await prisma.$transaction([
      prisma.finding.deleteMany({ where: { reviewId: id } }),
      prisma.finding.createMany({ data: r.findings.map((f) => ({ reviewId: id, ...findingRow(f) })) }),
      prisma.metrics.update({ where: { reviewId: id }, data: metricsRow(r.metrics) }),
      prisma.review.update({
        where: { id },
        data: {
          status: "completed",
          summary: r.summary,
          scores: json(r.scores),
          conceptPrimers: json(r.conceptPrimers),
          staticOnly: r.model === null,
          notice: r.notice,
          model: r.model,
          promptVersion: r.promptVersion,
          durationMs: Date.now() - startedAt,
        },
      }),
    ]);
  } catch (e) {
    // The stored static-only report is still valid; surface it rather than leaving the review stuck.
    console.error(`[review ${id}] completion failed`, e);
    await prisma.review
      .update({ where: { id }, data: { status: "completed", staticOnly: true, notice: STATIC_ONLY_NOTICE, durationMs: Date.now() - startedAt } })
      .catch((err) => console.error(`[review ${id}] could not mark completed`, err));
  }
}

export async function getReviewDetail(id: string): Promise<ReviewDetail | null> {
  const r = await prisma.review.findUnique({
    where: { id },
    include: { findings: true, metrics: true },
  });
  if (!r) return null;

  const stale = r.status === "analyzing" && Date.now() - r.createdAt.getTime() > STALE_MS;
  const sev = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
  const findings: Finding[] = r.findings
    .sort((a, b) => sev[a.severity] - sev[b.severity] || a.startLine - b.startLine || a.ref.localeCompare(b.ref))
    .map((f) => ({
      id: f.ref,
      category: f.category,
      severity: f.severity,
      title: f.title,
      location: { file: f.file, start_line: f.startLine, end_line: f.endLine },
      problem: f.problem,
      why: f.why,
      fix: f.fix,
      fix_code: f.fixCode,
      fix_safety: f.fixSafety,
      source: f.source,
      confidence: f.confidence,
      cwe: f.cwe,
      owasp: f.owasp,
      student_explanation: f.studentExplanation,
      status: f.status,
    }));

  return {
    id: r.id,
    status: stale ? "completed" : r.status,
    language: r.language,
    mode: r.mode,
    file_name: r.fileName,
    source_type: r.sourceType,
    original_code: r.originalCode,
    focus: r.focus as ReviewDetail["focus"],
    summary: r.summary,
    scores: ScoreReport.safeParse(r.scores).data ?? null,
    metrics: r.metrics
      ? (ReviewMetrics.safeParse({
          loc: r.metrics.loc,
          function_count: r.metrics.functionCount,
          cyclomatic: r.metrics.cyclomatic,
          nesting_depth: r.metrics.nestingDepth,
          duplication_pct: r.metrics.duplicationPct,
          time_complexity: r.metrics.timeComplexity,
          space_complexity: r.metrics.spaceComplexity,
          functions: r.metrics.functions,
        }).data ?? null)
      : null,
    findings,
    concept_primers: ConceptPrimer.array().safeParse(r.conceptPrimers).data ?? [],
    static_only: r.staticOnly || stale,
    notice: stale ? "The AI review took too long, so this report shows static-analysis results only." : r.notice,
    model: r.model,
    prompt_version: r.promptVersion,
    duration_ms: r.durationMs,
    created_at: r.createdAt.toISOString(),
  };
}
