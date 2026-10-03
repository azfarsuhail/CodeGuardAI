import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/login-form";
import { safeNext } from "@/lib/safe-next";
import { getViewer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Sign in | CodeGuard AI" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeNext(typeof params.next === "string" ? params.next : null);
  if (await getViewer()) redirect(next);
  const error = typeof params.error === "string" ? params.error.slice(0, 200) : null;
  return (
    <main className="mx-auto flex max-w-5xl px-4 pt-12 pb-16 sm:px-6">
      <LoginForm next={next} initialError={error} />
    </main>
  );
}
