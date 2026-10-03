"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, FileDown, Loader2, Wand2 } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isApplicable } from "@/lib/fixes";
import { LANGUAGES } from "@/lib/languages";
import { ReviewDetail, type Finding, type FindingStatus, type FixSafety, type ScoreKey, type Severity } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { SAFETY, SEVERITY, SEVERITY_ORDER, SafetyBadge, SeverityBadge } from "./badges";
import { FindingCard } from "./finding-card";
import { ImprovePanel } from "./improve-panel";
import { QuizModal } from "@/components/quiz/quiz-modal";

const POLL_MS = 2000;

type TabKey = "bugs" | "security" | "performance" | "quality" | "complexity" | "improvements";
const FINDING_TABS: { value: TabKey; label: string; match: (f: Finding) => boolean }[] = [
  { value: "bugs", label: "Bugs", match: (f) => f.category === "bug" },
  { value: "security", label: "Security", match: (f) => f.category === "security" },
  { value: "performance", label: "Performance", match: (f) => f.category === "performance" },
  { value: "quality", label: "Quality", match: (f) => f.category === "quality" },
];

const SCORES: { key: ScoreKey; label: string }[] = [
  { key: "quality", label: "Quality" },
  { key: "security", label: "Security" },
  { key: "performance", label: "Performance" },
  { key: "maintainability", label: "Maintainability" },
];

const band = (n: number) => (n >= 85 ? "bg-[#12b76a]" : n >= 60 ? "bg-[#e9b308]" : "bg-[#d92d20]");

async function apiMessage(res: Response) {
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? `Request failed (HTTP ${res.status}).`;
}

