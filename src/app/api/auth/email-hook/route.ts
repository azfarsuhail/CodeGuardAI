import { NextResponse } from "next/server";
import { authEmail, verifyHook, type HookPayload } from "@/lib/auth-email";
import { sendEmail } from "@/lib/email";

// Supabase Auth → Hooks → Send Email (HTTPS) points here. Supabase then sends no email itself: confirmation and
// password-reset emails go out through Resend. Response contract: 200 {} on success, otherwise
// { error: { http_code, message } }, which Supabase shows to the user as the sign-up/reset error.
const hookError = (status: number, message: string) => NextResponse.json({ error: { http_code: status, message } }, { status });

export async function POST(req: Request) {
  const secret = process.env.SEND_EMAIL_HOOK_SECRET;
  if (!secret) return hookError(500, "The email service is not configured.");
  const body = await req.text();
  if (!verifyHook(secret, req.headers, body)) return hookError(401, "Invalid hook signature.");

  let payload: HookPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return hookError(400, "Invalid hook payload.");
  }
  const email = authEmail(payload);
  if (!email) return hookError(400, `Unsupported email type: ${payload.email_data?.email_action_type}.`);

  try {
    // Supabase retries failed hooks with the same webhook-id; the idempotency key stops duplicate emails.
    await sendEmail(email, `auth-email/${req.headers.get("webhook-id")}`);
  } catch (e) {
    console.error("[email-hook]", payload.email_data.email_action_type, e instanceof Error ? e.message : e);
    return hookError(502, "We couldn't send the email. Try again in a moment.");
  }
  return NextResponse.json({});
}
