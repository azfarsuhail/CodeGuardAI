import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { actionLink, authEmail, confirmationLink, siteUrl, verifyHook, type HookPayload } from "./auth-email.ts";

const key = randomBytes(32);
const secret = `v1,whsec_${key.toString("base64")}`;
const now = 1_790_000_000;
const sign = (body: string, ts = now, k = key) => `v1,${createHmac("sha256", k).update(`msg_1.${ts}.${body}`).digest("base64")}`;
const headers = (sig: string, ts = now) => new Headers({ "webhook-id": "msg_1", "webhook-timestamp": String(ts), "webhook-signature": sig });

test("a correctly signed hook verifies; tampering, a wrong secret or a stale timestamp do not", () => {
  const body = '{"a":1}';
  assert.equal(verifyHook(secret, headers(sign(body)), body, now), true);
  assert.equal(verifyHook(secret, headers(sign(body)), '{"a":2}', now), false);
  assert.equal(verifyHook(secret, headers(sign(body, now, randomBytes(32))), body, now), false);
  assert.equal(verifyHook(secret, headers(sign(body, now - 600), now - 600), body, now), false);
  assert.equal(verifyHook(secret, new Headers(), body, now), false);
  // Several signatures (secret rotation): any valid one is enough.
  assert.equal(verifyHook(secret, headers(`v1,AAAA ${sign(body)}`), body, now), true);
});

const payload = (email_action_type: string, redirect_to: string): HookPayload => ({
  user: { email: "student@example.com" },
  email_data: { token_hash: "abc123", redirect_to, email_action_type, site_url: "https://cloudtest.tech" },
});

test("reset links keep the app's callback and next page, and carry token_hash for any-browser sign-in", () => {
  const link = new URL(confirmationLink(payload("recovery", "https://cloudtest.tech/auth/callback?next=%2Freset-password").email_data));
  assert.equal(link.origin + link.pathname, "https://cloudtest.tech/auth/callback");
  assert.equal(link.searchParams.get("next"), "/reset-password");
  assert.equal(link.searchParams.get("token_hash"), "abc123");
  assert.equal(link.searchParams.get("type"), "recovery");
});

test("when Supabase fell back to the Site URL, the link still goes through the callback to the right page", () => {
  const link = new URL(confirmationLink(payload("recovery", "https://cloudtest.tech").email_data));
  assert.equal(link.pathname, "/auth/callback");
  assert.equal(link.searchParams.get("next"), "/reset-password");
});

test("emails escape the link and decline actions the app never triggers", () => {
  const email = authEmail(payload("signup", 'https://cloudtest.tech/auth/callback?next=%2F"><script>'))!;
  assert.equal(email.to, "student@example.com");
  assert.match(email.subject, /Confirm your email/);
  assert.equal(email.html.includes("<script>"), false);
  assert.match(email.text, /token_hash=abc123/);
  assert.equal(authEmail(payload("email_change", "https://cloudtest.tech")), null);
});

test("custom-action links use the configured site, never the request host, and carry token_hash", () => {
  delete process.env.SITE_URL;
  assert.equal(siteUrl(), "https://cloudtest.tech");
  const link = new URL(actionLink(siteUrl(), "hash1", "signup", "/dashboard"));
  assert.equal(link.origin + link.pathname, "https://cloudtest.tech/auth/callback");
  assert.deepEqual(Object.fromEntries(link.searchParams), { token_hash: "hash1", type: "signup", next: "/dashboard" });
});
