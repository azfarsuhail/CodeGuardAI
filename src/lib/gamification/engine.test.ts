import { test } from "node:test";
import assert from "node:assert/strict";
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
  type QuizAttemptFact,
  type ResolvedFinding,
  type ReviewFact,
} from "./engine.ts";

const t = (iso: string) => new Date(iso);
const facts = (f: Partial<Facts>): Facts => ({ reviews: [], resolved: [], quizAttempts: [], ...f });
const review = (id: string, iso: string): ReviewFact => ({ id, at: t(iso) });
const fixed = (ref: string, category: string, iso = "2026-01-01T12:00:00Z", reviewId = "r1"): ResolvedFinding => ({
  reviewId,
  ref,
  category,
  at: t(iso),
});
const attempt = (id: string, quizId: string, iso: string, correctness: boolean[]): QuizAttemptFact => ({
  id,
  quizId,
  at: t(iso),
  correctness,
});
const total = (f: Facts) => computeAwards(f).reduce((s, a) => s + a.points, 0);
const ofKind = (f: Facts, kind: string) => computeAwards(f).filter((a) => a.kind === kind);

test("completed review earns 10 XP plus a day-1 streak bonus of 5", () => {
  const awards = computeAwards(facts({ reviews: [review("r1", "2026-01-01T10:00:00Z")] }));
  assert.deepEqual(
    awards.map((a) => [a.kind, a.sourceId, a.points]),
    [
      ["review_completed", "r1", 10],
      ["streak_bonus", "2026-01-01", 5],
    ],
  );
});

test("bug fixed earns 15, security resolved earns 25, other categories earn nothing", () => {
  const f = facts({ resolved: [fixed("F-1", "bug"), fixed("F-2", "security"), fixed("F-3", "performance"), fixed("F-4", "quality")] });
  assert.deepEqual(
    computeAwards(f).map((a) => [a.kind, a.sourceId, a.points]),
    [
      ["bug_fixed", "r1:F-1", 15],
      ["security_resolved", "r1:F-2", 25],
    ],
  );
});

test("quiz: +5 per correct answer, keyed by attempt and question index", () => {
  const awards = computeAwards(facts({ quizAttempts: [attempt("a1", "q1", "2026-01-01T10:00:00Z", [true, false, true])] }));
  assert.deepEqual(
    awards.map((a) => [a.kind, a.sourceId, a.points]),
    [
      ["quiz_correct", "a1:0", 5],
      ["quiz_correct", "a1:2", 5],
    ],
  );
});

test("quiz: only the first attempt per quiz counts", () => {
  const f = facts({
    quizAttempts: [
      attempt("retry", "q1", "2026-01-02T10:00:00Z", [true, true, true]),
      attempt("first", "q1", "2026-01-01T10:00:00Z", [false, true, false]),
      attempt("other", "q2", "2026-01-03T10:00:00Z", [true]),
    ],
  });
  assert.deepEqual(
    ofKind(f, "quiz_correct").map((a) => a.sourceId),
    ["first:1", "other:0"],
  );
});

test("firstAttempts breaks equal timestamps by id", () => {
  const same = "2026-01-01T10:00:00Z";
  const got = firstAttempts([attempt("b", "q", same, []), attempt("a", "q", same, [])]);
  assert.deepEqual(got.map((a) => a.id), ["a"]);
});

test("daily cap: at most 10 review awards per UTC day, earliest win, next day resets", () => {
  const reviews = Array.from({ length: 12 }, (_, i) => review(`r${String(i).padStart(2, "0")}`, `2026-01-01T${String(10 + i).padStart(2, "0")}:00:00Z`));
  reviews.push(review("next", "2026-01-02T00:30:00Z"));
  const awarded = ofKind(facts({ reviews }), "review_completed").map((a) => a.sourceId);
  assert.equal(awarded.length, 11);
  assert.ok(!awarded.includes("r10") && !awarded.includes("r11"));
  assert.ok(awarded.includes("next"));
});

test("daily cap: at most 10 quiz_correct awards per UTC day across attempts", () => {
  const f = facts({
    quizAttempts: [
      attempt("a1", "q1", "2026-01-01T10:00:00Z", Array(6).fill(true)),
      attempt("a2", "q2", "2026-01-01T11:00:00Z", Array(6).fill(true)),
      attempt("a3", "q3", "2026-01-02T11:00:00Z", Array(6).fill(true)),
    ],
  });
  const awarded = ofKind(f, "quiz_correct").map((a) => a.sourceId);
  assert.deepEqual(awarded, ["a1:0", "a1:1", "a1:2", "a1:3", "a1:4", "a1:5", "a2:0", "a2:1", "a2:2", "a2:3", "a3:0", "a3:1", "a3:2", "a3:3", "a3:4", "a3:5"]);
});

test("caps do not apply to fixes", () => {
  const resolved = Array.from({ length: 15 }, (_, i) => fixed(`F-${i}`, "bug"));
  assert.equal(ofKind(facts({ resolved }), "bug_fixed").length, 15);
});

