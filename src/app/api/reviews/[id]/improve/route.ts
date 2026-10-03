import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { createImproveVersion, ReviewActionError } from "@/lib/reviews";
import { getViewer } from "@/lib/supabase/server";

// The rewrite is one synchronous LLM call (30 s cap per provider attempt) plus re-validation.
export const maxDuration = 90;

// POST /api/reviews/{id}/improve (PRD 15, FR-050): full AI rewrite + structured change list, saved as a new version.
export async function POST(_req: Request, ctx: RouteContext<"/api/reviews/[id]/improve">) {
  const { id } = await ctx.params;
  try {
    const viewer = await getViewer();
    return NextResponse.json(await createImproveVersion(id, viewer?.id ?? null), { status: 201 });
  } catch (e) {
    if (e instanceof ReviewActionError) return apiError(e.status, e.code, e.message);
    console.error(`[POST /api/reviews/${id}/improve]`, e);
    return apiError(503, "unavailable", "The improved version couldn't be created right now. Try again in a minute.");
  }
}
