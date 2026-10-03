import type { Metadata } from "next";
import Link from "next/link";
import { getViewer } from "@/lib/supabase/server";
import { display, mono, sans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "CodeGuard AI",
  description:
    "Paste code and get a review that finds bugs, security holes and slow spots, and explains how to fix them.",
};

const navLink =
  "rounded-sm font-bold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary";

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const viewer = await getViewer();
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable} antialiased`}>
      <body className="min-h-dvh">
        <header className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 pt-6 sm:px-6">
          <Link href="/" className={`font-display text-xl tracking-tight [font-stretch:90%] ${navLink}`}>
            CodeGuard AI
          </Link>
          <nav aria-label="Account" className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            {viewer ? (
              <>
                <Link href="/history" className={navLink}>
                  History
                </Link>
                <Link href="/settings" className={navLink}>
                  Settings
                </Link>
                {viewer.email && <span className="max-w-48 truncate text-muted-foreground">{viewer.email}</span>}
                <form action="/auth/signout" method="post">
                  <button type="submit" className={navLink}>
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              <Link href="/login" className={navLink}>
                Sign in
              </Link>
            )}
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
