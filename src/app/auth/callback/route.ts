import { NextResponse } from "next/server";
import { safeNext } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase/server";

// Landing point for GitHub OAuth, email confirmation and password-reset links (PKCE): trade the one-time
// code for a session cookie, then continue to a same-site destination.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));
  const failure = url.searchParams.get("error_description");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(`Sign-in link failed: ${error.message}`)}`, url.origin));
  }
  const message = failure ?? "That sign-in link is invalid or has expired. Try again.";
  return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, url.origin));
}
