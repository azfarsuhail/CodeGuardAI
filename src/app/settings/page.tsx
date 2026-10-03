import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DeleteAccount } from "@/components/account/delete-account";
import { prisma } from "@/lib/prisma";
import { getViewer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Settings | CodeGuard AI" };

export default async function SettingsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login?next=/settings");
  const reviewCount = await prisma.review.count({ where: { userId: viewer.id } });

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 pt-8 pb-16 sm:px-6">
      <h1 className="font-display text-[clamp(1.875rem,1.4rem+2vw,2.75rem)] leading-tight font-bold tracking-[-0.02em] [font-stretch:88%]">
        Account settings
      </h1>
      <section aria-labelledby="account-heading" className="rounded-xl border border-border bg-card p-5">
        <h2 id="account-heading" className="font-display text-xl font-bold [font-stretch:90%]">
          Account
        </h2>
        <dl className="mt-3 grid gap-2 text-[15px] sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">Email</dt>
          <dd className="font-bold">{viewer.email ?? "Signed in with GitHub"}</dd>
          <dt className="text-muted-foreground">Saved reviews</dt>
          <dd className="font-bold">{reviewCount}</dd>
        </dl>
      </section>
      <DeleteAccount email={viewer.email} reviewCount={reviewCount} />
    </main>
  );
}