test("streak bonus grows 5/10/15/20 and caps at 20, resets after a gap", () => {
  const days = ["01", "02", "03", "04", "05", "07", "08"];
  const reviews = days.map((d) => review(`r${d}`, `2026-01-${d}T09:00:00Z`));
  // A second review on the same day does not add another bonus.
  reviews.push(review("r03b", "2026-01-03T20:00:00Z"));
  assert.deepEqual(
    ofKind(facts({ reviews }), "streak_bonus").map((a) => [a.sourceId, a.points]),
    [
      ["2026-01-01", 5],
      ["2026-01-02", 10],
      ["2026-01-03", 15],
      ["2026-01-04", 20],
      ["2026-01-05", 20],
      ["2026-01-07", 5],
      ["2026-01-08", 10],
    ],
  );
});

test("streak bonus uses UTC days and spans month boundaries", () => {
  const reviews = [review("a", "2026-01-31T23:59:00Z"), review("b", "2026-02-01T00:01:00Z")];
  assert.deepEqual(
    ofKind(facts({ reviews }), "streak_bonus").map((a) => [a.sourceId, a.points]),
    [
      ["2026-01-31", 5],
      ["2026-02-01", 10],
    ],
  );
});

test("days with only capped-out reviews still count toward the streak", () => {
  const reviews = Array.from({ length: 11 }, (_, i) => review(`r${String(i).padStart(2, "0")}`, `2026-01-01T${String(10 + i).padStart(2, "0")}:00:00Z`));
  assert.equal(total(facts({ reviews })), 100 + 5);
});

test("deterministic: input order does not change the output", () => {
  const f = facts({
    reviews: [review("r2", "2026-01-02T10:00:00Z"), review("r1", "2026-01-01T10:00:00Z"), review("r0", "2026-01-01T10:00:00Z")],
    resolved: [fixed("F-2", "security", "2026-01-02T11:00:00Z"), fixed("F-1", "bug", "2026-01-01T11:00:00Z")],
    quizAttempts: [attempt("a1", "q1", "2026-01-01T12:00:00Z", [true, true])],
  });
  const reversed = facts({ reviews: [...f.reviews].reverse(), resolved: [...f.resolved].reverse(), quizAttempts: f.quizAttempts });
  assert.deepEqual(computeAwards(f), computeAwards(reversed));
  assert.deepEqual(computeAwards(f), computeAwards(f));
});

