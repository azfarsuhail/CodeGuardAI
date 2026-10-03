import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFixes, defaultSelection } from "./fixes.ts";
import type { Finding } from "./schemas.ts";

const original = ["import os", "KEY = 'ab••••'", "def avg(xs):", "    return sum(xs) / len(xs)", ""].join("\n");

const finding = (id: string, start: number, end: number, fix_code: string | null, over: Partial<Finding> = {}): Finding => ({
  id, category: "bug", severity: "medium", title: id, location: { file: "main.py", start_line: start, end_line: end },
  problem: "p", why: "w", fix: "f", fix_code, fix_imports: [], fix_safety: "safe", source: "ai", confidence: 0.9,
  cwe: null, owasp: null, student_explanation: null, status: "open", ...over,
});

const secret = finding("F-0001", 2, 2, "KEY = os.environ['KEY']", { severity: "high", category: "security" });
const guard = finding("F-0002", 4, 4, "    if not xs:\n        return 0\n    return sum(xs) / len(xs)\n");
const risky = finding("F-0003", 3, 4, "def avg(xs):\n    return statistics.fmean(xs)", { fix_safety: "needs_review", severity: "low" });
const manual = finding("F-0004", 1, 1, "import os, sys", { fix_safety: "manual_only" });
const all = [secret, guard, risky, manual];

test("default selection is safe fixes only", () => {
  assert.deepEqual([...defaultSelection(all)], ["F-0001", "F-0002"]);
});

test("applies multi-line replacements bottom-up and leaves the original untouched", () => {
  const before = original;
  const plan = applyFixes(original, all, defaultSelection(all));
  assert.equal(original, before);
  assert.equal(
    plan.code,
    ["import os", "KEY = os.environ['KEY']", "def avg(xs):", "    if not xs:", "        return 0", "    return sum(xs) / len(xs)", ""].join("\n"),
  );
  assert.deepEqual(plan.applied.map((c) => c.finding_ref), ["F-0001", "F-0002"]);
});

test("overlapping opt-in fix loses to the more severe one; manual-only never applies", () => {
  const plan = applyFixes(original, all, new Set(["F-0002", "F-0003", "F-0004"]));
  assert.deepEqual(plan.applied.map((c) => c.finding_ref), ["F-0002"]);
  assert.deepEqual(plan.skipped.map((s) => s.finding_ref).sort(), ["F-0003", "F-0004"]);
});

test("required imports are added once, after existing imports, and only if missing", () => {
  const src = ["#!/usr/bin/env python3", 'KEY = "ab••••"', "print(KEY)", ""].join("\n");
  const env = finding("F-0001", 2, 2, 'KEY = os.environ["KEY"]', { fix_imports: ["import os"] });
  const log = finding("F-0002", 3, 3, "logging.info(KEY)", { fix_imports: ["import os", "import logging"] });
  const plan = applyFixes(src, [env, log], new Set(["F-0001", "F-0002"]));
  assert.deepEqual(plan.addedImports, ["import os", "import logging"]);
  assert.equal(plan.code, ["#!/usr/bin/env python3", "import os", "import logging", 'KEY = os.environ["KEY"]', "logging.info(KEY)", ""].join("\n"));

  // Already imported: nothing added; new imports go after the last existing import.
  const withImports = ["import os", "import sys", 'KEY = "ab••••"', ""].join("\n");
  const again = applyFixes(withImports, [{ ...env, location: { file: "main.py", start_line: 3, end_line: 3 } }], new Set(["F-0001"]));
  assert.deepEqual(again.addedImports, []);
  const json = applyFixes(withImports, [{ ...env, location: { file: "main.py", start_line: 3, end_line: 3 }, fix_imports: ["import json"] }], new Set(["F-0001"]));
  assert.equal(json.code.split("\n")[2], "import json");
});

test("needs-review fix applies when it is the only one selected", () => {
  const plan = applyFixes(original, all, new Set(["F-0003"]));
  assert.ok(plan.code.includes("statistics.fmean(xs)"));
  assert.equal(plan.applied[0].safety, "needs_review");
});
