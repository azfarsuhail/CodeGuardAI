import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { FixView } from "@/components/review/fix-view";
import { getReviewDetail } from "@/lib/reviews";
import { getViewer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Fix code | CodeGuard AI" };

export default async function FixPage({ params }: PageProps<"/reviews/[id]/fix">) {
  const { id } = await params;
  const viewer = await getViewer();
  const review = await getReviewDetail(id, viewer?.id ?? null);
  if (!review) notFound();
  // Fixes come from the AI stage; until it finishes, the review page shows progress.
  if (review.status !== "completed") redirect(`/reviews/${id}`);
  return (
    <main className="mx-auto max-w-7xl px-4 pt-8 pb-16 sm:px-6">
      <FixView review={review} />
    </main>
  );
}
