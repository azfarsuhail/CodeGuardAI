import type { FindingCategory, Language, Severity } from "../schemas.ts";

/** One completed review as the dashboard needs it (DB-free, so this module stays unit-testable). */
export interface DashboardReview {
  id: string;
  fileName: string;
  language: Language;
  createdAt: Date;
  overall: number | null;
  findings: { ref: string; category: FindingCategory; severity: Severity; status: string }[];
  /** `appliedRefs` of this review's FixVersions with `validated = true`. */
  validatedRefs: string[];
}

export interface TrendPoint {
  /** UTC day, YYYY-MM-DD */
  date: string;
  /** Mean overall score of that day's reviews; null = no reviews (a gap, not a zero). */
  avg: number | null;
  count: number;
}

export interface DashboardStats {
  reviewsCompleted: number;
  bugsFixed: number;
  security: { found: number; resolved: number };
  avgScore: { current: number | null; previous: number | null; delta: number | null };
  trend: TrendPoint[];
  languages: { language: Language; count: number; avg: number | null }[];
  open: { total: number; byCategory: Partial<Record<FindingCategory, number>>; bySeverity: Partial<Record<Severity, number>> };
  recent: Pick<DashboardReview, "id" | "fileName" | "language" | "createdAt" | "overall">[];
}

export const TREND_DAYS = 30;
const DAY = 86_400_000;

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * FR-071 aggregation. Shared "fixed" rule: a finding is resolved when its ref is in the appliedRefs of a
 * validated FixVersion of the same review. False positives never count (found, fixed or open).
 */
export function summarize(reviews: DashboardReview[], now = new Date()): DashboardStats {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const windowStart = today - (TREND_DAYS - 1) * DAY; // 30 UTC days ending today, inclusive
  const prevStart = windowStart - TREND_DAYS * DAY;

  const byDay = new Map<string, number[]>();
  const current: number[] = [];
  const previous: number[] = [];
  const langs = new Map<Language, { count: number; scores: number[] }>();
  const byCategory: DashboardStats["open"]["byCategory"] = {};
  const bySeverity: DashboardStats["open"]["bySeverity"] = {};
  let bugsFixed = 0;
  let secFound = 0;
  let secResolved = 0;
  let openTotal = 0;

  for (const r of reviews) {
    const t = r.createdAt.getTime();
    const lang = langs.get(r.language) ?? { count: 0, scores: [] };
    lang.count++;
    langs.set(r.language, lang);

    if (r.overall !== null) {
      lang.scores.push(r.overall);
      if (t >= windowStart && t < today + DAY) {
        current.push(r.overall);
        const key = utcDay(r.createdAt);
        byDay.set(key, [...(byDay.get(key) ?? []), r.overall]);
      } else if (t >= prevStart && t < windowStart) previous.push(r.overall);
    }

    const fixed = new Set(r.validatedRefs);
    for (const f of r.findings) {
      if (f.status === "false_positive") continue;
      const resolved = fixed.has(f.ref);
      if (resolved && f.category === "bug") bugsFixed++;
      if (f.category === "security") {
        secFound++;
        if (resolved) secResolved++;
      }
      if (!resolved && f.status === "open") {
        openTotal++;
        byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
        bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      }
    }
  }

  const cur = mean(current);
  const prev = mean(previous);
  return {
    reviewsCompleted: reviews.length,
    bugsFixed,
    security: { found: secFound, resolved: secResolved },
    avgScore: { current: cur, previous: prev, delta: cur !== null && prev !== null ? round1(cur - prev) : null },
    trend: Array.from({ length: TREND_DAYS }, (_, i) => {
      const date = utcDay(new Date(windowStart + i * DAY));
      const scores = byDay.get(date) ?? [];
      return { date, avg: mean(scores), count: scores.length };
    }),
    languages: [...langs]
      .map(([language, l]) => ({ language, count: l.count, avg: mean(l.scores) }))
      .sort((a, b) => b.count - a.count || a.language.localeCompare(b.language)),
    open: { total: openTotal, byCategory, bySeverity },
    recent: [...reviews]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 5)
      .map(({ id, fileName, language, createdAt, overall }) => ({ id, fileName, language, createdAt, overall })),
  };
}
