import { AnalyzeForm } from "@/components/analyze-form";

export default async function Home({ searchParams }: PageProps<"/">) {
  const deleted = (await searchParams).account === "deleted";
  return (
    <main className="mx-auto max-w-5xl px-4 pt-10 pb-16 sm:px-6 sm:pt-14">
      {deleted && (
        <p role="status" className="mb-8 rounded-xl border border-[#75e0a7] bg-[#ecfdf3] px-4 py-3 text-sm font-bold text-[#05603a]">
          Your account and all of its reviews have been permanently deleted.
        </p>
      )}
      <h1 className="font-display text-[clamp(2.25rem,1.5rem+3.2vw,3.75rem)] leading-[1.02] font-bold tracking-[-0.02em] [font-stretch:88%]">
        A code review that explains itself.
      </h1>
      <p className="mt-4 max-w-[60ch] text-lg text-muted-foreground">
        Paste a file and CodeGuard checks it for bugs, security holes and slow spots, then tells you what&apos;s wrong,
        why it matters and how to fix it.
      </p>
      <AnalyzeForm className="mt-10" />
    </main>
  );
}
