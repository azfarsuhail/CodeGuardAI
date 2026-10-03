import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { createQuiz } from "@/lib/quiz/service";
import { ReviewActionError } from "@/lib/reviews";
import { getViewer } from "@/lib/supabase/server";

// One LLM call (45 s budget, 30 s cap per provider attempt).
export const maxDuration = 60;

// POST /api/reviews/{id}/quiz (FR-062): generate a quiz on this review's findings. Answers stay on the server.
export async function POST(_req: Request, ctx: RouteContext<"/api/reviews/[id]/quiz">) {
  const { id } = await ctx.params;
  try {
    const viewer = await getViewer();
    return NextResponse.json(await createQuiz(id, viewer?.id ?? null), { status: 201 });
  } catch (e) {
    if (e instanceof ReviewActionError) return apiError(e.status, e.code, e.message);
    console.error(`[POST /api/reviews/${id}/quiz]`, e);
    return apiError(503, "unavailable", "The quiz couldn't be created right now. Try again in a minute.");
  }
}
