"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

// FR-002 password reset, step 1: email a reset link. Supabase's PKCE flow stores a code verifier in this
// browser; the link lands on /auth/callback, which exchanges the code and continues to /reset-password.
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent("/reset-password")}`;
    const { error } = await createClient().auth.resetPasswordForEmail(email, { redirectTo });
    setBusy(false);
    if (error) return setError(error.message);
    setSent(true);
  }

  return (
    <main className="mx-auto flex max-w-5xl px-4 pt-12 pb-16 sm:px-6">
      <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-5">
        <h1 className="font-display text-4xl font-bold tracking-[-0.02em] [font-stretch:88%]">Reset your password</h1>
        <p className="text-muted-foreground">Enter your account email and we&apos;ll send you a link to choose a new password.</p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-11 w-full rounded-lg border border-input bg-card px-3 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
          />
        </div>
        <Button type="submit" disabled={busy || sent} aria-busy={busy} className="h-11 text-[15px] font-bold">
          {busy && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
          {busy ? "Sending…" : sent ? "Link sent" : "Send reset link"}
        </Button>
        <div aria-live="polite">
          {sent && (
            <p className="rounded-xl border border-[#75e0a7] bg-[#ecfdf3] px-4 py-3 text-sm font-bold text-[#05603a]">
              If an account exists for {email}, a reset link is on its way. Open it in this browser.
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="rounded-xl border border-[#fda29b] bg-[#fef3f2] px-4 py-3 text-sm font-bold text-[#912018]">
            {error}
          </p>
        )}
        <Link href="/login" className="text-sm font-bold text-primary underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </form>
    </main>
  );
}
