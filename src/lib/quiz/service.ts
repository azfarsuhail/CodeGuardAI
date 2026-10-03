import type { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { generateStructured, LlmUnavailableError } from "@/lib/ai/llm";
import { prisma } from "@/lib/prisma";
import { getReviewDetail, ReviewActionError } from "@/lib/reviews";
import { buildQuizPrompt, QUIZ_SYSTEM_PROMPT } from "./prompt";
import {
  aiQuizJsonSchema,
  checkAnswer,
  gradeAnswers,
  MAX_QUESTIONS,
  MIN_QUESTIONS,
  QuizQuestion,
  quizOutputSchema,
  sanitizeQuestions,
  shuffleOptions,
  toPublicQuestions,
  type AttemptResponse,
  type CheckRequest,
  type CheckResponse,
  type CreateQuizResponse,
} from "./quiz";

export const MAX_QUIZZES_PER_REVIEW = 3;
export const QUIZ_DEADLINE_MS = 45_000;
const MAX_PROMPT_FINDINGS = 15; // most severe first (getReviewDetail sorts by severity); keeps the prompt small

/** Parses a small JSON body, refusing oversized payloads before reading them where the client declares the size. */
export async function readJsonBody<T>(req: Request, schema: z.ZodType<T>, maxBytes = 2048): Promise<T> {
  const tooLarge = () => new ReviewActionError(413, "payload_too_large", "The request body is too large.");
  if (Number(req.headers.get("content-length")) > maxBytes) throw tooLarge();
  const text = await req.text();
  if (text.length > maxBytes) throw tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ReviewActionError(400, "invalid_json", "The request body must be valid JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ReviewActionError(400, "validation_failed", parsed.error.issues[0].message);
  return parsed.data;
}

export async function createQuiz(reviewId: string, viewerId: string | null): Promise<CreateQuizResponse> {
  const review = await getReviewDetail(reviewId, viewerId);
  if (!review) throw new ReviewActionError(404, "not_found", "No review exists with that id.");
  if (review.status !== "completed") throw new ReviewActionError(409, "not_ready", "The quiz is available once the review has finished.");
  const findings = review.findings.filter((f) => f.status !== "false_positive").slice(0, MAX_PROMPT_FINDINGS);
  if (!findings.length) throw new ReviewActionError(422, "no_findings", "This review has no mistakes to quiz you on. Nice work!");
  // ponytail: count-then-create can overshoot the cap by a concurrent request or two; fine for an abuse cap.
  if ((await prisma.quiz.count({ where: { reviewId } })) >= MAX_QUIZZES_PER_REVIEW)
    throw new ReviewActionError(429, "limit_reached", `This review already has ${MAX_QUIZZES_PER_REVIEW} quizzes. Start a new review to get more.`);

  const refs = new Set(findings.map((f) => f.id));
  const result = await generateStructured({
    system: QUIZ_SYSTEM_PROMPT,
    user: buildQuizPrompt({
      code: review.original_code,
      language: review.language,
      fileName: review.file_name,
      mode: review.mode,
      findings,
      questionCount: Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, findings.length)),
    }),
    schema: quizOutputSchema(refs),
    jsonSchema: aiQuizJsonSchema,
    deadlineMs: QUIZ_DEADLINE_MS,
  }).catch((e: unknown) => {
    if (e instanceof LlmUnavailableError) {
      console.error(`[review ${reviewId}] quiz unavailable:`, e.message);
      throw new ReviewActionError(503, "ai_unavailable", "The AI tutor is unavailable right now, so the quiz couldn't be created. Try again in a minute.");
    }
    throw e;
  });

  const questions = sanitizeQuestions(result.data.questions, refs).map((q) => shuffleOptions(q));
  const quiz = await prisma.quiz.create({
    data: { reviewId, questions: questions as unknown as Prisma.InputJsonValue, model: result.model },
    select: { id: true },
  });
  return { quiz_id: quiz.id, questions: toPublicQuestions(questions) };
}

/** Access goes through the quiz's review: missing quiz and someone else's review both look like 404. */
async function loadQuestions(quizId: string, viewerId: string | null): Promise<QuizQuestion[]> {
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId }, select: { reviewId: true, questions: true } });
  if (!quiz || !(await getReviewDetail(quiz.reviewId, viewerId))) throw new ReviewActionError(404, "not_found", "No quiz exists with that id.");
  return QuizQuestion.array().parse(quiz.questions);
}

export async function checkQuizAnswer(quizId: string, viewerId: string | null, body: CheckRequest): Promise<CheckResponse> {
  const questions = await loadQuestions(quizId, viewerId);
  const q = questions[body.question_index];
  if (!q) throw new ReviewActionError(400, "validation_failed", `question_index must be below ${questions.length}.`);
  const { correct, correct_index, explanation } = checkAnswer(q, body.question_index, body.answer_index);
  return { correct, correct_index, explanation };
}

export async function submitAttempt(quizId: string, viewerId: string | null, answers: (number | null)[]): Promise<AttemptResponse> {
  const questions = await loadQuestions(quizId, viewerId);
  if (answers.length !== questions.length)
    throw new ReviewActionError(400, "validation_failed", `answers must have exactly ${questions.length} entries.`);
  const graded = gradeAnswers(questions, answers);

  const { id, first } = await prisma.$transaction(async (tx) => {
    let first = true;
    if (viewerId) {
      // Serialises concurrent submissions by the same user for this quiz, so only one can be the first attempt.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quiz:${quizId}:${viewerId}`}))`;
      first = (await tx.quizAttempt.count({ where: { quizId, userId: viewerId } })) === 0;
    }
    const row = await tx.quizAttempt.create({
      // Unanswered questions are stored as -1 to keep the column a plain number[].
      data: { quizId, userId: viewerId, answers: answers.map((a) => a ?? -1), correct: graded.correct, total: graded.total },
      select: { id: true },
    });
    return { id: row.id, first };
  });
  return { attempt_id: id, first_attempt: first, ...graded };
}
