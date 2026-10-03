import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFixedCode } from "./pipeline.ts";

const original = `def average(scores):
    total = 0
    for s in scores:
        total += s
    return total / len(scores)
`;

test("a clean fix validates, even though it shifts line numbers", () => {
  const fixed = original.replace("    total = 0\n", "    if not scores:\n        return 0\n    total = 0\n");
  assert.deepEqual(validateFixedCode(original, fixed, "python", "main.py"), { validated: true, errors: [] });
});

test("a pre-existing issue reported by a different tool after the fix is not counted as new", () => {
  const sql = `def get_user(conn, name):\n    query = "SELECT * FROM users WHERE name = '" + name + "'"\n    return conn.execute(query)\n`;
  // Ruff and the pattern scanner both flag line 2; whichever wins dedup, the SQL issue isn't "introduced".
  const fixed = sql.replace("return conn.execute(query)", "return conn.execute(query).fetchone()");
  assert.deepEqual(validateFixedCode(sql, fixed, "python", "main.py"), { validated: true, errors: [] });
});

test("a fix that introduces an undefined name or a syntax error is flagged", () => {
  const undefinedName = original.replace("return total / len(scores)", "return statistics.fmean(scores)");
  const r = validateFixedCode(original, undefinedName, "python", "main.py");
  assert.equal(r.validated, false);
  assert.match(r.errors[0], /^Line 5: .*statistics.*\(ruff F821\)$/);

  const broken = validateFixedCode(original, original.replace("def average(scores):", "def average(scores)"), "python", "main.py");
  assert.equal(broken.validated, false);
  assert.ok(broken.errors.some((e) => e.includes("syntax-error")));
});
