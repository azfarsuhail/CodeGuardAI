"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

type Mode = "sign-in" | "sign-up" | "reset";

const COPY: Record<Mode, { title: string; submit: string; busy: string }> = {
  "sign-in": { title: "Sign in", submit: "Sign in", busy: "Signing in…" },
  "sign-up": { title: "Create an account", submit: "Create account", busy: "Creating account…" },
  reset: { title: "Reset your password", submit: "Send reset link", busy: "Sending…" },
};

const input =
  "h-11 w-full rounded-lg border border-input bg-card px-3 text-[15px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40";

function GitHubMark() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4 fill-current">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function LoginForm({ next, initialError }: { next: string; initialError: string | null }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [message, setMessage] = useState<string | null>(null);
  const callback = (dest: string) => `${window.location.origin}/auth/callback?next=${encodeURIComponent(dest)}`;

  function switchMode(m: Mode) {
    setMode(m);
    setError(null);
    setMessage(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const supabase = createClient();
    try {
      if (mode === "sign-in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(next);
        router.refresh();
        return;
      }
      if (mode === "sign-up") {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: callback(next) } });
        if (error) throw error;
        if (data.session) {
          router.replace(next);
          router.refresh();
          return;
        }
        // FR-002: email verification. The link lands on /auth/callback, which signs the user in.
        setMessage(`Check ${email} for a link to confirm your account, then come back here.`);
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: callback("/auth/reset") });
        if (error) throw error;
        setMessage(`If an account exists for ${email}, a password reset link is on its way.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function github() {
    setBusy(true);
    setError(null);
    const { error } = await createClient().auth.signInWithOAuth({ provider: "github", options: { redirectTo: callback(next) } });
    if (error) {
      setError(error.message);
      setBusy(false);
    }
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <h1 className="font-display text-4xl font-bold tracking-[-0.02em] [font-stretch:88%]">{COPY[mode].title}</h1>

      {mode !== "reset" && (
        <>
          <Button type="button" variant="outline" onClick={github} disabled={busy} className="h-11 bg-card text-[15px] font-bold">
            <GitHubMark />
            Continue with GitHub
          </Button>
          <p className="flex items-center gap-3 text-sm text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
            or with email
          </p>
        </>
      )}

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
        </div>
        {mode !== "reset" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="password">Password</Label>
              {mode === "sign-in" && (
                <button type="button" onClick={() => switchMode("reset")} className="text-sm font-bold text-primary underline-offset-4 hover:underline">
                  Forgot password?
                </button>
              )}
            </div>
            <input
              id="password"
              type="password"
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
              required
              minLength={8}
              aria-describedby={mode === "sign-up" ? "password-hint" : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={input}
            />
            {mode === "sign-up" && (
              <p id="password-hint" className="text-sm text-muted-foreground">
                At least 8 characters.
              </p>
            )}
          </div>
        )}
        <Button type="submit" disabled={busy} aria-busy={busy} className="h-11 text-[15px] font-bold">
          {busy && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
          {busy ? COPY[mode].busy : COPY[mode].submit}
        </Button>
      </form>

      <div aria-live="polite">
        {message && <p className="rounded-xl border border-[#75e0a7] bg-[#ecfdf3] px-4 py-3 text-sm font-bold text-[#05603a]">{message}</p>}
      </div>
      {error && (
        <p role="alert" className="rounded-xl border border-[#fda29b] bg-[#fef3f2] px-4 py-3 text-sm font-bold text-[#912018]">
          {error}
        </p>
      )}

      <p className="text-sm">
        {mode === "sign-in" ? (
          <>
            New to CodeGuard?{" "}
            <button type="button" onClick={() => switchMode("sign-up")} className="font-bold text-primary underline-offset-4 hover:underline">
              Create an account
            </button>
          </>
        ) : (
          <>
            {mode === "sign-up" ? "Already have an account?" : "Remembered it?"}{" "}
            <button type="button" onClick={() => switchMode("sign-in")} className="font-bold text-primary underline-offset-4 hover:underline">
              Sign in
            </button>
          </>
        )}
      </p>
      <p className="text-sm text-muted-foreground">You can review code without an account; signing in keeps a history of your reviews.</p>
    </div>
  );
}
