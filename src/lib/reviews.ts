import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { StaticAnalysis } from "@/lib/analysis";
import { applyFixes, defaultSelection, isApplicable } from "@/lib/fixes";
import { STATIC_ONLY_NOTICE, aiReview, staticReview, validateFixedCode } from "@/lib/pipeline";
import {
  AppliedChange,
  ConceptPrimer,
  ReviewMetrics,
  ScoreReport,
  type CreateReviewRequest,
  type Finding,
  type FixVersionDetail,
  type ReviewDetail,
  type UpdateFindingRequest,
} from "@/lib/schemas";
import { computeScores } from "@/lib/scoring";

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
  fixImports: f.fix_imports,
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
      findings: { createMany: { data: s.findings.map(findingRow) } }, // one INSERT, not one per finding
      metrics: { create: metricsRow(s.metrics) },
    },
    select: { id: true },
  });
  return { id: review.id, analysis: s.analysis };
}

const SAVE_FAILED_NOTICE = "The AI review finished but couldn't be saved, so this report shows static-analysis results only.";

/** Background stage: AI review, merge and rescore, then replace the static-only report. */
export async function completeReview(id: string, req: CreateReviewRequest, analysis: StaticAnalysis, startedAt: number) {
  const r = await aiReview(req, analysis); // never throws; degrades to static-only itself
  const save = () =>
    prisma.$transaction([
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
  try {
    await save().catch((e) => {
      console.warn(`[review ${id}] save failed, retrying once`, e instanceof Error ? e.message : e);
      return save();
    });
  } catch (e) {
    // The stored static-only report is still valid; surface it rather than leaving the review stuck.
    console.error(`[review ${id}] completion failed`, e);
    await prisma.review
      .update({
        where: { id },
        data: { status: "completed", staticOnly: true, notice: r.model ? SAVE_FAILED_NOTICE : STATIC_ONLY_NOTICE, durationMs: Date.now() - startedAt },
      })
      .catch((err) => console.error(`[review ${id}] could not mark completed`, err));
  }
}

type FixVersionRow = { id: string; type: "improve" | "fix_safe"; code: string; changeList: unknown; validated: boolean; validationErrors: string[]; createdAt: Date };

const toFixVersionDetail = (v: FixVersionRow): FixVersionDetail => ({
  id: v.id,
  type: v.type,
  code: v.code,
  changes: AppliedChange.array().safeParse(v.changeList).data ?? [],
  validated: v.validated,
  validation_errors: v.validationErrors,
  created_at: v.createdAt.toISOString(),
});

export class ReviewActionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * "Fix All Safe Issues" (FR-051..054): builds a new version from the findings' replacement code, re-validates
 * it with static analysis and stores it. Without findingIds it applies every safe fix; needs-review fixes are
 * only applied when listed explicitly; manual-only fixes never are. The original code is never modified.
 */
export async function createFixVersion(reviewId: string, findingIds?: string[]): Promise<FixVersionDetail> {
  const review = await getReviewDetail(reviewId);
  if (!review) throw new ReviewActionError(404, "not_found", "No review exists with that id.");
  if (review.status !== "completed") throw new ReviewActionError(409, "not_ready", "Fixes are available once the review has finished.");

  let selected: Set<string>;
  if (findingIds) {
    const byId = new Map(review.findings.map((f) => [f.id, f]));
    for (const ref of findingIds) {
      const f = byId.get(ref);
      if (!f) throw new ReviewActionError(400, "unknown_finding", `Finding ${ref} isn't part of this review.`);
      if (!isApplicable(f)) throw new ReviewActionError(400, "not_applicable", `Finding ${ref} has no fix that can be applied automatically.`);
    }
    selected = new Set(findingIds);
  } else {
    selected = defaultSelection(review.findings);
  }

  const plan = applyFixes(review.original_code, review.findings, selected);
  if (!plan.applied.length) throw new ReviewActionError(400, "nothing_to_apply", "None of the selected findings has a fix that can be applied.");

  const check = validateFixedCode(review.original_code, plan.code, review.language, review.file_name);
  const row = await prisma.fixVersion.create({
    data: {
      reviewId,
      type: "fix_safe",
      code: plan.code,
      changeList: json(plan.applied),
      appliedRefs: plan.applied.map((c) => c.finding_ref),
      validated: check.validated,
      validationErrors: check.errors,
    },
  });
  return toFixVersionDetail(row);
}

/** Marks a finding as a false positive / ignored (or reopens it) and rescores, since false positives don't count. */
export async function updateFindingStatus(reviewId: string, ref: string, update: UpdateFindingRequest) {
  const found = await prisma.finding.findUnique({ where: { reviewId_ref: { reviewId, ref } }, select: { id: true } });
  if (!found) throw new ReviewActionError(404, "not_found", "No finding exists with that id in this review.");
  await prisma.finding.update({
    where: { id: found.id },
    data: { status: update.status, ...(update.feedback !== undefined ? { feedback: update.feedback } : {}) },
  });
  const rows = await prisma.finding.findMany({ where: { reviewId }, select: { ref: true, category: true, severity: true, confidence: true, status: true } });
  const scores = computeScores(rows.map((r) => ({ ...r, id: r.ref })));
  await prisma.review.update({ where: { id: reviewId }, data: { scores: json(scores) } });
  return { finding_id: ref, status: update.status, scores };
}

export async function getReviewDetail(id: string): Promise<ReviewDetail | null> {
  const r = await prisma.review.findUnique({
    where: { id },
    include: { findings: true, metrics: true, fixVersions: { orderBy: { createdAt: "desc" } } },
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
      fix_imports: f.fixImports,
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
    fix_versions: r.fixVersions.map(toFixVersionDetail),
    static_only: r.staticOnly || stale,
    notice: stale ? "The AI review took too long, so this report shows static-analysis results only." : r.notice,
    model: r.model,
    prompt_version: r.promptVersion,
    duration_ms: r.durationMs,
    created_at: r.createdAt.toISOString(),
  };
}
