import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReviewView } from "@/components/review/review-view";
import { getReviewDetail } from "@/lib/reviews";
import { getViewer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Review | CodeGuard AI" };

// Server-render the current state (static findings at least), then the client polls until the AI stage lands.
export default async function ReviewPage({ params }: PageProps<"/reviews/[id]">) {
  const { id } = await params;
  const viewer = await getViewer();
  const review = await getReviewDetail(id, viewer?.id ?? null);
  if (!review) notFound();
  return (
    <main className="mx-auto max-w-5xl px-4 pt-8 pb-16 sm:px-6">
      <ReviewView initial={review} />
    </main>
  );
}