export function ReviewView({ initial }: { initial: ReviewDetail }) {
  const [review, setReview] = useState(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [tab, setTab] = useState<TabKey | null>(null);
  const [severities, setSeverities] = useState<string[]>(SEVERITY_ORDER);
  const done = review.status === "completed" || review.status === "failed";

  // Poll until the background AI stage finishes (PRD 10.1: static results first, AI results replace them).
  useEffect(() => {
    if (done) return;
    let cancelled = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`/api/reviews/${review.id}`, { cache: "no-store" });
        if (!res.ok) throw new Error(await apiMessage(res));
        const next = ReviewDetail.parse(await res.json());
        if (cancelled) return;
        failures = 0;
        setPollError(null);
        setReview(next);
        if (next.status === "completed") {
          setAnnouncement(
            next.static_only
              ? `Review complete with static-analysis results only. ${next.findings.length} findings.`
              : `AI review complete. ${next.findings.length} findings.`,
          );
          return;
        }
      } catch (e) {
        if (cancelled) return;
        if (++failures >= 3) setPollError(e instanceof Error ? e.message : "Lost contact with the server.");
      }
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [done, review.id]);

  const visible = useMemo(() => review.findings.filter((f) => severities.includes(f.severity)), [review.findings, severities]);
  const maintainability = visible.filter((f) => f.category === "maintainability");
  const studentMode = review.mode === "student";
  const fixable = review.findings.filter(isApplicable);

  // Open on the tab holding the most severe finding until the user picks one.
  const [mostSevere] = FINDING_TABS.map((t) => ({
    value: t.value,
    rank: Math.min(99, ...review.findings.filter(t.match).map((f) => SEVERITY_ORDER.indexOf(f.severity))),
  })).sort((a, b) => a.rank - b.rank);
  const defaultTab: TabKey =
    mostSevere.rank < 99 ? mostSevere.value : review.findings.some((f) => f.category === "maintainability") ? "complexity" : "bugs";
  const activeTab = tab ?? defaultTab;

  async function onStatusChange(ref: string, status: FindingStatus) {
    const previous = review;
    setReview((r) => ({ ...r, findings: r.findings.map((f) => (f.id === ref ? { ...f, status } : f)) }));
    const res = await fetch(`/api/reviews/${review.id}/findings/${encodeURIComponent(ref)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      setReview(previous);
      throw new Error(await apiMessage(res));
    }
    const { scores } = await res.json();
    setReview((r) => ({ ...r, scores }));
  }

  const cardProps = { code: review.original_code, studentMode, hasPrimers: review.concept_primers.length > 0, interactive: done, onStatusChange };
  const list = (findings: Finding[], empty: string) =>
    findings.length ? (
      <ol className="flex flex-col gap-4">
        {findings.map((f) => (
          <li key={f.id}>
            <FindingCard finding={f} {...cardProps} />
          </li>
        ))}
      </ol>
    ) : (
      <p className="rounded-xl border border-dashed border-border bg-card/60 px-5 py-8 text-center text-muted-foreground">{empty}</p>
    );
  const emptyText = (what: string) =>
    severities.length < SEVERITY_ORDER.length ? `No ${what} at the selected severities.` : `No ${what} found.`;

  const findingById = new Map(review.findings.map((f) => [f.id, f]));

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <Link href="/" className="inline-flex w-fit items-center gap-1 text-sm font-bold underline-offset-4 hover:underline">
          <ArrowLeft aria-hidden className="size-4" />
          New review
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[clamp(1.875rem,1.4rem+2vw,2.75rem)] leading-tight font-bold tracking-[-0.02em] [font-stretch:88%]">
              Review of <span className="font-mono text-[0.8em] font-normal tracking-normal">{review.file_name}</span>
            </h1>
            <p className="mt-1 flex flex-wrap gap-x-4 text-sm text-muted-foreground">
              <span>{LANGUAGES[review.language].label}</span>
              <span>{studentMode ? "Student mode" : "Developer mode"}</span>
              <span>{review.metrics ? `${review.metrics.loc} lines of code` : ""}</span>
              <time dateTime={review.created_at} suppressHydrationWarning>
                {new Date(review.created_at).toLocaleString()}
              </time>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* A plain link: the browser downloads the Markdown the route returns as an attachment. */}
            <a
              href={`/api/reviews/${review.id}/export?format=md`}
              download
              aria-disabled={!done}
              className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 bg-card px-4 font-bold", !done && "pointer-events-none opacity-50")}
            >
              <FileDown aria-hidden />
              Download report
            </a>
            <Link
              href={`/reviews/${review.id}/fix`}
              aria-disabled={!done || fixable.length === 0}
              className={cn(buttonVariants({ size: "lg" }), "h-11 px-5 font-bold", (!done || fixable.length === 0) && "pointer-events-none opacity-50")}
            >
              <Wand2 aria-hidden />
              Fix code
            </Link>
          </div>
        </div>
      </header>

      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {!done && (
        <div role="status" className="flex items-start gap-3 rounded-xl border-l-4 border-highlighter bg-sheet px-4 py-3 text-white">
          <Loader2 aria-hidden className="mt-0.5 size-5 shrink-0 animate-spin text-highlighter motion-reduce:animate-none" />
          <p>
            <span className="font-bold">The AI reviewer is reading your code.</span>{" "}
            <span className="text-sheet-muted">Verified static-analysis findings are shown now; explanations, extra findings and fixes appear here automatically.</span>
          </p>
        </div>
      )}
      {pollError && (
        <p role="alert" className="rounded-xl border border-destructive/40 bg-[#fee4e2] px-4 py-3 text-sm font-bold text-[#912018]">
          Still waiting for results: {pollError} Retrying automatically.
        </p>
      )}
      {review.notice && (
        <p role="note" className="flex items-start gap-2 rounded-xl border border-[#e9d77f] bg-[#fdf6d8] px-4 py-3 text-sm">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          {review.notice}
        </p>
      )}

      {review.scores && (
        <section aria-labelledby="scores-heading" className="flex flex-col gap-3">
          <h2 id="scores-heading" className="sr-only">
            Scores
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="col-span-2 flex flex-col justify-between rounded-xl bg-sheet p-4 text-white sm:col-span-1">
              <p className="text-sm text-sheet-muted">Overall{done ? "" : " (preliminary)"}</p>
              <p className="font-display text-5xl leading-none font-bold [font-stretch:88%]">
                {review.scores.overall}
                <span className="text-lg font-normal text-sheet-muted">/100</span>
              </p>
            </div>
            {SCORES.map(({ key, label }) => {
              const value = review.scores![key];
              return (
                <div key={key} className="rounded-xl border border-border bg-card p-4">
                  <p className="text-sm text-muted-foreground">{label}</p>
                  <p className="mt-1 text-3xl leading-none font-bold tabular-nums">
                    {value}
                    <span className="text-sm font-normal text-muted-foreground">/100</span>
                  </p>
                  <div aria-hidden className="mt-3 h-1.5 rounded-full bg-muted">
                    <div className={cn("h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none", band(value))} style={{ width: `${value}%` }} />
                  </div>
                  {key === "security" && review.scores!.security_capped && (
                    <p className="mt-2 text-xs font-bold text-[#912018]">Capped at 60 by a critical issue</p>
                  )}
                </div>
              );
            })}
          </div>
          <details className="text-sm">
            <summary className="w-fit cursor-pointer font-bold underline-offset-4 hover:underline">How these scores were calculated</summary>
            <div className="mt-3 rounded-xl border border-border bg-card p-4">
              <p className="text-muted-foreground">
                Each score starts at 100. Every open finding deducts points by severity (critical 30, high 15, medium 7, low 3) scaled by
                confidence. Overall is 30% Quality, 30% Security, 20% Performance and 20% Maintainability. Bugs count toward Quality.
              </p>
              {review.scores.deductions.length ? (
                <ul className="mt-3 grid gap-1">
                  {review.scores.deductions.map((d) => (
                    <li key={`${d.finding_ref}-${d.score}`} className="flex gap-3">
                      <span className="w-14 shrink-0 text-right font-bold tabular-nums">-{d.points}</span>
                      <span className="w-32 shrink-0 text-muted-foreground capitalize">{d.score}</span>
                      <span>
                        <span className="font-mono text-xs text-muted-foreground">{d.finding_ref}</span> {findingById.get(d.finding_ref)?.title}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3">No deductions.</p>
              )}
            </div>
          </details>
        </section>
      )}

      {review.summary && <p className="max-w-[70ch] text-lg">{review.summary}</p>}

      {studentMode && review.concept_primers.length > 0 && (
        <section id="concepts" aria-labelledby="concepts-heading" className="scroll-mt-6 rounded-xl border border-[#e9d77f] bg-[#fdf6d8] p-5">
          <h2 id="concepts-heading" className="font-display text-xl font-bold [font-stretch:90%]">
            Concepts behind these findings
          </h2>
          <dl className="mt-3 grid gap-4 sm:grid-cols-2">
            {review.concept_primers.map((p) => (
              <div key={p.concept}>
                <dt className="font-bold">{p.concept}</dt>
                <dd className="text-[15px]">{p.explanation}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {/* FR-062: quiz on the user's own mistakes; the server also enforces "completed" and "has findings". */}
      {done && review.findings.some((f) => f.status !== "false_positive") && (
        <section aria-labelledby="quiz-heading" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-5 py-4">
          <div>
            <h2 id="quiz-heading" className="font-display text-xl font-bold [font-stretch:90%]">
              Test what you learned
            </h2>
            <p className="text-sm text-muted-foreground">A short quiz built from the mistakes in this file.</p>
          </div>
          <QuizModal reviewId={review.id} studentMode={studentMode} />
        </section>
      )}

      <section aria-labelledby="findings-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="findings-heading" className="font-display text-2xl font-bold [font-stretch:90%]">
            Findings
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <span id="severity-filter" className="text-sm text-muted-foreground">
              Show
            </span>
            <ToggleGroup
              multiple
              aria-labelledby="severity-filter"
              variant="outline"
              spacing={0}
              value={severities}
              onValueChange={(v) => setSeverities(v)}
              className="flex-wrap bg-card"
            >
              {SEVERITY_ORDER.map((s) => {
                const Icon = SEVERITY[s].icon;
                return (
                  <ToggleGroupItem key={s} value={s} size="sm" className="h-8 border-input px-2.5 aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:hover:bg-foreground">
                    <Icon aria-hidden />
                    {SEVERITY[s].label}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={(v) => setTab(v as TabKey)} className="gap-4">
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <TabsList variant="line" className="h-auto w-max border-b border-border p-0">
              {[...FINDING_TABS, { value: "complexity" as const, label: "Complexity", match: (f: Finding) => f.category === "maintainability" }].map((t) => (
                <TabsTrigger key={t.value} value={t.value} className="h-10 flex-none px-3 text-[15px]">
                  {t.label}
                  <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{visible.filter(t.match).length}</span>
                </TabsTrigger>
              ))}
              <TabsTrigger value="improvements" className="h-10 flex-none px-3 text-[15px]">
                Improvements
                <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{fixable.length}</span>
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Remounts when the AI stage lands, so the refreshed findings fade in once. */}
          <div key={review.status} className={cn(done && initial.status !== "completed" && "animate-in duration-500 fade-in-0 slide-in-from-bottom-2 motion-reduce:animate-none")}>
            {FINDING_TABS.map((t) => (
              <TabsContent key={t.value} value={t.value}>
                {list(visible.filter(t.match), emptyText(`${t.label.toLowerCase()} issues`))}
              </TabsContent>
            ))}

            <TabsContent value="complexity" className="flex flex-col gap-6">
              {review.metrics && <ComplexityTable review={review} />}
              {list(maintainability, emptyText("maintainability issues"))}
            </TabsContent>

            <TabsContent value="improvements">
              <div className="flex flex-col gap-8">
                <ImprovePanel review={review} done={done} />
                <Improvements review={review} done={done} />
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </section>
    </div>
  );
}

function ComplexityTable({ review }: { review: ReviewDetail }) {
  const m = review.metrics!;
  const stats = [
    ["Lines of code", m.loc],
    ["Functions", m.function_count],
    ["Max cyclomatic complexity", m.cyclomatic],
    ["Max nesting depth", m.nesting_depth],
    ["Duplicated code", `${m.duplication_pct}%`],
    ["Slowest function", m.time_complexity ?? "Not estimated"],
  ] as const;
  const flag = (over: boolean, value: number) =>
    over ? (
      <span className="inline-flex items-center gap-1 font-bold text-[#93370d]">
        <AlertTriangle aria-hidden className="size-3.5" />
        {value}
        <span className="sr-only">(above threshold)</span>
      </span>
    ) : (
      value
    );
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border bg-card p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-xl font-bold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {m.functions.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="px-4 pt-3 text-left text-sm text-muted-foreground">
              Per-function metrics. Thresholds: cyclomatic complexity above 10, nesting deeper than 3.
            </caption>
            <thead>
              <tr className="border-b border-border">
                {["Function", "Lines", "Cyclomatic", "Nesting", "Time", "Space"].map((h) => (
                  <th key={h} scope="col" className="px-4 py-2 font-bold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.functions.map((f) => (
                <tr key={`${f.name}-${f.start_line}`} className="border-b border-border last:border-0 align-top">
                  <th scope="row" className="px-4 py-2 font-mono text-[13px] font-normal">
                    {f.name}
                    {(f.explanation || f.suggestion) && (
                      <p className="mt-1 max-w-[52ch] font-sans text-[13px] text-muted-foreground">
                        {f.explanation} {f.suggestion && <span className="text-foreground">Better: {f.suggestion}</span>}
                      </p>
                    )}
                  </th>
                  <td className="px-4 py-2 tabular-nums">
                    {f.start_line}-{f.end_line}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{flag(f.cyclomatic > 10, f.cyclomatic)}</td>
                  <td className="px-4 py-2 tabular-nums">{flag(f.nesting_depth > 3, f.nesting_depth)}</td>
                  <td className="px-4 py-2 font-mono text-[13px]">{f.time_complexity ?? "-"}</td>
                  <td className="px-4 py-2 font-mono text-[13px]">{f.space_complexity ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Improvements({ review, done }: { review: ReviewDetail; done: boolean }) {
  const groups: FixSafety[] = ["safe", "needs_review", "manual_only"];
  const withFix = review.findings.filter((f) => f.status !== "false_positive" && (f.fix_code || f.fix_safety === "manual_only"));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-sheet px-5 py-4 text-white">
        <p className="max-w-[60ch]">
          Fix All Safe Issues builds a new copy of your file with every behaviour-preserving fix applied. Your original code is never changed.
        </p>
        <Link
          href={`/reviews/${review.id}/fix`}
          aria-disabled={!done}
          className={cn(buttonVariants({ variant: "secondary" }), "h-10 px-4 font-bold", !done && "pointer-events-none opacity-50")}
        >
          <Wand2 aria-hidden />
          Open the fix view
        </Link>
      </div>
      {groups.map((g) => {
        const items = withFix.filter((f) => f.fix_safety === g);
        return (
          <section key={g} aria-labelledby={`group-${g}`} className="flex flex-col gap-2">
            <h3 id={`group-${g}`} className="flex flex-wrap items-center gap-2 font-bold">
              <SafetyBadge safety={g} />
              <span>
                {items.length} {items.length === 1 ? "change" : "changes"}
              </span>
              <span className="text-sm font-normal text-muted-foreground">{SAFETY[g].description}</span>
            </h3>
            {items.length > 0 && (
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {items.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                    <SeverityBadge severity={f.severity as Severity} />
                    <span className="font-bold">{f.title}</span>
                    <span className="font-mono text-xs text-muted-foreground">line {f.location.start_line}</span>
                    <span className="w-full text-sm text-muted-foreground">{f.fix}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
