import { Resend } from "resend";

// Transactional email, sent straight through Resend's API. Supabase's auth emails (confirm signup, reset
// password) arrive here through its Send Email Hook (src/app/api/auth/email-hook), so Supabase's own mailer
// and its default 2-emails-per-hour limit are out of the path.
export const EMAIL_FROM = `CodeGuard AI <${process.env.EMAIL_FROM_ADDRESS || "noreply@cloudtest.tech"}>`; // a domain verified in Resend

let client: Resend | null = null;

export type Email = { to: string; subject: string; html: string; text: string };

/** Sends one email and returns Resend's id. The idempotency key (24 h) makes retries safe. */
export async function sendEmail(email: Email, idempotencyKey?: string): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set.");
  client ??= new Resend(apiKey);
  const { data, error } = await client.emails.send(
    { from: EMAIL_FROM, to: [email.to], subject: email.subject, html: email.html, text: email.text },
    idempotencyKey ? { idempotencyKey } : undefined,
  );
  if (error || !data) throw new Error(`Resend rejected the email: ${error?.message ?? "no id returned"}`);
  return data.id;
}
