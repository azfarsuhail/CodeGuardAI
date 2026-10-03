import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { ReviewActionError, updateFindingStatus } from "@/lib/reviews";
import { UpdateFindingRequest } from "@/lib/schemas";

// PATCH /api/reviews/{id}/findings/{ref} (PRD 15): flag a false positive or reopen a finding; returns new scores.
export async function PATCH(req: Request, ctx: RouteContext<"/api/reviews/[id]/findings/[ref]">) {
  const { id, ref } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "invalid_json", "The request body must be valid JSON.");
  }
  const parsed = UpdateFindingRequest.safeParse(body);
  if (!parsed.success) return apiError(400, "validation_failed", parsed.error.issues[0].message);

  try {
    return NextResponse.json(await updateFindingStatus(id, ref, parsed.data));
  } catch (e) {
    if (e instanceof ReviewActionError) return apiError(e.status, e.code, e.message);
    console.error(`[PATCH /api/reviews/${id}/findings/${ref}]`, e);
    return apiError(503, "unavailable", "The finding couldn't be updated right now. Try again in a minute.");
  }
}
