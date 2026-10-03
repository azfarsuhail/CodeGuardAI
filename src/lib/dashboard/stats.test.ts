import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, type DashboardReview } from "./stats.ts";

const NOW = new Date("2026-10-03T12:00:00Z");
let n = 0;
const review = (createdAt: string, overall: number | null, extra: Partial<DashboardReview> = {}): DashboardReview => ({
  id: `r${++n}`,
  fileName: "main.py",
  language: "python",
  createdAt: new Date(createdAt),
  overall,
  findings: [],
  validatedRefs: [],
  ...extra,
});
const finding = (ref: string, category: string, severity = "high", status = "open") =>
  ({ ref, category, severity, status }) as DashboardReview["findings"][number];

test("trend has 30 UTC days ending today, averages per day, gaps as null", () => {
  const s = summarize(
    [
      review("2026-10-03T00:00:00Z", 80), // today, UTC midnight
      review("2026-10-03T23:59:59Z", 90), // still today in UTC
      review("2026-09-30T05:00:00Z", 70),
      review("2026-09-03T23:59:59Z", 10), // day before the window
      review("2026-10-01T10:00:00Z", null), // no score: never a zero
    ],
    NOW,
  );
  assert.equal(s.trend.length, 30);
  assert.equal(s.trend[0].date, "2026-09-04");
  assert.deepEqual(s.trend.at(-1), { date: "2026-10-03", avg: 85, count: 2 });
  assert.deepEqual(s.trend.find((p) => p.date === "2026-09-30"), { date: "2026-09-30", avg: 70, count: 1 });
  assert.deepEqual(s.trend.find((p) => p.date === "2026-10-01"), { date: "2026-10-01", avg: null, count: 0 });
  assert.equal(s.trend.filter((p) => p.avg !== null).length, 2);
});

test("30-day average and delta vs the previous 30 days", () => {
  const s = summarize([review("2026-10-02T00:00:00Z", 80), review("2026-09-10T00:00:00Z", 75), review("2026-09-03T00:00:00Z", 60), review("2026-08-05T00:00:00Z", 70), review("2026-08-04T23:00:00Z", 0)], NOW);
  assert.deepEqual(s.avgScore, { current: 77.5, previous: 65, delta: 12.5 });
  assert.deepEqual(summarize([review("2026-10-02T00:00:00Z", 80)], NOW).avgScore, { current: 80, previous: null, delta: null });
  assert.deepEqual(summarize([], NOW).avgScore, { current: null, previous: null, delta: null });
});

test("fixed counts only refs applied by a validated FixVersion of the same review; false positives excluded", () => {
  const s = summarize(
    [
      review("2026-10-01T00:00:00Z", 70, {
        findings: [
          finding("F-1", "bug"), // validated fix -> fixed
          finding("F-2", "bug", "low", "fixed"), // marked fixed, but no validated fix -> not counted
          finding("F-3", "bug", "medium", "false_positive"), // in validated refs, but a false positive
          finding("F-4", "security", "critical"), // validated fix -> resolved
          finding("F-5", "security", "high"), // open
          finding("F-6", "security", "high", "false_positive"),
        ],
        validatedRefs: ["F-1", "F-3", "F-4"],
      }),
      // F-5 applied only in another review's validated fix: does not resolve this review's F-5
      review("2026-10-01T00:00:00Z", 70, { findings: [finding("F-1", "bug", "medium")], validatedRefs: ["F-5"] }),
    ],
    NOW,
  );
  assert.equal(s.bugsFixed, 1);
  assert.deepEqual(s.security, { found: 2, resolved: 1 });
  assert.equal(s.open.total, 2);
  assert.deepEqual(s.open.byCategory, { security: 1, bug: 1 });
  assert.deepEqual(s.open.bySeverity, { high: 1, medium: 1 });
});

test("per-language counts and averages, sorted by count", () => {
  const s = summarize(
    [
      review("2026-01-01T00:00:00Z", 60, { language: "java" }),
      review("2026-01-02T00:00:00Z", 71, { language: "typescript" }),
      review("2026-01-03T00:00:00Z", 80, { language: "typescript" }),
      review("2026-01-04T00:00:00Z", null, { language: "typescript" }),
    ],
    NOW,
  );
  assert.equal(s.reviewsCompleted, 4);
  assert.deepEqual(s.languages, [
    { language: "typescript", count: 3, avg: 75.5 },
    { language: "java", count: 1, avg: 60 },
  ]);
});

test("recent lists the latest 5, newest first", () => {
  const rs = Array.from({ length: 7 }, (_, i) => review(`2026-09-0${i + 1}T00:00:00Z`, 50 + i));
  const s = summarize(rs, NOW);
  assert.deepEqual(
    s.recent.map((r) => r.overall),
    [56, 55, 54, 53, 52],
  );
});
