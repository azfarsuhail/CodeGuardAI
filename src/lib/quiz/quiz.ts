import { z } from "zod";

// FR-062 "Quiz me about my mistakes". Pure logic only (no DB, no network) so it is unit-testable.

export const MIN_QUESTIONS = 3;
export const MAX_QUESTIONS = 5;
export const MAX_EXPLANATION_WORDS = 80;

export const QuizQuestion = z.object({
  question: z.string().min(10).max(500).describe("Asks about one of the user's own mistakes in this code"),
  options: z.array(z.string().min(1).max(240)).length(4).describe("Exactly 4 distinct answer options"),
  correct_index: z.int().min(0).max(3).describe("0-based index of the correct option"),
  explanation: z.string().min(1).max(900).describe(`Why the correct option is right, at most ${MAX_EXPLANATION_WORDS} words`),
  finding_ref: z.string().max(20).describe('Id of the finding this question tests, e.g. "F-0001"'),
  concept: z.string().min(1).max(60).describe('Short topic name, e.g. "SQL injection"'),
});
export type QuizQuestion = z.infer<typeof QuizQuestion>;

export const AiQuizOutput = z.object({ questions: z.array(QuizQuestion).min(MIN_QUESTIONS).max(MAX_QUESTIONS) });
export const aiQuizJsonSchema = z.toJSONSchema(AiQuizOutput);

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Why a question is unusable for this review, or null when it is fine. */
export function questionProblem(q: QuizQuestion, refs: ReadonlySet<string>): string | null {
  if (!refs.has(q.finding_ref)) return `finding_ref "${q.finding_ref}" is not one of the listed findings`;
  if (new Set(q.options.map(norm)).size !== q.options.length) return "options must be 4 distinct answers";
  return null;
}

const truncateWords = (s: string, max: number) => {
  const words = s.trim().split(/\s+/);
  return words.length <= max ? s.trim() : `${words.slice(0, max).join(" ")}…`;
};

/** Repairs what can be repaired (whitespace, long explanations), drops invalid or duplicate questions, caps the count. */
export function sanitizeQuestions(questions: QuizQuestion[], refs: ReadonlySet<string>): QuizQuestion[] {
  const seen = new Set<string>();
  const out: QuizQuestion[] = [];
  for (const raw of questions) {
    const q: QuizQuestion = {
      question: raw.question.trim(),
      options: raw.options.map((o) => o.trim()),
      correct_index: raw.correct_index,
      explanation: truncateWords(raw.explanation, MAX_EXPLANATION_WORDS),
      finding_ref: raw.finding_ref.trim(),
      concept: raw.concept.trim(),
    };
    if (questionProblem(q, refs) || seen.has(norm(q.question))) continue;
    seen.add(norm(q.question));
    out.push(q);
  }
  return out.slice(0, MAX_QUESTIONS);
}

/** LLM output schema for one review: rejects (and so triggers the client's one retry) when fewer than 3 usable questions remain. */
export function quizOutputSchema(refs: ReadonlySet<string>) {
  return AiQuizOutput.superRefine((o, ctx) => {
    if (sanitizeQuestions(o.questions, refs).length >= MIN_QUESTIONS) return;
    o.questions.forEach((q, i) => {
      const problem = questionProblem(q, refs);
      if (problem) ctx.addIssue({ code: "custom", path: ["questions", i], message: problem });
    });
    ctx.addIssue({ code: "custom", path: ["questions"], message: `Need at least ${MIN_QUESTIONS} valid, distinct questions.` });
  });
}

/** Models favour putting the answer first; shuffle so position carries no signal. */
export function shuffleOptions(q: QuizQuestion, random: () => number = Math.random): QuizQuestion {
  const order = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { ...q, options: order.map((i) => q.options[i]), correct_index: order.indexOf(q.correct_index) };
}

export type PublicQuestion = { index: number; question: string; options: string[]; concept: string; finding_ref: string };

/** What the client may see before answering. Fields are picked explicitly so answers can never leak via a spread. */
export function toPublicQuestions(questions: QuizQuestion[]): PublicQuestion[] {
  return questions.map((q, index) => ({ index, question: q.question, options: [...q.options], concept: q.concept, finding_ref: q.finding_ref }));
}

export type QuestionResult = { index: number; correct: boolean; correct_index: number; explanation: string };

export function checkAnswer(q: QuizQuestion, index: number, answer: number | null): QuestionResult {
  return { index, correct: answer === q.correct_index, correct_index: q.correct_index, explanation: q.explanation };
}

export function gradeAnswers(questions: QuizQuestion[], answers: (number | null)[]) {
  const results = questions.map((q, i) => checkAnswer(q, i, answers[i] ?? null));
  const correct = results.filter((r) => r.correct).length;
  const total = questions.length;
  return { correct, total, score_pct: total ? Math.round((correct / total) * 100) : 0, results };
}

// Request bodies.
export const CheckRequest = z.object({
  question_index: z.int().min(0).max(MAX_QUESTIONS - 1),
  answer_index: z.int().min(0).max(3),
});
export const AttemptRequest = z.object({
  answers: z.array(z.int().min(0).max(3).nullable()).min(1).max(MAX_QUESTIONS),
});
export type CheckRequest = z.infer<typeof CheckRequest>;
export type AttemptRequest = z.infer<typeof AttemptRequest>;

// Response shapes (shared with the client components).
export type CreateQuizResponse = { quiz_id: string; questions: PublicQuestion[] };
export type CheckResponse = Omit<QuestionResult, "index">;
export type AttemptResponse = {
  attempt_id: string;
  correct: number;
  total: number;
  score_pct: number;
  first_attempt: boolean;
  results: QuestionResult[];
};
