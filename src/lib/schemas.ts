import { z } from "zod";

// PRD Section 9 limits.
export const LIMITS = { maxLines: 1000, maxBytes: 100_000, maxStaticFindings: 200, maxAiFindings: 50 } as const;

export const Language = z.enum(["python", "javascript", "typescript", "java"]);
export const ReviewMode = z.enum(["developer", "student"]);
export const FocusArea = z.enum(["bugs", "security", "performance"]);
export const FindingCategory = z.enum(["bug", "security", "performance", "quality", "maintainability"]);
export const Severity = z.enum(["critical", "high", "medium", "low", "info"]);
export const FindingSource = z.enum(["static", "ai", "both"]);
export const FindingStatus = z.enum(["open", "fixed", "ignored", "false_positive"]);
export const FixSafety = z
  .enum(["safe", "needs_review", "manual_only"])
  .describe(
    "safe = behaviour-preserving (rename, remove dead code, add null check, extract duplicate code, parameterise SQL); " +
      "needs_review = algorithm replacement, return-type/public-API/concurrency change; " +
      "manual_only = architectural or business-logic ambiguity",
  );
export const ScoreKey = z.enum(["quality", "security", "performance", "maintainability"]);

const line = z.int().min(1).max(LIMITS.maxLines);

// ---------------------------------------------------------------------------
// Static analysis output. Computed server-side so "Verified" can't be forged.
// ---------------------------------------------------------------------------

export const StaticFinding = z.object({
  id: z.string().regex(/^S-\d{1,4}$/),
  tool: z.string().max(40),
  rule: z.string().max(120),
  message: z.string().max(500),
  category: FindingCategory,
  severity: Severity,
  start_line: line,
  end_line: line,
  cwe: z.string().nullable(),
  fix_safety: FixSafety,
  fix_hint: z.string().nullable(),
});

export const StaticFunctionMetric = z.object({
  name: z.string().max(200),
  start_line: line,
  end_line: line,
  cyclomatic: z.int().min(1).max(1000),
  nesting_depth: z.int().min(0).max(100),
});

export const StaticMetrics = z.object({
  loc: z.int().min(0).max(LIMITS.maxLines),
  function_count: z.int().min(0).max(LIMITS.maxLines),
  cyclomatic: z.int().min(0).max(1000),
  nesting_depth: z.int().min(0).max(100),
  duplication_pct: z.number().min(0).max(100),
  functions: z.array(StaticFunctionMetric).max(LIMITS.maxLines),
});

// POST /api/reviews body (PRD 15).
export const CreateReviewRequest = z.object({
  code: z
    .string()
    .min(1, "Code is empty.")
    .refine((c) => new TextEncoder().encode(c).length <= LIMITS.maxBytes, `Code exceeds ${LIMITS.maxBytes / 1000} KB.`)
    .refine((c) => c.split("\n").length <= LIMITS.maxLines, `Code exceeds ${LIMITS.maxLines} lines.`),
  language: Language,
  mode: ReviewMode,
  focus: z.array(FocusArea).min(1, "Pick at least one focus area.").max(3).default(["bugs", "security", "performance"]),
  source_type: z.enum(["paste", "upload"]).default("paste"),
  file_name: z.string().trim().min(1).max(120).default("main"),
  assignment_context: z.string().max(2000, "Assignment description is over 2,000 characters.").optional(),
  intended_behaviour: z.string().max(2000, "Intended behaviour is over 2,000 characters.").optional(),
});

// ---------------------------------------------------------------------------
// LLM structured output: review pass.
// ---------------------------------------------------------------------------

export const AiFinding = z.object({
  id: z.string().max(20).describe('Sequential id, e.g. "F-0001"'), // renumbered server-side
  static_ref: z
    .string()
    .nullable()
    .describe("id of the static analyzer finding this explains (e.g. \"S-3\"), or null if you found it yourself"),
  category: FindingCategory,
  severity: Severity,
  title: z.string().max(160),
  location: z.object({ start_line: line, end_line: line }),
  evidence: z.string().max(500).describe("The source text of start_line, copied verbatim without the line-number prefix"),
  problem: z.string().max(400).describe("One sentence: what is wrong"),
  why: z.string().max(600).describe("Why it is a problem"),
  fix: z.string().max(600).describe("What to change"),
  fix_code: z.string().max(4000).nullable().describe("Replacement code for start_line..end_line, or null"),
  fix_imports: z
    .array(z.string().max(200))
    .max(5)
    .describe('Import statements fix_code needs that the file does not have yet, e.g. "import os". Empty array if none'),
  fix_safety: FixSafety,
  confidence: z.number().min(0).max(1),
  cwe: z.string().max(80).nullable().describe('e.g. "CWE-89", or null'), // normalised server-side
  owasp: z.string().max(80).nullable().describe('OWASP Top 10 category, e.g. "A03:2021 Injection", or null'),
  student_explanation: z
    .string()
    .max(600)
    .nullable()
    .describe("Student mode only: plain-language explanation, max ~80 words. null in developer mode"),
});

