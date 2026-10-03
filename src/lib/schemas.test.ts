import { test } from "node:test";
import assert from "node:assert/strict";
import { AiReviewOutput, CreateReviewRequest, StudentReviewOutput, aiReviewJsonSchema, aiFixJsonSchema } from "./schemas.ts";

test("request applies defaults and enforces PRD limits", () => {
  const ok = CreateReviewRequest.parse({ code: "def f(a, b):\n    return a / b\n", language: "python", mode: "student" });
  assert.deepEqual(ok.focus, ["bugs", "security", "performance"]);

  const tooLong = CreateReviewRequest.safeParse({ code: "x\n".repeat(1000), language: "python", mode: "developer" });
  assert.equal(tooLong.success, false);

  const badLang = CreateReviewRequest.safeParse({ code: "x", language: "cobol", mode: "developer" });
  assert.equal(badLang.success, false);

  const noFocus = CreateReviewRequest.safeParse({ code: "x", language: "java", mode: "developer", focus: [] });
  assert.equal(noFocus.success, false);
});

test("LLM review output validates and rejects malformed findings", () => {
  const finding = {
    id: "F-0001", static_ref: null, category: "bug", severity: "high", title: "Division by zero",
    location: { start_line: 2, end_line: 2 }, evidence: "    return a / b",
    problem: "b may be zero.", why: "Raises ZeroDivisionError.", fix: "Guard b == 0.",
    fix_code: "    if b == 0:\n        raise ValueError('b must be non-zero')\n    return a / b",
    fix_safety: "safe", confidence: 0.9, cwe: "CWE-369", owasp: null,
    student_explanation: "Dividing by zero is undefined, so Python stops your program.",
  };
  const output = { summary: "One bug.", findings: [finding], complexity: { time_complexity: "O(1)", space_complexity: "O(1)", functions: [] }, concept_primers: [] };
  assert.equal(AiReviewOutput.safeParse(output).success, true);
  assert.equal(AiReviewOutput.safeParse({ ...output, findings: [{ ...finding, confidence: 1.5 }] }).success, false);
  assert.equal(AiReviewOutput.safeParse({ ...output, findings: [{ ...finding, fix_safety: "yolo" }] }).success, false);

  // Student mode additionally requires primers and per-finding explanations.
  assert.equal(StudentReviewOutput.safeParse(output).success, false);
  const primers = [{ concept: "Division", explanation: "Dividing by zero is undefined." }];
  assert.equal(StudentReviewOutput.safeParse({ ...output, concept_primers: primers }).success, true);
  assert.equal(
    StudentReviewOutput.safeParse({ ...output, concept_primers: primers, findings: [{ ...finding, student_explanation: null }] }).success,
    false,
  );
});

test("JSON Schemas are strict enough for structured-output APIs", () => {
  for (const schema of [aiReviewJsonSchema, aiFixJsonSchema] as Record<string, unknown>[]) {
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
  }
  const { properties } = aiReviewJsonSchema as unknown as { properties: { findings: { items: { required: string[] } } } };
  const finding = properties.findings.items;
  assert.ok(finding.required.includes("fix_safety") && finding.required.includes("static_ref"));
});
