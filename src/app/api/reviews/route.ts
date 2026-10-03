import { after, NextResponse } from "next/server";
import { apiError, clientHash } from "@/lib/http";
import { completeReview, createReview, DAILY_REVIEW_LIMIT, retryAfterSeconds } from "@/lib/reviews";
import { CreateReviewRequest } from "@/lib/schemas";
import { getViewer } from "@/lib/supabase/server";

// Static analysis + the AI call run in this Node.js function. The analyzers (ESLint, Ruff WebAssembly)
// are too large for the Edge runtime, so this stays on Node. Work scheduled with after() counts toward this
// limit: AI budget 75 s (AI_DEADLINE_MS) + merge and DB writes. 90 s is well inside every Vercel plan's limit
// with Fluid Compute (Hobby: 300 s default and max), so no paid plan is needed.
export const maxDuration = 90;

// POST /api/reviews (PRD 15): validates, runs static analysis synchronously, stores a static-only report,
// returns 202, then finishes the AI review in the background. Clients poll GET /api/reviews/{id}.
export async function POST(req: Request) {
  const startedAt = Date.now();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "invalid_json", "The request body must be valid JSON.");
  }

  const parsed = CreateReviewRequest.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return apiError(400, "validation_failed", parsed.error.issues[0].message, details);
  }

  try {
    const viewer = await getViewer();
    const client = clientHash(req, viewer?.id);
    const retryAfter = await retryAfterSeconds(client);
    if (retryAfter !== null)
      return apiError(
        429,
        "rate_limited",
        `You've reached the limit of ${DAILY_REVIEW_LIMIT} reviews per day. Try again in ${Math.ceil(retryAfter / 3600)} hours.`,
        undefined,
        { "Retry-After": String(retryAfter) },
      );

    const { id, analysis } = await createReview(parsed.data, client, viewer);
    after(() => completeReview(id, parsed.data, analysis, startedAt));
    return NextResponse.json({ review_id: id, status: "analyzing" }, { status: 202 });
  } catch (e) {
    console.error("[POST /api/reviews]", e);
    return apiError(503, "unavailable", "The review service is temporarily unavailable. Try again in a minute.");
  }
}
