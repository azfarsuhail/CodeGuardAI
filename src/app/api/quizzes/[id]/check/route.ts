import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { CheckRequest } from "@/lib/quiz/quiz";
import { checkQuizAnswer, readJsonBody } from "@/lib/quiz/service";
import { ReviewActionError } from "@/lib/reviews";
import { getViewer } from "@/lib/supabase/server";

// POST /api/quizzes/{id}/check (FR-062): instant feedback on one answer. Nothing is stored.
export async function POST(req: Request, ctx: RouteContext<"/api/quizzes/[id]/check">) {
  const { id } = await ctx.params;
  try {
    const body = await readJsonBody(req, CheckRequest);
    const viewer = await getViewer();
    return NextResponse.json(await checkQuizAnswer(id, viewer?.id ?? null, body));
  } catch (e) {
    if (e instanceof ReviewActionError) return apiError(e.status, e.code, e.message);
    console.error(`[POST /api/quizzes/${id}/check]`, e);
    return apiError(503, "unavailable", "The answer couldn't be checked right now. Try again in a minute.");
  }
}
