import type { ReactNode } from "react";
import Link from "next/link";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { CATEGORY, SEVERITY, SEVERITY_ORDER } from "@/components/review/badges";
import { buttonVariants } from "@/components/ui/button";
import type { DashboardStats } from "@/lib/dashboard/stats";
import { LANGUAGES } from "@/lib/languages";
import type { FindingCategory } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { TrendChart } from "./trend-chart";

const CATEGORY_ORDER: FindingCategory[] = ["security", "bug", "performance", "quality", "maintainability"];
const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const card = "rounded-xl border border-border bg-card p-4 sm:p-5";
const h2 = "font-display text-xl font-bold [font-stretch:88%]";

function Delta({ delta, hasPrevious }: { delta: number | null; hasPrevious: boolean }) {
  if (delta === null) {
    return <p className="mt-2 text-xs text-muted-foreground">{hasPrevious ? "No reviews in the last 30 days" : "No reviews in the previous 30 days to compare"}</p>;
  }
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  return (
    <p className="mt-2 flex items-center gap-1 text-xs font-bold">
      <Icon aria-hidden className="size-4 shrink-0" />
      {delta === 0 ? "No change" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} points`}
      <span className="font-normal text-muted-foreground">vs previous 30 days</span>
    </p>
  );
}

/**
 * FR-071 progress dashboard layout. `gamification` is the slot for XP / levels / badges
 * (e.g. `<GamificationPanel userId={viewer.id} />`); it renders full width under the KPI tiles.
 */
export function DashboardView({ stats, gamification }: { stats: DashboardStats; gamification?: ReactNode }) {
  const { avgScore, security, open } = stats;
  return (
    <main className="mx-auto max-w-5xl px-4 pt-8 pb-16 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-display text-[clamp(1.875rem,1.4rem+2vw,2.75rem)] leading-tight font-bold tracking-[-0.02em] [font-stretch:88%]">
          Your progress
        </h1>
        <Link href="/" className={cn(buttonVariants({ size: "lg" }), "h-11 px-5 font-bold")}>
          New review
        </Link>
      </div>

      {stats.reviewsCompleted === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-border bg-card/60 px-5 py-10 text-center">
          <p>
            Your progress shows up here once you&apos;ve completed a review while signed in.{" "}
            <Link href="/" className="font-bold text-primary underline underline-offset-4">
              Start your first review
            </Link>
          </p>
        </div>
      ) : (
        <section aria-labelledby="kpi-heading" className="mt-6">
          <h2 id="kpi-heading" className="sr-only">
            Summary
          </h2>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="flex flex-col justify-between rounded-xl bg-sheet p-4 text-white">
              <dt className="text-sm text-sheet-muted">Reviews completed</dt>
              <dd className="mt-1 font-display text-5xl leading-none font-bold tabular-nums [font-stretch:88%]">{stats.reviewsCompleted}</dd>
            </div>
            <div className={cn(card, "sm:p-4")}>
              <dt className="text-sm text-muted-foreground">Bugs fixed</dt>
              <dd className="mt-1 text-3xl leading-none font-bold tabular-nums">{stats.bugsFixed}</dd>
              <dd className="mt-2 text-xs text-muted-foreground">With validated fixes</dd>
            </div>
            <div className={cn(card, "sm:p-4")}>
              <dt className="text-sm text-muted-foreground">Security issues</dt>
              <dd className="mt-1 text-3xl leading-none font-bold tabular-nums">
                {security.resolved}
                <span className="text-sm font-normal text-muted-foreground"> of {security.found} resolved</span>
              </dd>
              <dd className="mt-2 text-xs text-muted-foreground">{security.found - security.resolved} still to fix</dd>
            </div>
            <div className={cn(card, "sm:p-4")}>
              <dt className="text-sm text-muted-foreground">Average score, last 30 days</dt>
              <dd className="mt-1 text-3xl leading-none font-bold tabular-nums">
                {avgScore.current ?? "-"}
                <span className="text-sm font-normal text-muted-foreground">/100</span>
              </dd>
              <dd>
                <Delta delta={avgScore.delta} hasPrevious={avgScore.previous !== null} />
              </dd>
            </div>
          </dl>
        </section>
      )}

      {/* Gamification slot (XP, level, badges): full width, directly under the KPI tiles. */}
      {gamification && <div className="mt-6">{gamification}</div>}

      {stats.reviewsCompleted > 0 && (
        <>
          <div className="mt-6 grid gap-6 lg:grid-cols-[3fr_2fr]">
            <section aria-labelledby="trend-heading" className={card}>
              <h2 id="trend-heading" className={h2}>
                Quality trend
              </h2>
              <p className="mt-1 mb-4 text-sm text-muted-foreground">Daily average overall score, last 30 days (UTC)</p>
              <TrendChart data={stats.trend} />
            </section>

            <section aria-labelledby="lang-heading" className={card}>
              <h2 id="lang-heading" className={h2}>
                Languages
              </h2>
              <p className="mt-1 mb-4 text-sm text-muted-foreground">Average overall score per language</p>
              <ul className="flex flex-col gap-4">
                {stats.languages.map((l) => (
                  <li key={l.language}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="font-bold">{LANGUAGES[l.language].label}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {l.count} {l.count === 1 ? "review" : "reviews"} ·{" "}
                        <span className="font-bold text-foreground">{l.avg ?? "-"}</span>/100
                      </span>
                    </div>
                    <div aria-hidden className="mt-1.5 h-2 rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${l.avg ?? 0}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <section aria-labelledby="open-heading" className={card}>
              <h2 id="open-heading" className={h2}>
                Open findings
              </h2>
              {open.total === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No open findings. Nice work.</p>
              ) : (
                <>
                  <p className="mt-1 text-sm text-muted-foreground">{open.total} across all your reviews</p>
                  <h3 className="mt-4 text-sm font-bold">By severity</h3>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {SEVERITY_ORDER.map((s) => {
                      const n = open.bySeverity[s];
                      if (!n) return null;
                      const S = SEVERITY[s];
                      return (
                        <li key={s} className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold", S.badge)}>
                          <S.icon aria-hidden className="size-3.5" />
                          {n} {S.label}
                        </li>
                      );
                    })}
                  </ul>
                  <h3 className="mt-4 text-sm font-bold">By category</h3>
                  <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-3">
                    {CATEGORY_ORDER.map((c) => {
                      const n = open.byCategory[c];
                      if (!n) return null;
                      const C = CATEGORY[c];
                      return (
                        <li key={c} className="flex items-center gap-1.5">
                          <C.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                          <span className="font-bold tabular-nums">{n}</span> {C.label}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </section>

            <section aria-labelledby="recent-heading" className={card}>
              <div className="flex items-baseline justify-between gap-3">
                <h2 id="recent-heading" className={h2}>
                  Recent reviews
                </h2>
                <Link href="/history" className="text-sm font-bold underline-offset-4 hover:underline">
                  View all
                </Link>
              </div>
              <ol className="mt-3 flex flex-col divide-y divide-border">
                {stats.recent.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/reviews/${r.id}`}
                      className="flex items-center gap-3 rounded-md py-2.5 hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-sm font-bold">{r.fileName}</span>
                        <span className="block text-xs text-muted-foreground">
                          {LANGUAGES[r.language].label} · <time dateTime={r.createdAt.toISOString()}>{dateFmt.format(r.createdAt)}</time>
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums">
                        <span className="text-lg font-bold">{r.overall ?? "-"}</span>
                        <span className="text-xs text-muted-foreground">/100</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
