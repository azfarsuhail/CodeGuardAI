"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

// `retry` (stable in Next 16.3) re-fetches the page's data; `reset` would only re-render the same failure.
export default function ReviewError({ retry }: { error: Error; retry: () => void }) {
  return (
    <main className="mx-auto flex max-w-5xl flex-col items-start gap-4 px-4 pt-16 pb-16 sm:px-6">
      <h1 className="font-display text-3xl font-bold [font-stretch:88%]">This review couldn&apos;t be loaded</h1>
      <p className="max-w-[60ch] text-muted-foreground">
        The review service didn&apos;t respond. Your review is saved; try again in a moment.
      </p>
      <div className="flex gap-3">
        <Button type="button" onClick={() => retry()}>
          Try again
        </Button>
        <Link href="/" className="inline-flex h-8 items-center font-bold underline-offset-4 hover:underline">
          Start a new review
        </Link>
      </div>
    </main>
  );
}