export const FunctionComplexity = z.object({
  name: z.string().max(200),
  start_line: line,
  end_line: line,
  time_complexity: z.string().max(40).describe('Big-O, e.g. "O(n^2)"'),
  space_complexity: z.string().max(40),
  explanation: z.string().max(400),
  suggestion: z.string().max(400).nullable(),
});

export const ConceptPrimer = z.object({
  concept: z.string().max(80),
  explanation: z.string().max(600),
});

export const AiReviewOutput = z.object({
  summary: z.string().max(1000),
  findings: z.array(AiFinding).max(LIMITS.maxAiFindings),
  complexity: z.object({
    time_complexity: z.string().max(40).describe("Worst function's time complexity"),
    space_complexity: z.string().max(40),
    functions: z.array(FunctionComplexity).max(100),
  }),
  concept_primers: z.array(ConceptPrimer).max(5).describe("Student mode only; empty array in developer mode"),
});

// Student Mode is a Must (FR-061): output missing primers or explanations is rejected, which triggers the
// LLM client's corrective retry. The JSON Schema sent to providers stays the same for both modes.
export const StudentReviewOutput = AiReviewOutput.superRefine((o, ctx) => {
  if (o.concept_primers.length === 0)
    ctx.addIssue({ code: "custom", path: ["concept_primers"], message: "Student mode needs 1 to 5 concept primers." });
  o.findings.forEach((f, i) => {
    if (!f.student_explanation?.trim())
      ctx.addIssue({ code: "custom", path: ["findings", i, "student_explanation"], message: "Student mode needs a student_explanation for every finding." });
  });
});

// ---------------------------------------------------------------------------
// LLM structured output: fix / improve pass (PRD 8.6).
// ---------------------------------------------------------------------------

export const ImproveKind = z.enum([
  "extract_function",
  "rename",
  "remove_redundancy",
  "error_handling",
  "simplify",
  "performance",
  "security",
  "documentation",
  "other",
]);

export const ImproveChange = z.object({
  kind: ImproveKind,
  description: z.string().max(400).describe("What changed and why, one or two sentences"),
  finding_refs: z.array(z.string().max(20)).describe("Review finding ids this change addresses; empty for pure improvements"),
  safety: FixSafety,
  start_line: line.describe("First affected line in the ORIGINAL code"),
  end_line: line.describe("Last affected line in the ORIGINAL code"),
});

// FR-050 "Improve Code": a complete rewrite plus a structured change list.
export const AiImproveOutput = z.object({
  summary: z.string().max(600).describe("One or two sentences on what the rewrite improves"),
  code: z.string().min(1).max(LIMITS.maxBytes * 2).describe("The complete improved file"),
  changes: z.array(ImproveChange).min(1).max(60),
});

// ---------------------------------------------------------------------------
// Persisted / API response shapes.
// ---------------------------------------------------------------------------

// PRD 12.3 finding schema, after merge with static evidence.
export const Finding = z.object({
  id: z.string(),
  category: FindingCategory,
  severity: Severity,
  title: z.string(),
  location: z.object({ file: z.string(), start_line: z.int(), end_line: z.int() }),
  problem: z.string(),
  why: z.string(),
  fix: z.string(),
  fix_code: z.string().nullable(),
  fix_imports: z.array(z.string()),
  fix_safety: FixSafety,
  source: FindingSource,
  confidence: z.number().min(0).max(1),
  cwe: z.string().nullable(),
  owasp: z.string().nullable(),
  student_explanation: z.string().nullable(),
  status: FindingStatus,
});

// PRD 13: explainable scores.
export const ScoreReport = z.object({
  quality: z.number().min(0).max(100),
  security: z.number().min(0).max(100),
  performance: z.number().min(0).max(100),
  maintainability: z.number().min(0).max(100),
  overall: z.number().min(0).max(100),
  deductions: z.array(z.object({ finding_ref: z.string(), score: ScoreKey, points: z.number() })),
  security_capped: z.boolean().describe("A critical security finding capped Security at 60"),
});

export const FunctionMetric = StaticFunctionMetric.extend({
  time_complexity: z.string().nullable(),
  space_complexity: z.string().nullable(),
  explanation: z.string().nullable(),
  suggestion: z.string().nullable(),
});

