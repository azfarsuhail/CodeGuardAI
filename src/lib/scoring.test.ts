import { test } from "node:test";
import assert from "node:assert/strict";
import { computeScores } from "./scoring.ts";

const f = (id: string, category: string, severity: string, confidence = 1, status = "open") =>
  ({ id, category, severity, confidence, status }) as Parameters<typeof computeScores>[0][number];

test("clean code scores 100 everywhere", () => {
  const s = computeScores([]);
  assert.deepEqual([s.quality, s.security, s.performance, s.maintainability, s.overall], [100, 100, 100, 100, 100]);
});

test("penalties scale by confidence and map categories to scores", () => {
  const s = computeScores([f("F-1", "bug", "high", 0.8), f("F-2", "performance", "medium"), f("F-3", "quality", "info")]);
  assert.equal(s.quality, 88); // 100 - 15 * 0.8
  assert.equal(s.performance, 93);
  assert.equal(s.overall, Math.round(0.3 * 88 + 0.3 * 100 + 0.2 * 93 + 0.2 * 100));
  assert.deepEqual(s.deductions, [
    { finding_ref: "F-1", score: "quality", points: 12 },
    { finding_ref: "F-2", score: "performance", points: 7 },
  ]);
});

test("a critical security finding caps security at 60 even with low confidence", () => {
  const s = computeScores([f("F-1", "security", "critical", 0.5)]);
  assert.equal(s.security, 60);
  assert.equal(s.security_capped, true);
});

test("scores floor at 0 and ignore false positives", () => {
  const many = Array.from({ length: 5 }, (_, i) => f(`F-${i}`, "security", "critical"));
  assert.equal(computeScores(many).security, 0);
  assert.equal(computeScores([f("F-1", "security", "critical", 1, "false_positive")]).security, 100);
});
