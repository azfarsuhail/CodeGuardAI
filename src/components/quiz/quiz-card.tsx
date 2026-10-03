"use client";

import { useId, useState, type ReactNode } from "react";
import { CircleCheck, CircleX, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CheckResponse, PublicQuestion } from "@/lib/quiz/quiz";
import { cn } from "@/lib/utils";

export type CheckedAnswer = CheckResponse & { answer: number };

/** Renders `backtick` spans from the model as inline code; everything else stays plain text. */
export function withInlineCode(text: string): ReactNode[] {
  return text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 ? (
      <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/**
 * FR-062: one quiz question. Options are a native radio group (arrow keys move between them); "Check answer" asks the
 * server, then the card locks and shows the result with icon + text and the explanation.
 */
export function QuizCard({
  quizId,
  question,
  checked,
  onChecked,
}: {
  quizId: string;
  question: PublicQuestion;
  checked: CheckedAnswer | null;
  onChecked: (result: CheckedAnswer) => void;
}) {
  const id = useId();
  const [selected, setSelected] = useState<number | null>(checked?.answer ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = checked !== null;

  async function check() {
    if (selected === null || locked) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/quizzes/${quizId}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question_index: question.index, answer_index: selected }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `Checking failed (HTTP ${res.status}).`);
      onChecked({ ...(body as CheckResponse), answer: selected });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checking failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-3" aria-describedby={`${id}-meta`}>
        <legend className="mb-1 text-[17px] font-bold leading-snug">{withInlineCode(question.question)}</legend>
        <p id={`${id}-meta`} className="text-xs text-muted-foreground">
          Topic: {question.concept} · about finding <span className="font-mono">{question.finding_ref}</span>
        </p>
        {question.options.map((option, i) => {
          const isCorrect = locked && i === checked.correct_index;
          const isWrongPick = locked && i === checked.answer && !checked.correct;
          return (
            <label
              key={i}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-[15px] transition-colors",
                "has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/40",
                !locked && "hover:bg-muted has-[:checked]:border-primary has-[:checked]:bg-primary/5",
                locked && "cursor-default",
                isCorrect && "border-[#75e0a7] bg-[#ecfdf3] text-[#05603a]",
                isWrongPick && "border-[#fda29b] bg-[#fef3f2] text-[#912018]",
              )}
            >
              <input
                type="radio"
                name={`${id}-option`}
                value={i}
                checked={selected === i}
                onChange={() => setSelected(i)}
                disabled={locked || busy}
                className="mt-1 size-4 shrink-0 accent-primary"
              />
              <span className="flex-1">{withInlineCode(option)}</span>
              {isCorrect && (
                <span className="flex shrink-0 items-center gap-1 text-sm font-bold">
                  <CircleCheck aria-hidden className="size-4" /> Correct answer
                </span>
              )}
              {isWrongPick && (
                <span className="flex shrink-0 items-center gap-1 text-sm font-bold">
                  <CircleX aria-hidden className="size-4" /> Your answer
                </span>
              )}
            </label>
          );
        })}
      </fieldset>

      {!locked && (
        <Button type="button" onClick={check} disabled={selected === null || busy} aria-busy={busy} className="h-10 self-start px-4 font-bold">
          {busy && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
          {busy ? "Checking…" : "Check answer"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm font-bold text-destructive">
          {error}
        </p>
      )}

      <div aria-live="polite">
        {locked && (
          <div
            className={cn(
              "rounded-xl border px-4 py-3 text-[15px]",
              checked.correct ? "border-[#75e0a7] bg-[#ecfdf3] text-[#05603a]" : "border-[#fda29b] bg-[#fef3f2] text-[#912018]",
            )}
          >
            <p className="flex items-center gap-2 font-bold">
              {checked.correct ? <CircleCheck aria-hidden className="size-4" /> : <CircleX aria-hidden className="size-4" />}
              {checked.correct ? "Correct!" : <span>Not quite. The correct answer is: {withInlineCode(question.options[checked.correct_index])}</span>}
            </p>
            <p className="mt-1 text-foreground">{withInlineCode(checked.explanation)}</p>
          </div>
        )}
      </div>
    </div>
  );
}