export const ReviewMetrics = StaticMetrics.extend({
  time_complexity: z.string().nullable(),
  space_complexity: z.string().nullable(),
  functions: z.array(FunctionMetric),
});

export const ReviewStatus = z.enum(["queued", "analyzing", "completed", "failed"]);

export const AppliedChange = z.object({
  finding_ref: z.string(),
  title: z.string(),
  safety: FixSafety,
  start_line: z.int(),
  end_line: z.int(),
});

// A saved, re-validated fixed copy of the file (FR-051, FR-053). The original is never modified.
export const FixVersionDetail = z.object({
  id: z.string(),
  type: z.enum(["improve", "fix_safe"]),
  code: z.string(),
  changes: z.array(AppliedChange).describe("fix_safe versions: the findings applied"),
  improvements: z.array(ImproveChange).describe("improve versions: the rewrite's change list"),
  summary: z.string().nullable(),
  validated: z.boolean().describe("Parses and introduces no new static-analysis issues"),
  validation_errors: z.array(z.string()),
  created_at: z.string(),
});

// POST /api/reviews/{id}/fix. Omit finding_ids for "Fix All Safe Issues"; needs-review fixes must be listed explicitly.
export const CreateFixRequest = z.object({
  finding_ids: z.array(z.string().max(20)).min(1).max(100).optional(),
});

// PATCH /api/reviews/{id}/findings/{ref}
export const UpdateFindingRequest = z.object({
  status: z.enum(["open", "ignored", "false_positive"]),
  feedback: z.string().trim().max(1000).optional(),
});

// GET /api/reviews/{id} response.
export const ReviewDetail = z.object({
  id: z.string(),
  status: ReviewStatus,
  language: Language,
  mode: ReviewMode,
  file_name: z.string(),
  source_type: z.enum(["paste", "upload", "github"]),
  original_code: z.string().describe("Secrets are masked"),
  focus: z.array(FocusArea),
  summary: z.string().nullable(),
  scores: ScoreReport.nullable(),
  metrics: ReviewMetrics.nullable(),
  findings: z.array(Finding),
  concept_primers: z.array(ConceptPrimer),
  fix_versions: z.array(FixVersionDetail).describe("Newest first"),
  static_only: z.boolean(),
  notice: z.string().nullable(),
  model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  duration_ms: z.int().nullable(),
  created_at: z.string(),
});

export type Language = z.infer<typeof Language>;
export type ReviewMode = z.infer<typeof ReviewMode>;
export type FocusArea = z.infer<typeof FocusArea>;
export type FindingCategory = z.infer<typeof FindingCategory>;
export type Severity = z.infer<typeof Severity>;
export type FindingSource = z.infer<typeof FindingSource>;
export type FindingStatus = z.infer<typeof FindingStatus>;
export type FixSafety = z.infer<typeof FixSafety>;
export type ScoreKey = z.infer<typeof ScoreKey>;
export type StaticFinding = z.infer<typeof StaticFinding>;
export type StaticFunctionMetric = z.infer<typeof StaticFunctionMetric>;
export type StaticMetrics = z.infer<typeof StaticMetrics>;
export type CreateReviewRequest = z.infer<typeof CreateReviewRequest>;
export type AiFinding = z.infer<typeof AiFinding>;
export type FunctionComplexity = z.infer<typeof FunctionComplexity>;
export type ConceptPrimer = z.infer<typeof ConceptPrimer>;
export type AiReviewOutput = z.infer<typeof AiReviewOutput>;
export type ImproveKind = z.infer<typeof ImproveKind>;
export type ImproveChange = z.infer<typeof ImproveChange>;
export type AiImproveOutput = z.infer<typeof AiImproveOutput>;
export type Finding = z.infer<typeof Finding>;
export type ScoreReport = z.infer<typeof ScoreReport>;
export type FunctionMetric = z.infer<typeof FunctionMetric>;
export type ReviewMetrics = z.infer<typeof ReviewMetrics>;
export type ReviewStatus = z.infer<typeof ReviewStatus>;
export type ReviewDetail = z.infer<typeof ReviewDetail>;
export type FixVersionDetail = z.infer<typeof FixVersionDetail>;
export type CreateFixRequest = z.infer<typeof CreateFixRequest>;
export type UpdateFindingRequest = z.infer<typeof UpdateFindingRequest>;

// JSON Schemas handed to Gemini (responseJsonSchema) / Groq (response_format.json_schema).
export const aiReviewJsonSchema = z.toJSONSchema(AiReviewOutput);
export const aiImproveJsonSchema = z.toJSONSchema(AiImproveOutput);
