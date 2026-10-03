import type { Metadata } from "next";
import Link from "next/link";
import { display, mono, sans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "CodeGuard AI",
  description:
    "Paste code and get a review that finds bugs, security holes and slow spots, and explains how to fix them.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable} antialiased`}>
      <body className="min-h-dvh">
        <header className="mx-auto max-w-5xl px-4 pt-6 sm:px-6">
          <Link
            href="/"
            className="font-display text-xl font-bold tracking-tight [font-stretch:90%] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
          >
            CodeGuard AI
          </Link>
        </header>
        {children}
      </body>
    </html>
  );
}
