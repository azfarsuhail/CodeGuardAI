import Link from "next/link";
import { Flame, Lock, Trophy } from "lucide-react";
import { BADGES } from "@/lib/gamification/badges";
import { BADGE_CODES, levelFor } from "@/lib/gamification/engine";
import { getGamificationSummary, type GamificationSummary } from "@/lib/gamification/sync";
import { cn } from "@/lib/utils";

const pill = "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-bold whitespace-nowrap";
const earnedTint = "bg-[#dce4f7] text-[#1d3a8a]";

function XpBar({ s, className }: { s: GamificationSummary; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-label={`XP toward level ${s.level + 1}`}
      aria-valuemin={s.currentLevelXp}
      aria-valuemax={s.nextLevelXp}
      aria-valuenow={s.xp}
      aria-valuetext={`${s.xp} of ${s.nextLevelXp} XP, ${s.progressPct}% of the way to level ${s.level + 1}`}
      className={cn("overflow-hidden rounded-full bg-muted", className)}
    >
      <div className="h-full rounded-full bg-primary" style={{ width: `${s.progressPct}%` }} />
    </div>
  );
}

const fmtDate = (d: Date) => d.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Compact header widget: level chip, XP bar to the next level, up to 3 most recent badges. */
export async function HeaderProgress({ userId }: { userId: string }) {
  // The header is on every page, so a database hiccup renders level 1 instead of breaking the layout.
  const s = await getGamificationSummary(userId).catch(
    (): GamificationSummary => ({ xp: 0, ...levelFor(0), currentStreak: 0, longestStreak: 0, badges: [] }),
  );
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1 text-xs">
      <Link
        href="/dashboard"
        className={cn(pill, earnedTint, "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary")}
      >
        <Trophy aria-hidden className="size-3.5" />
        Lvl {s.level}
        <span className="sr-only">, view your progress on the dashboard</span>
      </Link>
      <div className="flex items-center gap-1.5">
        <XpBar s={s} className="h-1.5 w-16" />
        <span aria-hidden className="tabular-nums text-muted-foreground">
          {s.xp} / {s.nextLevelXp} XP
        </span>
      </div>
      {s.badges.length > 0 && (
        <ul aria-label="Recent badges" className="flex items-center gap-1">
          {s.badges.slice(0, 3).map((b) => {
            const Icon = BADGES[b.code].icon;
            return (
              <li key={b.code} title={b.label} className="text-primary">
                <Icon aria-hidden className="size-4" />
                <span className="sr-only">{b.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Dashboard panel: level, XP bar, streaks and the full badge grid (earned and locked). */
export async function GamificationPanel({ userId }: { userId: string }) {
  const s = await getGamificationSummary(userId);
  const earned = new Map(s.badges.map((b) => [b.code, b.awardedAt]));
  return (
    <section aria-labelledby="gamification-heading" className="rounded-xl border border-border bg-card p-5">
      <h2 id="gamification-heading" className="font-display text-xl font-bold [font-stretch:88%]">
        Level and badges
      </h2>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-2xl font-bold">Level {s.level}</p>
        <p className="text-sm tabular-nums text-muted-foreground">
          {s.xp} / {s.nextLevelXp} XP ({s.nextLevelXp - s.xp} XP to level {s.level + 1})
        </p>
      </div>
      <XpBar s={s} className="mt-2 h-2.5" />

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg bg-muted px-3 py-2">
          <dt className="flex items-center gap-1 text-muted-foreground">
            <Flame aria-hidden className="size-4" />
            Current streak
          </dt>
          <dd className="text-lg font-bold">{days(s.currentStreak)}</dd>
        </div>
        <div className="rounded-lg bg-muted px-3 py-2">
          <dt className="flex items-center gap-1 text-muted-foreground">
            <Trophy aria-hidden className="size-4" />
            Longest streak
          </dt>
          <dd className="text-lg font-bold">{days(s.longestStreak)}</dd>
        </div>
      </dl>

      <h3 className="mt-5 text-sm font-bold">
        Badges <span className="font-normal text-muted-foreground">({earned.size} of {BADGE_CODES.length} earned)</span>
      </h3>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {BADGE_CODES.map((code) => {
          const meta = BADGES[code];
          const awardedAt = earned.get(code);
          const Icon = awardedAt ? meta.icon : Lock;
          return (
            <li
              key={code}
              className={cn("flex items-start gap-3 rounded-lg border px-3 py-2", awardedAt ? "border-primary/40" : "border-dashed border-border")}
            >
              <span className={cn("mt-0.5 rounded-md p-1.5", awardedAt ? earnedTint : "bg-muted text-muted-foreground")}>
                <Icon aria-hidden className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="font-bold">{meta.label}</p>
                <p className="text-xs text-muted-foreground">
                  {awardedAt ? `Earned ${fmtDate(awardedAt)}` : <>Locked: {meta.description}</>}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