test("award keys are unique per (kind, sourceId), so re-inserting is idempotent", () => {
  const f = facts({
    reviews: Array.from({ length: 30 }, (_, i) => review(`r${i}`, new Date(Date.UTC(2026, 0, 1 + (i % 9), i)).toISOString())),
    resolved: [fixed("F-1", "bug"), fixed("F-1", "security", undefined, "r2")],
    quizAttempts: [attempt("a1", "q1", "2026-01-01T12:00:00Z", [true, true, true])],
  });
  const keys = computeAwards(f).map((a) => `${a.kind}|${a.sourceId}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("resolveFindings: validated fix versions only, earliest wins, false positives excluded", () => {
  const findings = [
    { reviewId: "r1", ref: "F-1", category: "bug", status: "fixed" },
    { reviewId: "r1", ref: "F-2", category: "security", status: "open" },
    { reviewId: "r1", ref: "F-3", category: "bug", status: "false_positive" },
    { reviewId: "r2", ref: "F-1", category: "bug", status: "open" },
  ];
  const versions = [
    { reviewId: "r1", appliedRefs: ["F-1", "F-3"], validated: true, createdAt: t("2026-01-03T00:00:00Z") },
    { reviewId: "r1", appliedRefs: ["F-1"], validated: true, createdAt: t("2026-01-02T00:00:00Z") },
    { reviewId: "r1", appliedRefs: ["F-2"], validated: false, createdAt: t("2026-01-01T00:00:00Z") },
    // Same ref, different review: must not leak across reviews.
    { reviewId: "r3", appliedRefs: ["F-1"], validated: true, createdAt: t("2026-01-01T00:00:00Z") },
  ];
  assert.deepEqual(resolveFindings(findings, versions), [{ reviewId: "r1", ref: "F-1", category: "bug", at: t("2026-01-02T00:00:00Z") }]);
});

test("questionCorrectness reads the correct option index and falls back to the count", () => {
  const q = (correct_index: number) => ({ prompt: "?", options: ["a", "b", "c", "d"], correct_index, explanation: "." });
  assert.deepEqual(questionCorrectness([q(1), q(0), q(2)], [1, 1, 2], 2), [true, false, true]);
  // Unanswered (null) and missing answers are wrong.
  assert.deepEqual(questionCorrectness([q(0), q(3)], [null], 0), [false, false]);
  assert.deepEqual(questionCorrectness([{ prompt: "?" }], [0], 1), [true]);
  assert.deepEqual(questionCorrectness(null, null, 0), []);
});

test("streaks: current ends today or yesterday, longest across gaps", () => {
  const days = reviewDays(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-05", "2026-01-06"].map((d) => ({ at: t(`${d}T10:00:00Z`) })));
  assert.deepEqual(streaks(days, t("2026-01-06T23:00:00Z")), { current: 2, longest: 3 });
  assert.deepEqual(streaks(days, t("2026-01-07T01:00:00Z")), { current: 2, longest: 3 });
  assert.deepEqual(streaks(days, t("2026-01-08T00:00:00Z")), { current: 0, longest: 3 });
  assert.deepEqual(streaks([], t("2026-01-08T00:00:00Z")), { current: 0, longest: 0 });
});

test("reviewDays dedupes and sorts UTC days", () => {
  assert.deepEqual(reviewDays([{ at: t("2026-01-02T01:00:00Z") }, { at: t("2026-01-01T23:00:00Z") }, { at: t("2026-01-02T22:00:00Z") }]), [
    "2026-01-01",
    "2026-01-02",
  ]);
});

const now = t("2026-06-01T00:00:00Z");
const badges = (f: Partial<Facts>) => computeBadges(facts(f), now);
const many = (n: number, category: string) => Array.from({ length: n }, (_, i) => fixed(`F-${i}`, category));

test("badges: none for an empty history", () => {
  assert.deepEqual(badges({}), []);
});

test("badge thresholds: first_bug_fixed, bug_hunter", () => {
  assert.deepEqual(badges({ resolved: many(1, "bug") }), ["first_bug_fixed"]);
  assert.deepEqual(badges({ resolved: many(99, "bug") }), ["first_bug_fixed"]);
  assert.deepEqual(badges({ resolved: many(100, "bug") }), ["first_bug_fixed", "bug_hunter"]);
});

test("badge thresholds: security_beginner and performance_optimizer at 5", () => {
  assert.deepEqual(badges({ resolved: many(4, "security") }), []);
  assert.deepEqual(badges({ resolved: many(5, "security") }), ["security_beginner"]);
  assert.deepEqual(badges({ resolved: many(4, "performance") }), []);
  assert.deepEqual(badges({ resolved: many(5, "performance") }), ["performance_optimizer"]);
});

test("badge threshold: streak_keeper needs a 7-day longest streak (even if broken since)", () => {
  const run = (n: number) => Array.from({ length: n }, (_, i) => review(`r${i}`, new Date(Date.UTC(2026, 0, 1 + i, 9)).toISOString()));
  assert.deepEqual(badges({ reviews: run(6) }), []);
  assert.deepEqual(badges({ reviews: run(7) }), ["streak_keeper"]);
});

test("badge threshold: quiz_master needs 100% on 5 different quizzes, first attempts only", () => {
  const perfect = (n: number) => Array.from({ length: n }, (_, i) => attempt(`a${i}`, `q${i}`, "2026-01-01T10:00:00Z", [true, true]));
  assert.deepEqual(badges({ quizAttempts: perfect(4) }), []);
  assert.deepEqual(badges({ quizAttempts: perfect(5) }), ["quiz_master"]);
  // Same quiz five times does not count as five quizzes.
  const repeats = Array.from({ length: 5 }, (_, i) => attempt(`a${i}`, "q", `2026-01-0${i + 1}T10:00:00Z`, [true]));
  assert.deepEqual(badges({ quizAttempts: repeats }), []);
  // A perfect retry does not rescue an imperfect first attempt.
  const retried = [...perfect(4), attempt("first", "q9", "2026-01-01T09:00:00Z", [true, false]), attempt("retry", "q9", "2026-01-02T09:00:00Z", [true, true])];
  assert.deepEqual(badges({ quizAttempts: retried }), []);
  // An empty quiz is not a 100% score.
  assert.deepEqual(badges({ quizAttempts: [...perfect(4), attempt("e", "qe", "2026-01-01T10:00:00Z", [])] }), []);
});

test("levelFor: curve boundaries", () => {
  assert.deepEqual(levelFor(0), { level: 1, currentLevelXp: 0, nextLevelXp: 100, progressPct: 0 });
  assert.deepEqual(levelFor(99), { level: 1, currentLevelXp: 0, nextLevelXp: 100, progressPct: 99 });
  assert.deepEqual(levelFor(100), { level: 2, currentLevelXp: 100, nextLevelXp: 300, progressPct: 0 });
  assert.deepEqual(levelFor(200), { level: 2, currentLevelXp: 100, nextLevelXp: 300, progressPct: 50 });
  assert.deepEqual(levelFor(299), { level: 2, currentLevelXp: 100, nextLevelXp: 300, progressPct: 99 });
  assert.equal(levelFor(300).level, 3);
  assert.equal(levelFor(600).level, 4);
  assert.equal(levelFor(599).level, 3);
  assert.equal(levelFor(-5).level, 1);
  for (let n = 1; n < 200; n++) {
    assert.equal(levelFor(50 * n * (n - 1)).level, n);
    assert.equal(levelFor(50 * n * (n + 1) - 1).level, n);
  }
});
