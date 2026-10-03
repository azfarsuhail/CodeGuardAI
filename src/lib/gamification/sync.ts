import { prisma } from "@/lib/prisma";
import type { BadgeCode } from "@/generated/prisma/client";
import { BADGES } from "./badges";
import {
  computeAwards,
  computeBadges,
  firstAttempts,
  levelFor,
  questionCorrectness,
  resolveFindings,
  reviewDays,
  streaks,
  type Facts,
} from "./engine";

async function loadFacts(userId: string): Promise<Facts> {
  const [reviews, findings, fixVersions, attempts] = await Promise.all([
    prisma.review.findMany({ where: { userId, status: "completed" }, select: { id: true, createdAt: true } }),
    prisma.finding.findMany({
      where: { review: { userId }, category: { in: ["bug", "security", "performance"] }, status: { not: "false_positive" } },
      select: { reviewId: true, ref: true, category: true, status: true },
    }),
    prisma.fixVersion.findMany({
      where: { review: { userId }, validated: true },
      select: { reviewId: true, appliedRefs: true, validated: true, createdAt: true },
    }),
    prisma.quizAttempt.findMany({
      where: { userId },
      select: { id: true, quizId: true, answers: true, correct: true, createdAt: true },
    }),
  ]);

  // Only first attempts count, so only their quizzes' questions are loaded.
  const first = firstAttempts(attempts.map((a) => ({ ...a, at: a.createdAt })));
  const quizzes = first.length
    ? await prisma.quiz.findMany({ where: { id: { in: first.map((a) => a.quizId) } }, select: { id: true, questions: true } })
    : [];
  const questions = new Map(quizzes.map((q) => [q.id, q.questions]));

  return {
    reviews: reviews.map((r) => ({ id: r.id, at: r.createdAt })),
    resolved: resolveFindings(findings, fixVersions),
    quizAttempts: first.map((a) => ({
      id: a.id,
      quizId: a.quizId,
      at: a.at,
      correctness: questionCorrectness(questions.get(a.quizId), a.answers, a.correct),
    })),
  };
}

/**
 * Recomputes the user's XP awards and badges from their facts and appends whatever is missing.
 * Idempotent and safe to call concurrently: the unique keys + skipDuplicates make re-inserts no-ops, and
 * createManyAndReturn returns only the rows this call actually inserted.
 */
export async function syncGamification(userId: string): Promise<{ newXp: number; newBadges: BadgeCode[] }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return { newXp: 0, newBadges: [] };

  const facts = await loadFacts(userId);
  const awards = computeAwards(facts);
  const badges = computeBadges(facts, new Date());

  // ponytail: the daily caps are recomputed from facts, not from the ledger, so a review whose status flips to
  // completed long after newer same-day reviews were awarded can push that day to 11. Count the ledger per day if it matters.
  const [xp, earned] = await prisma.$transaction([
    prisma.xpEvent.createManyAndReturn({
      data: awards.map((a) => ({ userId, kind: a.kind, sourceId: a.sourceId, points: a.points, createdAt: a.at })),
      skipDuplicates: true,
      select: { points: true },
    }),
    prisma.userBadge.createManyAndReturn({
      data: badges.map((badge) => ({ userId, badge })),
      skipDuplicates: true,
      select: { badge: true },
    }),
  ]);

  return { newXp: xp.reduce((sum, e) => sum + e.points, 0), newBadges: earned.map((b) => b.badge) };
}

export type GamificationSummary = ReturnType<typeof levelFor> & {
  xp: number;
  currentStreak: number;
  longestStreak: number;
  /** Most recent first. */
  badges: { code: BadgeCode; label: string; description: string; awardedAt: Date }[];
};

export async function getGamificationSummary(userId: string): Promise<GamificationSummary> {
  const [sum, badges, reviews] = await Promise.all([
    prisma.xpEvent.aggregate({ where: { userId }, _sum: { points: true } }),
    prisma.userBadge.findMany({ where: { userId }, orderBy: { awardedAt: "desc" }, select: { badge: true, awardedAt: true } }),
    prisma.review.findMany({ where: { userId, status: "completed" }, select: { createdAt: true } }),
  ]);
  const xp = sum._sum.points ?? 0;
  const { current, longest } = streaks(reviewDays(reviews.map((r) => ({ at: r.createdAt }))), new Date());
  return {
    xp,
    ...levelFor(xp),
    currentStreak: current,
    longestStreak: longest,
    badges: badges.map((b) => ({ code: b.badge, ...pick(BADGES[b.badge]), awardedAt: b.awardedAt })),
  };
}

const pick = ({ label, description }: { label: string; description: string }) => ({ label, description });
