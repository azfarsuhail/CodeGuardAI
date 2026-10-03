import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "../schemas.ts";
import { buildSummary, checkConclusion, formatComment, parsePatch, splitFindings } from "./review.ts";

const finding = (o: Partial<Finding> & { start: number; end?: number }): Finding => ({
  id: "F1",
  category: "security",
  severity: "high",
  title: "SQL injection",
  location: { file: "app.py", start_line: o.start, end_line: o.end ?? o.start },
  problem: "Query built with string concatenation.",
  why: "Attackers can read the database.",
  fix: "Use parameters.",
  fix_code: null,
  fix_imports: [],
  fix_safety: "needs_review",
  source: "static",
  confidence: 1,
  cwe: null,
  owasp: null,
  student_explanation: null,
  status: "open",
  ...o,
});

const PATCH = [
  "@@ -1,4 +1,5 @@",
  " import os",
  "-x = 1",
  "+x = 2",
  "+y = 3",
  " z = 4",
  "\\ No newline at end of file",
  "@@ -20,3 +21,3 @@ def f():",
  " a",
  "-b",
  "+c",
  " d",
].join("\n");

test("parsePatch maps added lines on the RIGHT side across hunks", () => {
  const { added, visible } = parsePatch(PATCH);
  assert.deepEqual([...added], [2, 3, 22]);
  assert.deepEqual([...visible], [1, 2, 3, 4, 21, 22, 23]);
  assert.equal(parsePatch(undefined).added.size, 0);
  assert.deepEqual([...parsePatch("@@ -0,0 +1 @@\n+only").added], [1]);
  assert.deepEqual([...parsePatch("@@ -3,2 +3 @@\n-gone\n-also gone\n kept").added], []);
});

test("splitFindings: only findings touching changed lines are introduced, sorted by severity", () => {
  const { added } = parsePatch(PATCH);
  const low = finding({ id: "a", start: 3, severity: "low" });
  const crit = finding({ id: "b", start: 20, end: 23, severity: "critical" });
  const old = finding({ id: "c", start: 10, end: 15 });
  const { introduced, preexisting } = splitFindings([low, old, crit], added);
  assert.deepEqual(introduced.map((f) => f.id), ["b", "a"]);
  assert.equal(preexisting, 1);
});

test("formatComment anchors to changed lines and only suggests fully-changed safe fixes", () => {
  const lines = parsePatch(PATCH);
  const safe = formatComment("app.py", finding({ start: 2, end: 3, fix_safety: "safe", fix_code: "x = 2  # ok\ny = 3\n" }), lines);
  assert.equal(safe.start_line, 2);
  assert.equal(safe.line, 3);
  assert.equal(safe.side, "RIGHT");
  assert.match(safe.body, /```suggestion\nx = 2 {2}# ok\ny = 3\n```/);
  assert.match(safe.body, /^\*\*High · Security: SQL injection\*\*/);
  assert.match(safe.body, /\*\*Why it matters:\*\* Attackers/);

  // Range covers context lines too: no suggestion, comment clamped to the changed line.
  const partial = formatComment("app.py", finding({ start: 21, end: 23, fix_safety: "safe", fix_code: "c2" }), lines);
  assert.equal(partial.line, 22);
  assert.equal(partial.start_line, undefined);
  assert.doesNotMatch(partial.body, /suggestion/);

  const unsafe = formatComment("app.py", finding({ start: 2, end: 2, fix_code: "x = 9" }), lines);
  assert.doesNotMatch(unsafe.body, /suggestion/);

  const ai = formatComment("app.py", finding({ start: 3, source: "ai", confidence: 0.72 }), lines);
  assert.match(ai.body, /AI-only finding, confidence 72%/);
  assert.doesNotMatch(formatComment("app.py", finding({ start: 3 }), lines).body, /AI-only/);
});

test("checkConclusion: high/critical fail, medium is neutral, the rest pass", () => {
  assert.equal(checkConclusion([finding({ start: 1, severity: "critical" })]), "failure");
  assert.equal(checkConclusion([finding({ start: 1, severity: "medium" }), finding({ start: 1, severity: "high" })]), "failure");
  assert.equal(checkConclusion([finding({ start: 1, severity: "medium" }), finding({ start: 1, severity: "low" })]), "neutral");
  assert.equal(checkConclusion([finding({ start: 1, severity: "info" })]), "success");
  assert.equal(checkConclusion([]), "success");
});

test("buildSummary tabulates new issues and per-file scores", () => {
  const scores = { quality: 80, security: 60, performance: 90, maintainability: 70, overall: 75, deductions: [], security_capped: true };
  const { title, summary } = buildSummary(
    [
      { path: "app.py", introduced: [finding({ start: 2 }), finding({ start: 3, severity: "low" })], preexisting: 2, scores },
      { path: "big.ts", introduced: [], preexisting: 0, scores: null, note: "binary or over 1 MB" },
    ],
    ["1 changed file was skipped."],
  );
  assert.equal(title, "2 new issues (worst: high)");
  assert.match(summary, /\| High \| 1 \|/);
  assert.match(summary, /\| `app.py` \| 75 \| 60 \| 80 \| 2 \| 2 \|/);
  assert.match(summary, /binary or over 1 MB/);
  assert.match(summary, /2 pre-existing issues/);
  assert.equal(buildSummary([], []).title, "No new issues found");
});
