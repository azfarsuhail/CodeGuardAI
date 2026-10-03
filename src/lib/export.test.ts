import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewToMarkdown } from "./export.ts";
import type { ReviewDetail } from "./schemas.ts";

const review: ReviewDetail = {
  id: "rv1", status: "completed", language: "python", mode: "student", file_name: "main.py", source_type: "paste",
  original_code: 'API_KEY = "ab••••"\nprint("```")\n', focus: ["bugs"], summary: "One secret to fix.",
  scores: { quality: 100, security: 85, performance: 100, maintainability: 100, overall: 96, deductions: [{ finding_ref: "F-0001", score: "security", points: 15 }], security_capped: false },
  metrics: { loc: 2, function_count: 0, cyclomatic: 1, nesting_depth: 0, duplication_pct: 0, time_complexity: null, space_complexity: null, functions: [] },
  findings: [
    { id: "F-0001", category: "security", severity: "high", title: "Hard-coded | key", location: { file: "main.py", start_line: 1, end_line: 1 },
      problem: "A key is in the code.", why: "Anyone reading it can use it.", fix: "Read it from the environment.",
      fix_code: 'API_KEY = os.environ["API_KEY"]', fix_imports: ["import os"], fix_safety: "safe", source: "both", confidence: 1,
      cwe: "CWE-798", owasp: null, student_explanation: "Like leaving a password on a sticky note.", status: "open" },
    { id: "F-0002", category: "quality", severity: "low", title: "Dismissed", location: { file: "main.py", start_line: 2, end_line: 2 },
      problem: "p", why: "w", fix: "f", fix_code: null, fix_imports: [], fix_safety: "safe", source: "ai", confidence: 0.6,
      cwe: null, owasp: null, student_explanation: null, status: "false_positive" },
  ],
  concept_primers: [{ concept: "Secrets", explanation: "Keep them out of code." }], fix_versions: [], static_only: false, notice: null,
  model: "openrouter:nvidia/nemotron-3-super-120b-a12b", prompt_version: "review-x", duration_ms: 1000, created_at: "2026-10-03T10:00:00.000Z",
};

test("markdown report includes scores, open findings with fixes, primers and masked code", () => {
  const md = reviewToMarkdown(review);
  assert.match(md, /^# CodeGuard AI review: main\.py/);
  assert.match(md, /\| \*\*Overall\*\* \| \*\*96\/100\*\* \|/);
  assert.match(md, /- -15 Security: F-0001 Hard-coded \\\| key/);
  assert.match(md, /#### F-0001: Hard-coded \\\| key/); // pipe escaped so it can't break tables
  assert.match(md, /Requires: `import os`/);
  assert.match(md, /> \*\*In plain words:\*\* Like leaving a password/);
  assert.match(md, /1 open, 1 marked as false positive/);
  assert.ok(!md.includes("#### F-0002"), "false positives are left out");
  assert.match(md, /\*\*Secrets\.\*\* Keep them out of code\./);
});

test("code containing triple backticks gets a longer fence", () => {
  const md = reviewToMarkdown(review);
  assert.match(md, /````python\nAPI_KEY = "ab••••"\nprint\("```"\)\n````/);
});
