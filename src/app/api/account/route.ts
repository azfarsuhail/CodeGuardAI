import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, getViewer } from "@/lib/supabase/server";

// The typed confirmation is checked here too, so the dialog isn't the only safeguard.
const DeleteAccountRequest = z.object({ confirm: z.literal("DELETE", { error: 'Type "DELETE" to confirm.' }) });

/**
 * DELETE /api/account (FR-004): permanently deletes the signed-in user's account and all their data.
 * Order matters: app data first (Review rows cascade to Finding, FixVersion and Metrics), then the Supabase
 * auth user. If the second step fails the user can retry; data is never left behind without an account.
 */
export async function DELETE(req: Request) {
  const viewer = await getViewer();
  if (!viewer) return apiError(401, "unauthenticated", "Sign in to delete your account.");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError(400, "invalid_json", "The request body must be valid JSON.");
  }
  const parsed = DeleteAccountRequest.safeParse(body);
  if (!parsed.success) return apiError(400, "confirmation_required", parsed.error.issues[0].message);

  try {
    // deleteMany: the profile row only exists once the user has submitted a review.
    await prisma.user.deleteMany({ where: { id: viewer.id } });
  } catch (e) {
    console.error(`[DELETE /api/account] data deletion failed for ${viewer.id}`, e);
    return apiError(503, "unavailable", "Your account couldn't be deleted right now. Nothing was removed; try again in a minute.");
  }

  const { error } = await createAdminClient().auth.admin.deleteUser(viewer.id);
  if (error && error.status !== 404) {
    console.error(`[DELETE /api/account] auth deletion failed for ${viewer.id}`, error);
    return apiError(
      502,
      "partial_deletion",
      "Your reviews were deleted, but the sign-in account couldn't be removed. Try again to finish deleting it.",
    );
  }

  // The session belongs to a user that no longer exists; clear its cookies. The server may already reject it.
  await (await createClient()).auth.signOut({ scope: "local" }).catch(() => {});
  return NextResponse.json({ deleted: true });
}
