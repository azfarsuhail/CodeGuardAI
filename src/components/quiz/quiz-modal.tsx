"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, CircleX, GraduationCap, Loader2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AttemptResponse, CreateQuizResponse } from "@/lib/quiz/quiz";
import { QuizCard, withInlineCode, type CheckedAnswer } from "./quiz-card";

type Phase = "loading" | "error" | "question" | "submitting" | "done";

// Fallbacks when the server sends no message; the server's own messages are preferred.
const STATUS_MESSAGE: Record<number, string> = {
  409: "The quiz is available once the review has finished.",
  422: "This review has no mistakes to quiz you on.",
  429: "This review has reached its limit of quizzes. Start a new review to get more.",
  503: "The AI tutor is unavailable right now. Try again in a minute.",
};
const RETRYABLE = new Set([0, 500, 502, 503, 504]);

class RequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new RequestError(0, "You appear to be offline. Check your connection and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new RequestError(res.status, data?.error?.message ?? STATUS_MESSAGE[res.status] ?? `Something went wrong (HTTP ${res.status}).`);
  return data as T;
}

/** FR-062 "Quiz me about my mistakes": a native modal that generates a quiz on this review, steps through it and grades it. */
export function QuizModal({ reviewId, studentMode }: { reviewId: string; studentMode: boolean }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [error, setError] = useState<{ message: string; retry: "generate" | "submit" | null } | null>(null);
  const [quiz, setQuiz] = useState<CreateQuizResponse | null>(null);
  const [step, setStep] = useState(0);
  const [checked, setChecked] = useState<(CheckedAnswer | null)[]>([]);
  const [attempt, setAttempt] = useState<AttemptResponse | null>(null);

  // Move focus to the step heading so keyboard and screen-reader users land on the new content.
  useEffect(() => {
    if (phase === "question" || phase === "done") heading.current?.focus();
  }, [phase, step]);

  async function generate() {
    setPhase("loading");
    setError(null);
    try {
      const q = await postJson<CreateQuizResponse>(`/api/reviews/${reviewId}/quiz`);
      setQuiz(q);
      setAttempt(null);
      setChecked(q.questions.map(() => null));
      setStep(0);
      setPhase("question");
    } catch (e) {
      const status = e instanceof RequestError ? e.status : 0;
      setError({ message: e instanceof Error ? e.message : "The quiz couldn't be created.", retry: RETRYABLE.has(status) ? "generate" : null });
      setPhase("error");
    }
  }

  async function submit() {
    if (!quiz) return;
    setPhase("submitting");
    setError(null);
    try {
      setAttempt(await postJson<AttemptResponse>(`/api/quizzes/${quiz.quiz_id}/attempts`, { answers: checked.map((c) => c?.answer ?? null) }));
      setPhase("done");
      router.refresh(); // the header's XP and badges are server-rendered
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : "Your answers couldn't be saved.", retry: "submit" });
      setPhase("error");
    }
  }

  function open() {
    dialog.current?.showModal(); // native modal: focus trap, Escape to close, inert background
    // Resume an unfinished quiz instead of spending one of the review's 3 quizzes on every open.
    if (!quiz && phase !== "loading") void generate();
  }

  function retake() {
    if (!quiz) return;
    setChecked(quiz.questions.map(() => null));
    setAttempt(null);
    setStep(0);
    setPhase("question");
  }

  const total = quiz?.questions.length ?? 0;
  const current = quiz?.questions[step];
  const isLast = step === total - 1;

  return (
    <>
      <Button type="button" variant="outline" onClick={open} className="h-10 px-4 font-bold">
        <GraduationCap aria-hidden />
        Quiz me on my mistakes
      </Button>

      <dialog
        ref={dialog}
        aria-labelledby="quiz-title"
        className="m-auto w-[min(94vw,40rem)] rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-[#16202b]/60"
      >
        <div className="flex max-h-[90vh] flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-border px-6 py-4">
            <div>
              <h2 id="quiz-title" className="font-display text-xl font-bold [font-stretch:90%]">
                Quiz: your mistakes
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {studentMode
                  ? "A few quick questions about the problems found in your code. There's no penalty for wrong answers."
                  : "Short questions on the findings in this review, to check the fixes stuck."}
              </p>
            </div>
            <Button type="button" variant="ghost" size="icon" onClick={() => dialog.current?.close()} aria-label="Close quiz">
              <X aria-hidden />
            </Button>
          </header>

          <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
            <div role="status" aria-live="polite" className="text-sm">
              {phase === "loading" && (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
                  Writing questions about your code. This usually takes 10 to 30 seconds.
                </p>
              )}
              {phase === "submitting" && (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
                  Scoring your answers…
                </p>
              )}
            </div>

            {phase === "error" && error && (
              <div className="flex flex-col gap-3">
                <p role="alert" className="rounded-lg border border-[#fda29b] bg-[#fef3f2] px-3 py-2 text-sm font-bold text-[#912018]">
                  {error.message}
                </p>
                {error.retry && (
                  <Button type="button" onClick={error.retry === "submit" ? submit : generate} className="h-10 self-start px-4 font-bold">
                    <RotateCcw aria-hidden />
                    Try again
                  </Button>
                )}
                {attempt && error.retry !== "submit" && (
                  <Button type="button" variant="outline" onClick={() => setPhase("done")} className="h-10 self-start px-4">
                    Back to your results
                  </Button>
                )}
              </div>
            )}

            {phase === "question" && quiz && current && (
              <>
                <div className="flex flex-col gap-2">
                  <h3 ref={heading} tabIndex={-1} className="text-sm font-bold text-muted-foreground outline-none">
                    Question {step + 1} of {total}
                  </h3>
                  <progress value={step + 1} max={total} aria-hidden className="h-1.5 w-full overflow-hidden rounded-full accent-primary" />
                </div>
                <QuizCard
                  key={`${quiz.quiz_id}-${step}`}
                  quizId={quiz.quiz_id}
                  question={current}
                  checked={checked[step]}
                  onChecked={(r) => setChecked((prev) => prev.map((c, i) => (i === step ? r : c)))}
                />
                {checked[step] && (
                  // The Check button just disappeared; keep keyboard focus inside the dialog on the next action.
                  <Button type="button" autoFocus onClick={isLast ? submit : () => setStep(step + 1)} className="h-10 self-end px-4 font-bold">
                    {isLast ? "See my score" : "Next question"}
                  </Button>
                )}
              </>
            )}

            {phase === "done" && quiz && attempt && (
              <div className="flex flex-col gap-4">
                <h3 ref={heading} tabIndex={-1} className="font-display text-2xl font-bold outline-none">
                  You scored {attempt.correct} of {attempt.total} ({attempt.score_pct}%)
                </h3>
                <p className="text-[15px]">
                  {attempt.score_pct === 100
                    ? "Every answer right. You understand these mistakes."
                    : studentMode
                      ? "Look over the ones you missed below. Each explanation says why the right answer is right."
                      : "Review the misses below; each explanation covers the reasoning."}
                </p>
                <ol className="divide-y divide-border rounded-xl border border-border" aria-label="Your answers">
                  {attempt.results.map((r) => {
                    const q = quiz.questions[r.index];
                    const chosen = checked[r.index]?.answer;
                    return (
                      <li key={r.index} className="flex flex-col gap-1 px-4 py-3 text-[15px]">
                        <p className={`flex items-center gap-2 text-sm font-bold ${r.correct ? "text-[#05603a]" : "text-[#912018]"}`}>
                          {r.correct ? <CircleCheck aria-hidden className="size-4" /> : <CircleX aria-hidden className="size-4" />}
                          Question {r.index + 1}: {r.correct ? "correct" : "incorrect"}
                        </p>
                        <p className="font-bold">{withInlineCode(q.question)}</p>
                        {!r.correct && chosen != null && <p>Your answer: {withInlineCode(q.options[chosen])}</p>}
                        <p>Correct answer: {withInlineCode(q.options[r.correct_index])}</p>
                        <p className="text-muted-foreground">{withInlineCode(r.explanation)}</p>
                      </li>
                    );
                  })}
                </ol>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="outline" onClick={retake} className="h-10">
                    <RotateCcw aria-hidden />
                    Retake this quiz
                  </Button>
                  <Button type="button" variant="outline" onClick={generate} className="h-10">
                    New questions
                  </Button>
                  <Button type="button" onClick={() => dialog.current?.close()} className="h-10 font-bold">
                    Done
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
