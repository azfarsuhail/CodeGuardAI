"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

// FR-002 password reset, step 2. /auth/callback has already turned the emailed link into a short-lived
// recovery session; set the new password, end that session, and send the user to sign in with it.
export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(
        /session|jwt|not authenticated/i.test(error.message)
          ? "This reset link has expired or was opened in a different browser. Request a new one."
          : error.message,
      );
      setBusy(false);
      return;
    }
    // Sign out everywhere so a stolen recovery session or old device can't keep using the account.
    await supabase.auth.signOut({ scope: "global" });
    router.replace("/login?reset=success");
    router.refresh();
  }

  return (
    <main className="mx-auto flex max-w-5xl px-4 pt-12 pb-16 sm:px-6">
      <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-5">
        <h1 className="font-display text-4xl font-bold tracking-[-0.02em] [font-stretch:88%]">Choose a new password</h1>
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-password">New password</Label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            aria-describedby="new-password-hint"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 w-full rounded-lg border border-input bg-card px-3 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
          />
          <p id="new-password-hint" className="text-sm text-muted-foreground">
            At least 8 characters. You&apos;ll be signed out everywhere and asked to sign in with it.
          </p>
        </div>
        <Button type="submit" disabled={busy} aria-busy={busy} className="h-11 text-[15px] font-bold">
          {busy && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
          {busy ? "Saving…" : "Save new password"}
        </Button>
        {error && (
          <p role="alert" className="rounded-xl border border-[#fda29b] bg-[#fef3f2] px-4 py-3 text-sm font-bold text-[#912018]">
            {error}{" "}
            <Link href="/forgot-password" className="underline underline-offset-4">
              Send a new link
            </Link>
          </p>
        )}
      </form>
    </main>
  );
}
