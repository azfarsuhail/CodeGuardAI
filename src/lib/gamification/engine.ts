/*
 * XP rules (PRD FR-072, Section 17). Single source of truth; pure and DB-free.
 *
 *   review_completed  +10  per completed review                       sourceId = reviewId
 *   bug_fixed         +15  per resolved finding with category "bug"     sourceId = "<reviewId>:<ref>"
 *   security_resolved +25  per resolved finding with category "security" sourceId = "<reviewId>:<ref>"
 *   quiz_correct      +5   per correct answer on a FIRST quiz attempt   sourceId = "<attemptId>:<questionIndex>"
 *   streak_bonus      min(5 x streak, 20) per UTC day with >= 1 completed review, where streak = consecutive
 *                     UTC days with reviews ending that day          sourceId = "YYYY-MM-DD"
 *
 * Resolved: the finding's ref is in appliedRefs of a validated FixVersion of the same review; fix time = the
 * earliest such version. False positives never count. Only the earliest attempt per quiz counts.
 * Anti-farming (PRD 17.3): at most 10 review_completed and 10 quiz_correct awards per user per UTC day; extras
 * earn nothing and are not emitted. Awards are deterministic (time, then id) and keyed by (kind, sourceId), so
 * re-running the engine on the same facts and inserting with skipDuplicates is idempotent.
 *
 * Levels: level n starts at 50·n·(n−1) XP (L1 = 0, L2 = 100, L3 = 300, L4 = 600, ...).
 */

export type XpKind = "review_completed" | "bug_fixed" | "security_resolved" | "quiz_correct" | "streak_bonus";
export type BadgeCode =
  | "first_bug_fixed"
  | "security_beginner"
  | "performance_optimizer"
  | "bug_hunter"
  | "streak_keeper"
  | "quiz_master";

export const POINTS = { review_completed: 10, bug_fixed: 15, security_resolved: 25, quiz_correct: 5 } as const;
export const DAILY_CAP = 10;
const STREAK_STEP = 5;
const STREAK_MAX = 20;

export type ReviewFact = { id: string; at: Date };
export type ResolvedFinding = { reviewId: string; ref: string; category: string; at: Date };
export type QuizAttemptFact = { id: string; quizId: string; at: Date; correctness: boolean[] };
export type Facts = { reviews: ReviewFact[]; resolved: ResolvedFinding[]; quizAttempts: QuizAttemptFact[] };
export type Award = { kind: XpKind; sourceId: string; points: number; at: Date };

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
const DAY_MS = 86_400_000;
const dayIndex = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const byTimeThenId = <T>(at: (x: T) => Date, id: (x: T) => string) => (a: T, b: T) =>
  at(a).getTime() - at(b).getTime() || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);

/** Findings resolved by a validated fix version (earliest version wins). False positives never count. */
export function resolveFindings(
  findings: { reviewId: string; ref: string; category: string; status: string }[],
  fixVersions: { reviewId: string; appliedRefs: string[]; validated: boolean; createdAt: Date }[],
): ResolvedFinding[] {
  const fixedAt = new Map<string, Date>();
  for (const v of fixVersions) {
    if (!v.validated) continue;
    for (const ref of v.appliedRefs) {
      const key = `${v.reviewId}:${ref}`;
      const prev = fixedAt.get(key);
      if (!prev || v.createdAt < prev) fixedAt.set(key, v.createdAt);
    }
  }
  return findings.flatMap((f) => {
    const at = f.status === "false_positive" ? undefined : fixedAt.get(`${f.reviewId}:${f.ref}`);
    return at ? [{ reviewId: f.reviewId, ref: f.ref, category: f.category, at }] : [];
  });
}

/** Earliest attempt per quiz (ties broken by id). */
export function firstAttempts<T extends { id: string; quizId: string; at: Date }>(attempts: T[]): T[] {
  const first = new Map<string, T>();
  for (const a of [...attempts].sort(byTimeThenId((x) => x.at, (x) => x.id)))
    if (!first.has(a.quizId)) first.set(a.quizId, a);
  return [...first.values()];
}

/**
 * Per-question correctness from the stored QuizQuestion[] (src/lib/quiz: `correct_index`) and the chosen answers.
 * If the questions can't be read, falls back to the attempt's correct count so XP still matches the score.
 */
export function questionCorrectness(questions: unknown, answers: unknown, correctCount: number): boolean[] {
  const qs = Array.isArray(questions) ? questions : [];
  const as = Array.isArray(answers) ? answers : [];
  const keys = qs.map((q: unknown) => (q as { correct_index?: unknown } | null)?.correct_index);
  if (qs.length > 0 && keys.every((k) => typeof k === "number")) return keys.map((k, i) => as[i] === k);
  return Array.from({ length: Math.max(0, correctCount) }, () => true);
}

/** Sorted unique UTC days ("YYYY-MM-DD") on which at least one review was completed. */
export const reviewDays = (reviews: { at: Date }[]) => [...new Set(reviews.map((r) => utcDay(r.at)))].sort();

