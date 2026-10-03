import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { getReviewDetail } from "@/lib/reviews";

// GET /api/reviews/{id}: the report, static-only while the AI stage runs, final once status is "completed".
export async function GET(_req: Request, ctx: RouteContext<"/api/reviews/[id]">) {
  const { id } = await ctx.params;
  try {
    const review = await getReviewDetail(id);
    if (!review) return apiError(404, "not_found", "No review exists with that id.");
    return NextResponse.json(review, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error(`[GET /api/reviews/${id}]`, e);
    return apiError(503, "unavailable", "The review service is temporarily unavailable. Try again in a minute.");
  }
}
