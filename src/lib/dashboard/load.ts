import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { summarize, type DashboardStats } from "./stats";

const Overall = z.object({ overall: z.number() });

/** Loads the signed-in user's completed reviews in one query and aggregates them for /dashboard. */
export async function loadDashboard(userId: string, now = new Date()): Promise<DashboardStats> {
  // ponytail: loads every completed review of the user; move to SQL aggregates if histories reach thousands.
  const rows = await prisma.review.findMany({
    where: { userId, status: "completed" },
    select: {
      id: true,
      fileName: true,
      language: true,
      scores: true,
      createdAt: true,
      findings: { select: { ref: true, category: true, severity: true, status: true } },
      fixVersions: { where: { validated: true }, select: { appliedRefs: true } },
    },
  });
  return summarize(
    rows.map(({ scores, fixVersions, ...r }) => ({
      ...r,
      overall: Overall.safeParse(scores).data?.overall ?? null,
      validatedRefs: fixVersions.flatMap((v) => v.appliedRefs),
    })),
    now,
  );
}
