import { createHmac, timingSafeEqual } from "node:crypto";
import type { Email } from "./email.ts";

// Supabase Send Email Hook: Supabase hands us the one-time token and we send the email through Resend.
// Imported by unit tests, so relative imports only.

const TOLERANCE_S = 5 * 60;

/**
 * Standard Webhooks verification (the scheme Supabase auth hooks use): HMAC-SHA256 over "id.timestamp.body"
 * with the base64 key from the "v1,whsec_<key>" secret; the header may list several "v1,<sig>" entries.
 */
export function verifyHook(secret: string, headers: Headers, body: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowS - Number(timestamp)) > TOLERANCE_S) return false; // replay window
  const key = Buffer.from(secret.trim().replace(/^v1,whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  return signatures.split(" ").some((entry) => {
    const [version, sig] = entry.split(",");
    const given = Buffer.from(sig ?? "", "base64");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export type HookPayload = {
  user: { email: string };
  email_data: { token_hash: string; redirect_to: string; email_action_type: string; site_url: string };
};

const COPY: Record<string, { subject: string; heading: string; body: string; action: string; next: string }> = {
  signup: {
    subject: "Confirm your email for CodeGuard AI",
    heading: "Welcome to CodeGuard AI",
    body: "Confirm your email address to finish creating your account. Your reviews, XP and badges are saved once you're in.",
    action: "Confirm email",
    next: "/",
  },
  recovery: {
    subject: "Reset your CodeGuard AI password",
    heading: "Reset your password",
    body: "Someone asked to reset the password for this account. If it was you, choose a new password below.",
    action: "Choose a new password",
    next: "/reset-password",
  },
  magiclink: {
    subject: "Your CodeGuard AI sign-in link",
    heading: "Sign in to CodeGuard AI",
    body: "Use the button below to sign in.",
    action: "Sign in",
    next: "/",
  },
  invite: {
    subject: "You're invited to CodeGuard AI",
    heading: "You're invited",
    body: "Accept the invitation to create your CodeGuard AI account.",
    action: "Accept invitation",
    next: "/",
  },
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Where emailed links point. Never derived from the request's Host header: a spoofed host would put a valid
 * one-time token into a link to someone else's site.
 */
export const siteUrl = () => (process.env.SITE_URL || "https://cloudtest.tech").replace(/\/$/, "");

/** Our callback verifies token_hash server-side, so the link works in any browser. */
export function actionLink(site: string, tokenHash: string, type: string, next: string): string {
  const url = new URL("/auth/callback", site);
  url.search = new URLSearchParams({ token_hash: tokenHash, type, next }).toString();
  return url.toString();
}

/**
 * The link goes to our /auth/callback with token_hash, which works in any browser (unlike the PKCE code flow).
 * redirect_to was already checked by Supabase against the allowlist; when it isn't our callback (Supabase fell
 * back to the Site URL), we build the callback on the same origin with the right next page.
 */
export function confirmationLink(data: HookPayload["email_data"]): string {
  const copy = COPY[data.email_action_type];
  const url = new URL(data.redirect_to || data.site_url);
  if (url.pathname !== "/auth/callback") {
    url.pathname = "/auth/callback";
    url.search = new URLSearchParams({ next: copy?.next ?? "/" }).toString();
  }
  url.searchParams.set("token_hash", data.token_hash);
  url.searchParams.set("type", data.email_action_type);
  return url.toString();
}

/** null for actions this app never triggers (email change, reauthentication): the hook reports an error. */
export function authEmail(payload: HookPayload): Email | null {
  return COPY[payload.email_data.email_action_type] ? actionEmail(payload.email_data.email_action_type, payload.user.email, confirmationLink(payload.email_data)) : null;
}

/** The branded email for one auth action, with its link. */
export function actionEmail(type: string, to: string, link: string): Email | null {
  const copy = COPY[type];
  if (!copy) return null;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5f4;font-family:Arial,Helvetica,sans-serif;color:#16202b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:12px" cellpadding="0" cellspacing="0"><tr><td style="padding:32px">
<p style="margin:0 0 24px;font-weight:bold;font-size:16px">CodeGuard AI</p>
<h1 style="margin:0 0 12px;font-size:24px;line-height:1.2">${escape(copy.heading)}</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.5">${escape(copy.body)}</p>
<p style="margin:0 0 24px"><a href="${escape(link)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">${escape(copy.action)}</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#55606b">The link works once and expires soon. If you didn't ask for this email, you can ignore it.</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${copy.heading}\n\n${copy.body}\n\n${copy.action}: ${link}\n\nThe link works once and expires soon. If you didn't ask for this email, you can ignore it.`;
  return { to, subject: copy.subject, html, text };
}
