"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Flag, GraduationCap, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Finding, FindingStatus } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { CATEGORY, SEVERITY, SafetyBadge, SeverityBadge, SourceBadge } from "./badges";

type Props = {
  finding: Finding;
  /** Secret-masked submitted code, used to show the cited lines. */
  code: string;
  studentMode: boolean;
  /** Concept primers exist on the page (Student Mode) to link to. */
  hasPrimers: boolean;
  /** False while the AI stage is still running: refs are provisional, so actions wait. */
  interactive: boolean;
  onStatusChange: (ref: string, status: FindingStatus) => Promise<void>;
};

const MAX_SNIPPET_LINES = 12;

const squash = (s: string) => s.replace(/[\s.`]+/g, " ").trim().toLowerCase();
const same = (a: string, b: string) => squash(a) === squash(b);

function cweUrl(cwe: string) {
  const n = /CWE-(\d+)/.exec(cwe)?.[1];
  return n ? `https://cwe.mitre.org/data/definitions/${n}.html` : null;
}

function Snippet({ code, start, end, label }: { code: string; start: number; end: number; label: string }) {
  const lines = code.split("\n").slice(start - 1, Math.min(end, start - 1 + MAX_SNIPPET_LINES));
  const width = String(start + lines.length).length;
  return (
    <figure className="overflow-hidden rounded-lg bg-sheet">
      <figcaption className="border-b border-sheet-line px-3 py-1.5 text-xs text-sheet-muted">{label}</figcaption>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[13px] leading-6 text-[#e6edf3]">
        {lines.map((l, i) => (
          <div key={i}>
            <span aria-hidden className="mr-3 inline-block text-right text-[#5c7088] select-none" style={{ width: `${width}ch` }}>
              {start + i}
            </span>
            {l || " "}
          </div>
        ))}
      </pre>
    </figure>
  );
}

export function FindingCard({ finding: f, code, studentMode, hasPrimers, interactive, onStatusChange }: Props) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Category = CATEGORY[f.category];
  const dismissed = f.status === "false_positive";
  const lineRef = f.location.start_line === f.location.end_line ? `${f.location.start_line}` : `${f.location.start_line}-${f.location.end_line}`;
  const headingId = `finding-${f.id}`;

  async function copyFix() {
    try {
      await navigator.clipboard.writeText(f.fix_code ?? f.fix);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy. Select the fix text and copy it manually.");
    }
  }

  async function setStatus(status: FindingStatus) {
    setBusy(true);
    setError(null);
    try {
      await onStatusChange(f.id, status);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update this finding. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      aria-labelledby={headingId}
      className={cn("rounded-xl border border-l-4 border-border bg-card shadow-[0_1px_2px_rgb(22_32_43/0.06)]", SEVERITY[f.severity].edge, dismissed && "opacity-70")}
    >
      <header className="flex flex-col gap-2 px-4 pt-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <SeverityBadge severity={f.severity} />
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Category.icon aria-hidden className="size-4" />
            {Category.label}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {f.location.file}:{lineRef}
          </span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">{f.id}</span>
        </div>
        <h3 id={headingId} className={cn("text-lg leading-snug font-bold", dismissed && "line-through decoration-1")}>
          {f.title}
        </h3>
        {dismissed && <p className="text-sm font-bold text-muted-foreground">Marked as a false positive. It no longer counts toward the scores.</p>}
      </header>

      <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
        <dl className="grid gap-3 text-[15px]">
          {/* Static findings' message is also their title; models sometimes repeat problem as why. Don't show text twice. */}
          {same(f.problem, f.title) ? null : (
            <div>
              <dt className="text-sm font-bold">Problem</dt>
              <dd>{f.problem}</dd>
            </div>
          )}
          {same(f.why, f.problem) ? null : (
            <div>
              <dt className="text-sm font-bold">Why it matters</dt>
              <dd>{f.why}</dd>
            </div>
          )}
          <div>
            <dt className="text-sm font-bold">Fix</dt>
            <dd>{f.fix}</dd>
          </div>
        </dl>

        <div className={cn("grid gap-3", f.fix_code && "lg:grid-cols-2")}>
          <Snippet code={code} start={f.location.start_line} end={f.location.end_line} label={`Your code, line ${lineRef}`} />
          {f.fix_code && (
            <figure className="overflow-hidden rounded-lg bg-sheet">
              <figcaption className="border-b border-sheet-line px-3 py-1.5 text-xs text-sheet-muted">Suggested change</figcaption>
              <pre className="overflow-x-auto px-3 py-2 font-mono text-[13px] leading-6 text-[#e6edf3]">{f.fix_code.replace(/\n$/, "")}</pre>
            </figure>
          )}
        </div>

        {studentMode && f.student_explanation && (
          <aside className="rounded-lg border border-[#e9d77f] bg-[#fdf6d8] px-4 py-3">
            <p className="flex items-center gap-1.5 text-sm font-bold">
              <GraduationCap aria-hidden className="size-4" />
              In plain words
            </p>
            <p className="mt-1 text-[15px]">{f.student_explanation}</p>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {hasPrimers && (
                <a href="#concepts" className="font-bold text-primary underline underline-offset-4">
                  Read the concepts behind this
                </a>
              )}
              {f.cwe && cweUrl(f.cwe) && (
                <a href={cweUrl(f.cwe)!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-bold text-primary underline underline-offset-4">
                  What is {f.cwe}?
                  <ExternalLink aria-hidden className="size-3.5" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              )}
            </p>
          </aside>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 sm:px-5">
        <SourceBadge source={f.source} confidence={f.confidence} />
        <SafetyBadge safety={f.fix_safety} />
        {f.cwe && !studentMode && cweUrl(f.cwe) && (
          <a href={cweUrl(f.cwe)!} target="_blank" rel="noreferrer" className="text-xs font-bold text-primary underline underline-offset-4">
            {f.cwe}
            {f.owasp ? `, ${f.owasp}` : ""}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        {!interactive && <span className="text-xs text-muted-foreground italic">AI explanation on the way</span>}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={copyFix} disabled={dismissed}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? "Copied" : "Copy fix"}
          </Button>
          {dismissed ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setStatus("open")} disabled={!interactive || busy}>
              <Undo2 aria-hidden />
              Undo
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setStatus("false_positive")} disabled={!interactive || busy}>
              <Flag aria-hidden />
              Mark as false positive
            </Button>
          )}
        </div>
        <p role="status" className="w-full text-sm text-destructive empty:hidden">
          {error}
        </p>
        <span className="sr-only" role="status">
          {copied ? "Fix copied to the clipboard" : ""}
        </span>
      </footer>
    </article>
  );
}
