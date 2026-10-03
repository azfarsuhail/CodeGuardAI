"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

const PHRASE = "DELETE";

/** FR-004: permanent account deletion behind a typed confirmation, in a native modal dialog. */
export function DeleteAccount({ email, reviewCount }: { email: string | null; reviewCount: number }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = typed === PHRASE;

  function open() {
    setTyped("");
    setError(null);
    dialog.current?.showModal(); // native modal: focus trap, Escape to close, inert background
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `Deletion failed (HTTP ${res.status}).`);
      // refresh() re-renders server components (the header) now that the session cookies are gone.
      router.replace("/?account=deleted");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deletion failed. Try again.");
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="danger-heading" className="rounded-xl border-2 border-[#fda29b] bg-card p-5">
      <h2 id="danger-heading" className="font-display text-xl font-bold [font-stretch:90%]">
        Delete account
      </h2>
      <p className="mt-2 max-w-[62ch] text-[15px]">
        Permanently deletes your account and everything in it: {reviewCount} {reviewCount === 1 ? "review" : "reviews"} with their findings,
        fixed and improved versions. This can&apos;t be undone.
      </p>
      <Button type="button" variant="destructive" onClick={open} className="mt-4 h-10 px-4 font-bold">
        Delete my account
      </Button>

      <dialog
        ref={dialog}
        aria-labelledby="confirm-heading"
        aria-describedby="confirm-description"
        className="m-auto w-[min(92vw,30rem)] rounded-2xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-[#16202b]/60"
        onClose={() => setBusy(false)}
      >
        <form onSubmit={submit} className="flex flex-col gap-4 p-6">
          <h3 id="confirm-heading" className="flex items-center gap-2 text-lg font-bold">
            <TriangleAlert aria-hidden className="size-5 text-destructive" />
            Delete your account permanently?
          </h3>
          <div id="confirm-description" className="flex flex-col gap-2 text-[15px]">
            <p>
              This deletes {email ? <strong>{email}</strong> : "your account"}, your sign-in, and all {reviewCount}{" "}
              {reviewCount === 1 ? "review" : "reviews"} with their findings and saved versions.
            </p>
            <p>You can&apos;t undo this or recover the data.</p>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="confirm-phrase" className="text-sm font-bold">
              Type {PHRASE} to confirm
            </label>
            <input
              id="confirm-phrase"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="h-11 rounded-lg border border-input bg-card px-3 font-mono text-[15px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
            />
          </div>
          {error && (
            <p role="alert" className="rounded-lg border border-[#fda29b] bg-[#fef3f2] px-3 py-2 text-sm font-bold text-[#912018]">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => dialog.current?.close()} disabled={busy} className="h-10">
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!confirmed || busy} aria-busy={busy} className="h-10 font-bold">
              {busy && <Loader2 aria-hidden className="animate-spin motion-reduce:animate-none" />}
              {busy ? "Deleting…" : "Delete account permanently"}
            </Button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
