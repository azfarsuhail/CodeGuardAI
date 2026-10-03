import { reviewToMarkdown } from "@/lib/export";
import { apiError } from "@/lib/http";
import { getReviewDetail } from "@/lib/reviews";
import { getViewer } from "@/lib/supabase/server";

// GET /api/reviews/{id}/export?format=md (PRD 15, FR-073): download the report as Markdown.
export async function GET(req: Request, ctx: RouteContext<"/api/reviews/[id]/export">) {
  const { id } = await ctx.params;
  const format = new URL(req.url).searchParams.get("format") ?? "md";
  if (format !== "md") return apiError(400, "unsupported_format", "Only format=md (Markdown) is supported.");
  try {
    const viewer = await getViewer();
    const review = await getReviewDetail(id, viewer?.id ?? null);
    if (!review) return apiError(404, "not_found", "No review exists with that id.");
    if (review.status !== "completed") return apiError(409, "not_ready", "The report can be exported once the review has finished.");
    const base = review.file_name.replace(/[^\w.-]+/g, "_").replace(/\.[^.]+$/, "") || "code";
    return new Response(reviewToMarkdown(review), {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="codeguard-review-${base}.md"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error(`[GET /api/reviews/${id}/export]`, e);
    return apiError(503, "unavailable", "The report couldn't be exported right now. Try again in a minute.");
  }
}
