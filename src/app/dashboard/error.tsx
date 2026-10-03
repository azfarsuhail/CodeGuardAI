"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function DashboardError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="mx-auto flex max-w-5xl flex-col items-start gap-4 px-4 pt-16 pb-16 sm:px-6">
      <h1 className="font-display text-3xl font-bold [font-stretch:88%]">Your dashboard couldn&apos;t be loaded</h1>
      <p className="max-w-[60ch] text-muted-foreground">
        We couldn&apos;t reach your review data. Your reviews are saved; try again in a moment.
      </p>
      <div className="flex gap-3">
        <Button type="button" onClick={() => retry()}>
          Try again
        </Button>
        <Link href="/history" className="inline-flex h-8 items-center font-bold underline-offset-4 hover:underline">
          Go to your reviews
        </Link>
      </div>
    </main>
  );
}
