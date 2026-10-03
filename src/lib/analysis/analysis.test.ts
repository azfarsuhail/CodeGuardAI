import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGUAGES } from "../languages.ts";
import { runStaticAnalysis } from "./index.ts";
import { computeMetrics, stripCode } from "./metrics.ts";

const rules = (lang: keyof typeof LANGUAGES) =>
  runStaticAnalysis(LANGUAGES[lang].sample, lang, `main${LANGUAGES[lang].extensions[0]}`);

test("python sample: secret masked, SQL injection and unused import found via Ruff", () => {
  const r = rules("python");
  assert.ok(!r.code.includes("a1b2c3d4-hardcoded-demo-key"), "secret must be masked");
  assert.ok(r.code.includes('API_KEY = "a1••'));
  const at = (line: number, category: string) => r.findings.find((f) => f.start_line === line && f.category === category);
  assert.equal(at(3, "security")?.cwe, "CWE-798");
  assert.equal(at(6, "security")?.cwe, "CWE-89");
  assert.ok(r.findings.every((f, i) => f.id === `S-${i + 1}`));
  assert.equal(r.metrics.function_count, 3);
  assert.deepEqual(
    r.metrics.functions.map((f) => [f.name, f.start_line, f.end_line, f.cyclomatic, f.nesting_depth]),
    [["get_user", 5, 7, 1, 0], ["average", 9, 13, 2, 1], ["has_duplicates", 15, 20, 5, 3]],
  );
});

test("javascript sample: command injection, loose equality, secret", () => {
  const r = rules("javascript");
  const has = (rule: string, line: number) => r.findings.some((f) => f.rule === rule && f.start_line === line);
  assert.ok(has("hardcoded-secret", 3));
  assert.ok(has("shell-command-injection", 6));
  assert.ok(has("eqeqeq", 11));
  assert.deepEqual(r.metrics.functions.map((f) => f.name), ["listDir", "findUser"]);
});

test("typescript sample parses with the TS parser and flags explicit any", () => {
  const r = rules("typescript");
  assert.ok(!r.findings.some((f) => f.rule === "syntax-error"), JSON.stringify(r.findings));
  assert.ok(r.findings.some((f) => f.rule === "explicit-any" && f.start_line === 7));
  assert.deepEqual(r.metrics.functions.map((f) => f.name), ["applyDiscount", "uniqueItems", "loadOrder"]);
});

test("java sample: SQL injection, secret, methods measured; syntax errors located", () => {
  const r = rules("java");
  assert.ok(r.findings.some((f) => f.cwe === "CWE-89" && f.start_line === 8));
  assert.ok(r.findings.some((f) => f.rule === "hardcoded-secret" && f.start_line === 4));
  assert.deepEqual(r.metrics.functions.map((f) => f.name), ["find", "average"]);
  const bad = runStaticAnalysis("public class A {\n  void f( {\n  }\n}\n", "java", "A.java");
  assert.equal(bad.findings[0].rule, "syntax-error");
  assert.equal(bad.findings[0].start_line, 2);
  const eq = runStaticAnalysis('class A { boolean f(String s) { return s == "x"; } }', "java", "A.java");
  assert.ok(eq.findings.some((f) => f.rule === "string-reference-equality"));
});

test("stripCode blanks comments and strings without moving lines", () => {
  const src = 'x = "if # not a comment"  # if comment\ny = 1';
  const out = stripCode(src, "python");
  assert.equal(out.length, src.length);
  assert.equal(out.split("\n")[0].trim(), "x =");
  assert.equal(out.split("\n")[1], "y = 1");
});

test("metrics flag complex and duplicated code", () => {
  const branches = Array.from({ length: 12 }, (_, i) => `  if (x === ${i}) y++;`).join("\n");
  const { metrics, findings } = computeMetrics(`function big(x) {\n  let y = 0;\n${branches}\n  return y;\n}`, "javascript");
  assert.equal(metrics.functions[0].cyclomatic, 13);
  assert.ok(findings.some((f) => f.rule === "cyclomatic-complexity" && f.severity === "medium"));
  const block = "total = total + price * qty\ncount = count + 1\nlog_value(total, count)\nprint_receipt(total)\n";
  assert.ok(computeMetrics(block + block, "python").metrics.duplication_pct > 90);
});
