"use client";

import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import type { TrendPoint } from "@/lib/dashboard/stats";

const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const day = (iso: string) => dayFmt.format(new Date(`${iso}T00:00:00Z`));

function TrendTooltip({ active, payload }: TooltipContentProps) {
  const p = payload?.[0]?.payload as TrendPoint | undefined;
  if (!active || !p) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-md">
      <p className="font-bold">{day(p.date)}</p>
      <p className="text-muted-foreground">
        {p.avg === null ? "No reviews" : `Average ${p.avg}/100 · ${p.count} ${p.count === 1 ? "review" : "reviews"}`}
      </p>
    </div>
  );
}

/** FR-071 30-day trend: daily average overall score; days without reviews are gaps, not zeros. */
export function TrendChart({ data }: { data: TrendPoint[] }) {
  const scored = data.filter((p) => p.avg !== null);
  return (
    <figure className="flex flex-col gap-3">
      <div
        role="img"
        aria-label={`Line chart of your daily average overall score over the last 30 days: ${scored.length} days with reviews. The data table below lists every value.`}
        className="h-56 w-full sm:h-64"
      >
        <LineChart responsive accessibilityLayer={false} data={data} margin={{ top: 8, right: 12, bottom: 0, left: -20 }} style={{ width: "100%", height: "100%" }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="date"
            tickFormatter={day}
            interval="preserveStartEnd"
            minTickGap={24}
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip content={TrendTooltip} cursor={{ stroke: "var(--input)", strokeWidth: 1 }} />
          <Line
            type="linear"
            dataKey="avg"
            name="Average overall score"
            stroke="var(--primary)"
            strokeWidth={2}
            connectNulls={false}
            dot={{ r: 4, fill: "var(--primary)", stroke: "var(--card)", strokeWidth: 2 }}
            activeDot={{ r: 6, fill: "var(--primary)", stroke: "var(--card)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </div>
      <details className="text-sm">
        <summary className="w-fit cursor-pointer font-bold underline-offset-4 hover:underline">Show data</summary>
        <div className="mt-3 max-h-72 overflow-auto rounded-lg border border-border">
          <table className="w-full text-left tabular-nums">
            <caption className="sr-only">Daily average overall score, last 30 days (UTC)</caption>
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th scope="col" className="px-3 py-2">Day (UTC)</th>
                <th scope="col" className="px-3 py-2 text-right">Reviews</th>
                <th scope="col" className="px-3 py-2 text-right">Average score</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.date} className="border-t border-border">
                  <th scope="row" className="px-3 py-1.5 font-normal">
                    <time dateTime={p.date}>{day(p.date)}</time>
                  </th>
                  <td className="px-3 py-1.5 text-right">{p.count}</td>
                  <td className="px-3 py-1.5 text-right">{p.avg ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
