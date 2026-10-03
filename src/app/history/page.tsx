import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { SEVERITY, SEVERITY_ORDER } from "@/components/review/badges";
import { buttonVariants } from "@/components/ui/button";
import { LANGUAGE_IDS, LANGUAGES } from "@/lib/languages";
import { Language, Severity } from "@/lib/schemas";
import { createClient, getViewer } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "History | CodeGuard AI" };

const PAGE_SIZE = 20;

// Shape of the rows PostgREST returns for the select below.
const HistoryRow = z.object({
  id: z.string(),
  fileName: z.string(),
  language: Language,
  mode: z.enum(["developer", "student"]),
  status: z.string(),
  scores: z.object({ overall: z.number() }).nullable().catch(null),
  createdAt: z.string(),
  summary: z.string().nullable(),
  findings: z.array(z.object({ severity: Severity, status: z.string() })),
});
type HistoryRow = z.infer<typeof HistoryRow>;

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const isDate = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
// Prisma stores UTC in `timestamp without time zone`; PostgREST returns it without an offset, which
// JavaScript would otherwise parse as local time.
const utc = (ts: string) => new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(ts) ? ts : `${ts}Z`);

const control =
  "h-10 rounded-lg border border-input bg-card px-3 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40";

/**
 * FR-070 review history. Queried with the user's own Supabase session, so Postgres row-level security
 * (prisma/rls.sql) is what limits rows to the signed-in user's reviews, not just this page's code.
 */
