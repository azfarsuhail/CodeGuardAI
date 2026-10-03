"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, CircleCheck, Copy, Download, Loader2, Save, TriangleAlert, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { applyFixes, defaultSelection, isApplicable } from "@/lib/fixes";
import { FixVersionDetail, type Finding, type FixSafety, type ReviewDetail } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { SAFETY, SafetyBadge, SeverityBadge } from "./badges";
import { CodeDiff, downloadText, fixedFileName, useWide } from "./code-diff";

export function FixView({ review }: { review: ReviewDetail }) {
  // The submitted code. Never written to: every fix produces a separate string (FR-051).
  const original = review.original_code;
  const findings = review.findings;
  const [selected, setSelected] = useState<Set<string>>(() => defaultSelection(findings));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<FixVersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const wide = useWide();

  const plan = useMemo(() => applyFixes(original, findings, selected), [original, findings, selected]);
  const skippedById = new Map(plan.skipped.map((s) => [s.finding_ref, s.reason]));
  const group = (safety: FixSafety) => findings.filter((f) => f.fix_safety === safety && (safety === "manual_only" ? f.status !== "false_positive" : isApplicable(f)));
  const safe = group("safe");
  const review_ = group("needs_review");
  const manual = group("manual_only");
  const noCodeFix = findings.filter((f) => f.fix_safety !== "manual_only" && f.status !== "false_positive" && !f.fix_code).length;
  // A saved version only describes the preview if the selection hasn't changed since.
  const savedMatches = saved !== null && saved.code === plan.code;

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/reviews/${review.id}/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ finding_ids: plan.applied.map((c) => c.finding_ref) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `Saving failed (HTTP ${res.status}).`);
      setSaved(FixVersionDetail.parse(body));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Saving failed. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(plan.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy to the clipboard. Use Download instead.");
    }
  }

  const download = () => downloadText(plan.code, fixedFileName(review.file_name, "fixed"));

  const item = (f: Finding, selectable: boolean) => {
    const reason = skippedById.get(f.id);
    return (
      <li key={f.id} className="flex gap-3 px-4 py-3">
        {selectable ? (
          <Checkbox
            id={`fix-${f.id}`}
            checked={selected.has(f.id)}
            onCheckedChange={(on) => toggle(f.id, on === true)}
            className="mt-1 border-input bg-card"
            aria-describedby={`fix-${f.id}-desc`}
          />
        ) : (
          <span aria-hidden className="mt-1 size-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <label htmlFor={selectable ? `fix-${f.id}` : undefined} className="flex flex-wrap items-center gap-2 font-bold">
            <SeverityBadge severity={f.severity} />
            {f.title}
          </label>
          <p id={`fix-${f.id}-desc`} className="mt-1 text-sm text-muted-foreground">
            <span className="font-mono text-xs">
              {f.id}, line {f.location.start_line}
            </span>{" "}
            {f.fix}
          </p>
          {reason && selected.has(f.id) && (
            <p className="mt-1 flex items-center gap-1 text-sm font-bold text-[#93370d]">
              <TriangleAlert aria-hidden className="size-3.5" />
              Not applied: {reason}
            </p>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <Link href={`/reviews/${review.id}`} className="inline-flex w-fit items-center gap-1 text-sm font-bold underline-offset-4 hover:underline">
          <ArrowLeft aria-hidden className="size-4" />
          Back to the review
        </Link>
        <h1 className="font-display text-[clamp(1.875rem,1.4rem+2vw,2.75rem)] leading-tight font-bold tracking-[-0.02em] [font-stretch:88%]">
          Fix <span className="font-mono text-[0.8em] font-normal tracking-normal">{review.file_name}</span>
        </h1>
        <p className="max-w-[70ch] text-muted-foreground">
          Choose which fixes to apply and compare the result with your code. Applying fixes builds a new version; your original stays exactly as you
          submitted it.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(320px,380px)_1fr]">
        <aside aria-label="Fixes to apply" className="flex flex-col gap-5">
          <Button type="button" size="lg" className="h-11 font-bold" onClick={() => setSelected(defaultSelection(findings))}>
            <Wand2 aria-hidden />
            Fix all safe issues
          </Button>

          <section aria-labelledby="safe-heading" className="flex flex-col gap-2">
            <h2 id="safe-heading" className="flex flex-wrap items-center gap-2 text-sm font-bold">
              <SafetyBadge safety="safe" />
              Applied by default
            </h2>
            {safe.length ? (
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">{safe.map((f) => item(f, true))}</ul>
            ) : (
              <p className="text-sm text-muted-foreground">No safe fixes with code were suggested.</p>
            )}
          </section>

          <section aria-labelledby="review-heading" className="flex flex-col gap-2">
            <h2 id="review-heading" className="flex flex-wrap items-center gap-2 text-sm font-bold">
              <SafetyBadge safety="needs_review" />
              Opt in one by one
            </h2>
            <p className="text-sm text-muted-foreground">{SAFETY.needs_review.description} Check the diff before saving.</p>
            {review_.length ? (
              <ul className="divide-y divide-border rounded-xl border border-[#e9d77f] bg-[#fffbeb]">{review_.map((f) => item(f, true))}</ul>
            ) : (
              <p className="text-sm text-muted-foreground">None.</p>
            )}
          </section>

          {manual.length > 0 && (
            <section aria-labelledby="manual-heading" className="flex flex-col gap-2">
              <h2 id="manual-heading" className="flex flex-wrap items-center gap-2 text-sm font-bold">
                <SafetyBadge safety="manual_only" />
                Suggestions only
              </h2>
              <p className="text-sm text-muted-foreground">{SAFETY.manual_only.description}</p>
              <ul className="divide-y divide-border rounded-xl border border-border bg-card/70">{manual.map((f) => item(f, false))}</ul>
            </section>
          )}

          {noCodeFix > 0 && (
            <p className="text-sm text-muted-foreground">
              {noCodeFix} {noCodeFix === 1 ? "finding has" : "findings have"} guidance but no code-level fix. See them in the review.
            </p>
          )}
        </aside>

        <section aria-labelledby="diff-heading" className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="diff-heading" className="font-bold">
              {plan.applied.length} {plan.applied.length === 1 ? "change" : "changes"} applied
              <span className="font-normal text-muted-foreground"> (original on the {wide ? "left" : "top"}, fixed version on the {wide ? "right" : "bottom"})</span>
            </h2>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={copy} disabled={!plan.applied.length}>
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button type="button" variant="outline" onClick={download} disabled={!plan.applied.length}>
                <Download aria-hidden />
                Download
              </Button>
              <Button type="button" onClick={save} disabled={!plan.applied.length || saving || savedMatches} aria-busy={saving} className="font-bold">
                {saving ? <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Save aria-hidden />}
                {savedMatches ? "Saved" : saving ? "Validating…" : "Save as new version"}
              </Button>
            </div>
          </div>

          <div role="status" aria-live="polite">
            {savedMatches && saved.validated && (
              <p className="flex items-center gap-2 rounded-xl border border-[#75e0a7] bg-[#ecfdf3] px-4 py-3 text-sm font-bold text-[#05603a]">
                <CircleCheck aria-hidden className="size-4" />
                Validated: the new version parses and introduces no new static-analysis issues.
              </p>
            )}
            {savedMatches && !saved.validated && (
              <div className="rounded-xl border border-[#fda29b] bg-[#fef3f2] px-4 py-3 text-sm text-[#912018]">
                <p className="flex items-center gap-2 font-bold">
                  <TriangleAlert aria-hidden className="size-4" />
                  Saved, but the new version introduces {saved.validation_errors.length}{" "}
                  {saved.validation_errors.length === 1 ? "issue" : "issues"}. Fix these before using it:
                </p>
                <ul className="mt-2 list-disc pl-6">
                  {saved.validation_errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
            {copied && <span className="sr-only">Fixed code copied to the clipboard</span>}
          </div>
          {error && (
            <p role="alert" className="text-sm font-bold text-destructive">
              {error}
            </p>
          )}

          <CodeDiff original={original} modified={plan.code} language={review.language} modifiedLabel="Fixed version of the code" />

          {plan.applied.length > 0 && (
            <details className="text-sm">
              <summary className="w-fit cursor-pointer font-bold underline-offset-4 hover:underline">Changes in this version</summary>
              <ol className="mt-2 grid gap-1">
                {plan.applied.map((c) => (
                  <li key={c.finding_ref} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{c.finding_ref}</span>
                    <span className={cn("font-mono text-xs text-muted-foreground")}>
                      lines {c.start_line}-{c.end_line}
                    </span>
                    {c.title}
                    <SafetyBadge safety={c.safety} />
                  </li>
                ))}
                {plan.addedImports.map((i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">Added import</span>
                    <code className="font-mono text-[13px]">{i}</code>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </section>
      </div>
    </div>
  );
}
