import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { loadDashboard } from "@/lib/dashboard/load";
import { getViewer } from "@/lib/supabase/server";

import { GamificationPanel } from "@/components/gamification/progress";
export const metadata: Metadata = { title: "Dashboard | CodeGuard AI" };

/** FR-071 progress dashboard. Every query is scoped to the signed-in user's id. */
export default async function DashboardPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login?next=/dashboard");

  const stats = await loadDashboard(viewer.id);
  return <DashboardView stats={stats} gamification={<GamificationPanel userId={viewer.id} />} />;
}
