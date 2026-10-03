import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { AttemptRequest } from "@/lib/quiz/quiz";
import { readJsonBody, submitAttempt } from "@/lib/quiz/service";
import { ReviewActionError } from "@/lib/reviews";
import { getViewer } from "@/lib/supabase/server";

// POST /api/quizzes/{id}/attempts (FR-062): grade all answers server-side and store the attempt (guests allowed).
import { syncGamification } from "@/lib/gamification/sync";

export async function POST(req: Request, ctx: RouteContext<"/api/quizzes/[id]/attempts">) {
  const { id } = await ctx.params;
  try {
    const { answers } = await readJsonBody(req, AttemptRequest);
    const viewer = await getViewer();
    const result = await submitAttempt(id, viewer?.id ?? null, answers);
    // +5 XP per correct answer, first attempt per quiz only (the engine enforces that from the stored attempts).
    if (viewer && result.first_attempt)
      await syncGamification(viewer.id).catch((err) => console.error(`[gamification] sync failed for ${viewer.id}`, err));
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof ReviewActionError) return apiError(e.status, e.code, e.message);
    console.error(`[POST /api/quizzes/${id}/attempts]`, e);
    return apiError(503, "unavailable", "Your answers couldn't be saved right now. Try again in a minute.");
  }
}
