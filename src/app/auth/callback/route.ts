import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { safeNext } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase/server";

const OTP_TYPES: EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

// Landing point for GitHub OAuth, email confirmation and password-reset links, then on to a same-site page.
//  - ?code=...: standard PKCE flow; the code verifier cookie set by the browser that started the flow is used.
//  - ?token_hash=...&type=...: email-template links ({{ .TokenHash }}), which also work when the email is
//    opened in a different browser than the one that requested it.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const fail = (message: string) => NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, url.origin));

  if (code || (tokenHash && type && OTP_TYPES.includes(type))) {
    const supabase = await createClient();
    const { error } = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: type! });
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
    return fail(
      /code verifier|flow state/i.test(error.message)
        ? "Open the link in the same browser you requested it from, or request a new one."
        : `That link didn't work: ${error.message}`,
    );
  }
  return fail(url.searchParams.get("error_description") ?? "That sign-in link is invalid or has expired. Try again.");
}
