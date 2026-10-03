import type { Finding, FindingCategory, ScoreKey, ScoreReport, Severity } from "./schemas.ts";

// PRD 13. Initial values; tune against the benchmark set.
export const SEVERITY_PENALTY: Record<Severity, number> = { critical: 30, high: 15, medium: 7, low: 3, info: 0 };
export const WEIGHTS: Record<ScoreKey, number> = { quality: 0.3, security: 0.3, performance: 0.2, maintainability: 0.2 };
export const SECURITY_CRITICAL_CAP = 60;

// Bugs are correctness defects, which the PRD's Code Quality score is the natural home for.
export const SCORE_FOR: Record<FindingCategory, ScoreKey> = {
  bug: "quality",
  quality: "quality",
  security: "security",
  performance: "performance",
  maintainability: "maintainability",
};

const round1 = (n: number) => Math.round(n * 10) / 10;

type Scorable = Pick<Finding, "id" | "category" | "severity" | "confidence" | "status">;

// sub_score = max(0, 100 - sum(penalty[severity] * confidence)); overall = weighted sum.
// Findings marked false_positive or fixed don't count; every deduction is listed so scores are explainable.
export function computeScores(findings: Scorable[]): ScoreReport {
  const sub: Record<ScoreKey, number> = { quality: 100, security: 100, performance: 100, maintainability: 100 };
  const deductions: ScoreReport["deductions"] = [];
  let criticalSecurity = false;

  for (const f of findings) {
    if (f.status === "false_positive" || f.status === "fixed") continue;
    const score = SCORE_FOR[f.category];
    const points = round1(SEVERITY_PENALTY[f.severity] * f.confidence);
    if (f.category === "security" && f.severity === "critical") criticalSecurity = true;
    if (points === 0) continue;
    sub[score] -= points;
    deductions.push({ finding_ref: f.id, score, points });
  }

  for (const k of Object.keys(sub) as ScoreKey[]) sub[k] = Math.max(0, Math.round(sub[k]));
  const securityCapped = criticalSecurity && sub.security > SECURITY_CRITICAL_CAP;
  if (securityCapped) sub.security = SECURITY_CRITICAL_CAP;

  const overall = Math.round((Object.keys(WEIGHTS) as ScoreKey[]).reduce((acc, k) => acc + WEIGHTS[k] * sub[k], 0));
  return { ...sub, overall, deductions, security_capped: securityCapped };
}