/** Streak length (consecutive days) ending on each day of a sorted unique day list. */
function streakLengths(days: string[]): number[] {
  return days.reduce<number[]>((acc, d, i) => {
    acc.push(i > 0 && dayIndex(d) - dayIndex(days[i - 1]) === 1 ? acc[i - 1] + 1 : 1);
    return acc;
  }, []);
}

/** Current streak (ending today or yesterday, UTC) and longest streak, in days. */
export function streaks(days: string[], now: Date): { current: number; longest: number } {
  const lengths = streakLengths(days);
  const longest = Math.max(0, ...lengths);
  if (days.length === 0) return { current: 0, longest };
  const gap = dayIndex(utcDay(now)) - dayIndex(days[days.length - 1]);
  return { current: gap === 0 || gap === 1 ? lengths[lengths.length - 1] : 0, longest };
}

/** Applies the per-UTC-day cap to awards already sorted by time. */
function capPerDay(awards: Award[]): Award[] {
  const perDay = new Map<string, number>();
  return awards.filter((a) => {
    const n = perDay.get(utcDay(a.at)) ?? 0;
    perDay.set(utcDay(a.at), n + 1);
    return n < DAILY_CAP;
  });
}

const sortAwards = (awards: Award[]) => awards.sort(byTimeThenId((a) => a.at, (a) => `${a.kind}|${a.sourceId}`));

/** The full, deterministic list of XP awards for one user's facts. */
export function computeAwards(facts: Facts): Award[] {
  const reviews = [...facts.reviews].sort(byTimeThenId((r) => r.at, (r) => r.id));
  const reviewAwards = capPerDay(
    reviews.map((r) => ({ kind: "review_completed" as const, sourceId: r.id, points: POINTS.review_completed, at: r.at })),
  );

  const fixAwards = facts.resolved.flatMap((f): Award[] => {
    const sourceId = `${f.reviewId}:${f.ref}`;
    if (f.category === "bug") return [{ kind: "bug_fixed", sourceId, points: POINTS.bug_fixed, at: f.at }];
    if (f.category === "security") return [{ kind: "security_resolved", sourceId, points: POINTS.security_resolved, at: f.at }];
    return [];
  });

  const quizAwards = capPerDay(
    sortAwards(
      firstAttempts(facts.quizAttempts).flatMap((a) =>
        a.correctness.flatMap((ok, i): Award[] =>
          ok ? [{ kind: "quiz_correct", sourceId: `${a.id}:${i}`, points: POINTS.quiz_correct, at: a.at }] : [],
        ),
      ),
    ),
  );

  const days = reviewDays(reviews);
  const firstReviewOfDay = new Map<string, Date>();
  for (const r of reviews) if (!firstReviewOfDay.has(utcDay(r.at))) firstReviewOfDay.set(utcDay(r.at), r.at);
  const lengths = streakLengths(days);
  const streakAwards = days.map(
    (day, i): Award => ({
      kind: "streak_bonus",
      sourceId: day,
      points: Math.min(STREAK_STEP * lengths[i], STREAK_MAX),
      at: firstReviewOfDay.get(day)!,
    }),
  );

  return sortAwards([...reviewAwards, ...fixAwards, ...quizAwards, ...streakAwards]);
}

export const BADGE_CODES: BadgeCode[] = [
  "first_bug_fixed",
  "security_beginner",
  "performance_optimizer",
  "bug_hunter",
  "streak_keeper",
  "quiz_master",
];

/** Badges earned from the facts (in BADGE_CODES order). */
export function computeBadges(facts: Facts, now: Date): BadgeCode[] {
  const count = (category: string) => facts.resolved.filter((f) => f.category === category).length;
  const bugs = count("bug");
  const perfectQuizzes = firstAttempts(facts.quizAttempts).filter(
    (a) => a.correctness.length > 0 && a.correctness.every(Boolean),
  ).length;
  const earned: Record<BadgeCode, boolean> = {
    first_bug_fixed: bugs >= 1,
    security_beginner: count("security") >= 5,
    performance_optimizer: count("performance") >= 5,
    bug_hunter: bugs >= 100,
    streak_keeper: streaks(reviewDays(facts.reviews), now).longest >= 7,
    quiz_master: perfectQuizzes >= 5,
  };
  return BADGE_CODES.filter((b) => earned[b]);
}

/** XP at which level n starts. */
export const levelStart = (n: number) => 50 * n * (n - 1);

/**
 * Level for a total XP. currentLevelXp / nextLevelXp are the XP thresholds where the current and next level
 * start; progressPct is the floored share of the way between them.
 */
export function levelFor(xp: number): { level: number; currentLevelXp: number; nextLevelXp: number; progressPct: number } {
  const total = Math.max(0, Math.floor(xp));
  let level = Math.max(1, Math.floor((1 + Math.sqrt(1 + total / 12.5)) / 2));
  while (levelStart(level) > total) level--;
  while (levelStart(level + 1) <= total) level++;
  const currentLevelXp = levelStart(level);
  const nextLevelXp = levelStart(level + 1);
  return { level, currentLevelXp, nextLevelXp, progressPct: Math.floor(((total - currentLevelXp) / (nextLevelXp - currentLevelXp)) * 100) };
}