export default async function HistoryPage({ searchParams }: PageProps<"/history">) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login?next=/history");

  const params = await searchParams;
  const q = (one(params.q) ?? "").replace(/[^\w.\- ]/g, "").trim().slice(0, 80); // PostgREST filter-safe
  const language = Language.safeParse(one(params.language)).data;
  const severity = Severity.safeParse(one(params.severity)).data;
  const from = isDate(one(params.from)) ? one(params.from) : undefined;
  const to = isDate(one(params.to)) ? one(params.to) : undefined;
  const page = Math.max(1, Number(one(params.page)) || 1);
  const filtered = Boolean(q || language || severity || from || to);

  const supabase = await createClient();
  // "match" is an inner-joined copy of findings used only for the severity filter, so "findings" stays complete.
  let query = supabase
    .from("Review")
    .select(
      severity
        ? "id, fileName, language, mode, status, scores, createdAt, summary, findings:Finding(severity, status), match:Finding!inner(severity, status)"
        : "id, fileName, language, mode, status, scores, createdAt, summary, findings:Finding(severity, status)",
      { count: "exact" },
    )
    .order("createdAt", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (q) query = query.or(`fileName.ilike.*${q}*,summary.ilike.*${q}*`);
  if (language) query = query.eq("language", language);
  if (severity) query = query.eq("match.severity", severity).neq("match.status", "false_positive");
  if (from) query = query.gte("createdAt", `${from}T00:00:00Z`);
  if (to) query = query.lt("createdAt", new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString());

  const { data, error, count } = await query;
  const rows: HistoryRow[] = error ? [] : z.array(HistoryRow).parse(data ?? []);
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, language, severity, from, to })) if (v) sp.set(k, v);
    if (p > 1) sp.set("page", String(p));
    const s = sp.toString();
    return s ? `/history?${s}` : "/history";
  };

  return (
    <main className="mx-auto max-w-5xl px-4 pt-8 pb-16 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-display text-[clamp(1.875rem,1.4rem+2vw,2.75rem)] leading-tight font-bold tracking-[-0.02em] [font-stretch:88%]">
          Your reviews
        </h1>
        <Link href="/" className={cn(buttonVariants({ size: "lg" }), "h-11 px-5 font-bold")}>
          New review
        </Link>
      </div>

      <form method="get" action="/history" role="search" aria-label="Filter reviews" className="mt-6 grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] lg:items-end">
        <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-1">
          <label htmlFor="q" className="text-sm font-bold">
            Search
          </label>
          <input id="q" name="q" type="search" defaultValue={q} placeholder="File name or summary" className={control} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="language" className="text-sm font-bold">
            Language
          </label>
          <select id="language" name="language" defaultValue={language ?? ""} className={control}>
            <option value="">All</option>
            {LANGUAGE_IDS.map((id) => (
              <option key={id} value={id}>
                {LANGUAGES[id].label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="severity" className="text-sm font-bold">
            Has a finding
          </label>
          <select id="severity" name="severity" defaultValue={severity ?? ""} className={control}>
            <option value="">Any severity</option>
            {SEVERITY_ORDER.map((s) => (
              <option key={s} value={s}>
                {SEVERITY[s].label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="from" className="text-sm font-bold">
            From
          </label>
          <input id="from" name="from" type="date" defaultValue={from} className={control} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="to" className="text-sm font-bold">
            To
          </label>
          <input id="to" name="to" type="date" defaultValue={to} className={control} />
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className={cn(buttonVariants(), "h-10 px-4 font-bold")}>
            Apply
          </button>
          {filtered && (
            <Link href="/history" className="text-sm font-bold underline-offset-4 hover:underline">
              Clear
            </Link>
          )}
        </div>
      </form>

      <section aria-labelledby="results-heading" className="mt-6">
        <h2 id="results-heading" className="sr-only">
          Results
        </h2>
        {error ? (
          <p role="alert" className="rounded-xl border border-[#fda29b] bg-[#fef3f2] px-4 py-3 text-sm font-bold text-[#912018]">
            Your history couldn&apos;t be loaded right now. Refresh to try again.
          </p>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/60 px-5 py-10 text-center">
            {filtered ? (
              <p>
                No reviews match these filters.{" "}
                <Link href="/history" className="font-bold text-primary underline underline-offset-4">
                  Clear filters
                </Link>
              </p>
            ) : (
              <p>
                You haven&apos;t reviewed any code while signed in yet.{" "}
                <Link href="/" className="font-bold text-primary underline underline-offset-4">
                  Start your first review
                </Link>
              </p>
            )}
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
              {total} {total === 1 ? "review" : "reviews"}
              {filtered ? " match" : ""}
            </p>
            <ol className="flex flex-col gap-3">
              {rows.map((r) => {
                const open = r.findings.filter((f) => f.status !== "false_positive" && f.status !== "fixed");
                return (
                  <li key={r.id}>
                    <Link
                      href={`/reviews/${r.id}`}
                      className="flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-4 transition-colors hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:flex-row sm:items-center sm:gap-6"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[15px] font-bold">{r.fileName}</p>
                        <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-muted-foreground">
                          <span>{LANGUAGES[r.language].label}</span>
                          <span>{r.mode === "student" ? "Student mode" : "Developer mode"}</span>
                          <time dateTime={utc(r.createdAt).toISOString()}>{dateFmt.format(utc(r.createdAt))} UTC</time>
                          {r.status !== "completed" && <span className="font-bold text-foreground">Analyzing</span>}
                        </p>
                        {r.summary && <p className="mt-1.5 line-clamp-2 text-sm">{r.summary}</p>}
                      </div>
                      <ul className="flex flex-wrap gap-1.5" aria-label="Open findings by severity">
                        {SEVERITY_ORDER.filter((s) => s !== "info").map((s) => {
                          const n = open.filter((f) => f.severity === s).length;
                          if (!n) return null;
                          const S = SEVERITY[s];
                          return (
                            <li key={s} className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold", S.badge)}>
                              <S.icon aria-hidden className="size-3.5" />
                              {n} {S.label}
                            </li>
                          );
                        })}
                        {open.length === 0 && <li className="text-xs text-muted-foreground">No open findings</li>}
                      </ul>
                      <p className="shrink-0 text-right">
                        <span className="text-3xl leading-none font-bold tabular-nums">{r.scores?.overall ?? "-"}</span>
                        <span className="text-sm text-muted-foreground">/100</span>
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ol>
            {pages > 1 && (
              <nav aria-label="Pages" className="mt-6 flex items-center justify-between text-sm font-bold">
                {page > 1 ? <Link href={pageHref(page - 1)} className="underline-offset-4 hover:underline">Newer</Link> : <span />}
                <span className="font-normal text-muted-foreground">
                  Page {page} of {pages}
                </span>
                {page < pages ? <Link href={pageHref(page + 1)} className="underline-offset-4 hover:underline">Older</Link> : <span />}
              </nav>
            )}
          </>
        )}
      </section>
    </main>
  );
}
