import { NextResponse } from "next/server";
import { apiError } from "@/lib/http";
import { createFixVersion, ReviewActionError } from "@/lib/reviews";
import { CreateFixRequest } from "@/lib/schemas";

// POST /api/reviews/{id}/fix (PRD 15): creates a new, validated fixed version. Never touches the original.
export async function POST(req: Request, ctx: RouteContext<"/api/reviews/[id]/fix">) {
  const { id } = await ctx.params;
  let body: unknown = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return apiError(400, "invalid_json", "The request body must be valid JSON.");
  }
  const parsed = CreateFixRequest.safeParse(body);
  if (!parsed.success) return apiError(400, "validation_failed", parsed.error.issues[0].message);

  try {
    const version = await createFixVersion(id, parsed.data.finding_ids);
    return NextResponse.json(version, { status: 201 });
  } catch (e) {
    if (e instanceof ReviewActionError) return apiError(e.status, e.code, e.message);
    console.error(`[POST /api/reviews/${id}/fix]`, e);
    return apiError(503, "unavailable", "The fix couldn't be created right now. Try again in a minute.");
  }
}
