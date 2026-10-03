import { createHash } from "node:crypto";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { actionEmail, actionLink, siteUrl } from "@/lib/auth-email";
import { sendEmail } from "@/lib/email";
import { apiError, clientHash } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { safeNext } from "@/lib/safe-next";
import { createAdminClient } from "@/lib/supabase/admin";

// Sign-up confirmation and password-reset emails without Supabase's mailer: the admin API generates the
// one-time link (it sends nothing itself) and Resend delivers it. Because Supabase's email rate limits no longer
// apply, this public endpoint enforces its own, and answers the same way whether or not an account exists.
const Body = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("signup"),
    email: z.email("Enter a valid email address.").max(254),
    password: z.string().min(8, "Use at least 8 characters for your password.").max(72, "Use at most 72 characters."),
    next: z.string().max(500).optional(),
  }),
  z.object({ type: z.literal("recovery"), email: z.email("Enter a valid email address.").max(254) }),
]);

const WINDOW_MS = 60 * 60 * 1000;
const PER_ADDRESS = 3; // emails of one kind to one address per hour
const PER_CLIENT = 10; // emails of any kind from one IP per hour
const SENT = {
  signup: "Check your email for a link to confirm your account.",
  recovery: "If an account exists for that address, we've emailed it a link to reset the password.",
};

const addressHash = (email: string) => createHash("sha256").update(`${process.env.RATE_LIMIT_SALT ?? ""}:email:${email}`).digest("hex").slice(0, 32);

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return apiError(400, "invalid_json", "The request body must be valid JSON.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return apiError(400, "validation_failed", parsed.error.issues[0].message);
  const body = parsed.data;
  // Fail loudly rather than answer "check your email" for an email that can't be sent.
  if (!process.env.RESEND_API_KEY) return apiError(503, "email_not_configured", "Email sending isn't set up yet. Try again later.");
  const email = body.email.trim().toLowerCase();
  const sent = () => NextResponse.json({ message: SENT[body.type] }, { status: 202 });

  try {
    const emailHash = addressHash(email);
    const client = clientHash(req);
    const since = new Date(Date.now() - WINDOW_MS);
    const [toAddress, fromClient] = await Promise.all([
      prisma.authEmailSend.count({ where: { kind: body.type, emailHash, createdAt: { gte: since } } }),
      prisma.authEmailSend.count({ where: { clientHash: client, createdAt: { gte: since } } }),
    ]);
    if (toAddress >= PER_ADDRESS || fromClient >= PER_CLIENT)
      return apiError(429, "rate_limited", "Too many emails were requested. Wait an hour, then try again.", undefined, { "Retry-After": "3600" });
    await prisma.authEmailSend.create({ data: { kind: body.type, emailHash, clientHash: client } });

    const admin = createAdminClient();
    const { data, error } =
      body.type === "signup"
        ? await admin.auth.admin.generateLink({ type: "signup", email, password: body.password })
        : await admin.auth.admin.generateLink({ type: "recovery", email });
    if (error) {
      // An existing account (sign-up) or a missing one (reset) gets the same answer as success.
      if (error.code === "email_exists" || error.code === "user_not_found") return sent();
      if (error.code === "weak_password") return apiError(400, "weak_password", error.message);
      throw error;
    }

    const next = body.type === "recovery" ? "/reset-password" : safeNext(body.next, "/history");
    const mail = actionEmail(body.type, email, actionLink(siteUrl(), data.properties.hashed_token, body.type, next))!;
    // After the response, so its timing doesn't reveal whether the account existed.
    after(async () => {
      try {
        // Re-sign-up of an address nobody has confirmed keeps the first password by default, so whoever registered
        // someone else's address first would know the password once its owner confirms. The newest password wins.
        if (body.type === "signup" && !data.user.email_confirmed_at)
          await admin.auth.admin.updateUserById(data.user.id, { password: body.password });
        await sendEmail(mail, `${body.type}/${data.properties.hashed_token}`);
      } catch (e) {
        console.error(`[custom-action] ${body.type} email failed:`, e instanceof Error ? e.message : e);
      }
    });
    return sent();
  } catch (e) {
    console.error("[custom-action]", e instanceof Error ? e.message : e);
    return apiError(503, "unavailable", "We couldn't send the email right now. Try again in a minute.");
  }
}
