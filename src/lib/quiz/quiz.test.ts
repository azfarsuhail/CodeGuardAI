import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "../schemas.ts";
import { buildQuizPrompt, QUIZ_SYSTEM_PROMPT } from "./prompt.ts";
import {
  AttemptRequest,
  CheckRequest,
  gradeAnswers,
  quizOutputSchema,
  sanitizeQuestions,
  shuffleOptions,
  toPublicQuestions,
  type QuizQuestion,
} from "./quiz.ts";

const q = (n: number, over: Partial<QuizQuestion> = {}): QuizQuestion => ({
  question: `What happens when avg([]) is called in question ${n}?`,
  options: ["It returns 0", "ZeroDivisionError", "It returns None", "It loops forever"],
  correct_index: 1,
  explanation: "len([]) is 0, so sum / len divides by zero.",
  finding_ref: "F-0001",
  concept: "Empty input",
  ...over,
});
const refs = new Set(["F-0001", "F-0002"]);

test("valid LLM output passes the per-review schema", () => {
  assert.ok(quizOutputSchema(refs).safeParse({ questions: [q(1), q(2), q(3, { finding_ref: "F-0002" })] }).success);
});

test("schema rejects unknown finding refs, duplicate options and wrong option counts", () => {
  const schema = quizOutputSchema(refs);
  assert.equal(schema.safeParse({ questions: [q(1), q(2), q(3, { finding_ref: "F-9999" })] }).success, false);
  assert.equal(schema.safeParse({ questions: [q(1), q(2), q(3, { options: ["a", "A ", "b", "c"] })] }).success, false);
  assert.equal(schema.safeParse({ questions: [q(1), q(2), q(3, { options: ["a", "b", "c"] })] }).success, false);
  assert.equal(schema.safeParse({ questions: [q(1), q(2), q(3, { correct_index: 4 })] }).success, false);
  assert.equal(schema.safeParse({ questions: [q(1), q(2)] }).success, false);
});

test("schema tolerates one bad question when 3 usable ones remain; sanitize drops it", () => {
  const questions = [q(1), q(2), q(3), q(4, { finding_ref: "F-9999" })];
  assert.ok(quizOutputSchema(refs).safeParse({ questions }).success);
  const clean = sanitizeQuestions(questions, refs);
  assert.equal(clean.length, 3);
  assert.ok(clean.every((c) => refs.has(c.finding_ref)));
});

test("sanitize trims, drops duplicate questions and truncates long explanations", () => {
  const long = Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ");
  const clean = sanitizeQuestions([q(1, { question: `  ${q(1).question}  `, explanation: long }), q(1)], refs);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].question, q(1).question);
  assert.equal(clean[0].explanation.split(" ").length, 80);
});

test("shuffle keeps the correct answer pointing at the same text", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 20; i++) {
    const s = shuffleOptions(q(1), random);
    assert.equal(s.options[s.correct_index], "ZeroDivisionError");
    assert.deepEqual([...s.options].sort(), [...q(1).options].sort());
  }
});

test("public questions never include answers or explanations", () => {
  const pub = toPublicQuestions([q(1), q(2)]);
  assert.deepEqual(Object.keys(pub[0]).sort(), ["concept", "finding_ref", "index", "options", "question"]);
  const text = JSON.stringify(pub);
  assert.ok(!text.includes("correct_index") && !text.includes("explanation") && !text.includes("divides by zero"));
  assert.equal(pub[1].index, 1);
});

test("grading counts correct answers; null and wrong answers score zero", () => {
  const g = gradeAnswers([q(1), q(2), q(3), q(4)], [1, 0, null, 1]);
  assert.equal(g.correct, 2);
  assert.equal(g.total, 4);
  assert.equal(g.score_pct, 50);
  assert.deepEqual(g.results.map((r) => r.correct), [true, false, false, true]);
  assert.ok(g.results.every((r) => r.correct_index === 1 && r.explanation.length > 0));
});

test("request bodies are validated", () => {
  assert.ok(CheckRequest.safeParse({ question_index: 0, answer_index: 3 }).success);
  assert.equal(CheckRequest.safeParse({ question_index: 0, answer_index: 4 }).success, false);
  assert.equal(CheckRequest.safeParse({ question_index: 1.5, answer_index: 0 }).success, false);
  assert.ok(AttemptRequest.safeParse({ answers: [0, null, 3] }).success);
  assert.equal(AttemptRequest.safeParse({ answers: [] }).success, false);
  assert.equal(AttemptRequest.safeParse({ answers: [0, 1, 2, 3, 0, 1] }).success, false);
  assert.equal(AttemptRequest.safeParse({ answers: ["0"] }).success, false);
});

test("prompt fences untrusted code and findings with a per-request nonce", () => {
  const finding = {
    id: "F-0001", category: "bug", severity: "high", title: "Division by zero", location: { file: "a.py", start_line: 2, end_line: 2 },
    problem: "p", why: "w", fix: "f", student_explanation: "plain words", status: "open",
  } as Finding;
  const input = { code: "def avg(xs):\n    return sum(xs) / len(xs)", language: "python", fileName: "a.py", findings: [finding], questionCount: 3 } as const;
  const dev = buildQuizPrompt({ ...input, mode: "developer" });
  const tags = dev.match(/<code_([0-9a-f]{12})>/);
  assert.ok(tags && dev.includes(`</code_${tags[1]}>`) && dev.includes(`<findings_${tags[1]}>`));
  assert.notEqual(buildQuizPrompt({ ...input, mode: "developer" }).match(/<code_([0-9a-f]{12})>/)?.[1], tags[1]);
  assert.ok(dev.includes("2 |     return sum(xs) / len(xs)"));
  assert.ok(!dev.includes("plain words"));
  assert.ok(buildQuizPrompt({ ...input, mode: "student" }).includes("plain words"));
  assert.match(QUIZ_SYSTEM_PROMPT, /untrusted DATA/);
});
