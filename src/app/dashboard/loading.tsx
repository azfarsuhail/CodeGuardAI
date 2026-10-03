export default function DashboardLoading() {
  return (
    <main aria-busy className="mx-auto max-w-5xl px-4 pt-8 pb-16 sm:px-6">
      <p role="status" className="sr-only">
        Loading your progress
      </p>
      <div aria-hidden className="h-11 w-56 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
      <div aria-hidden className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        ))}
      </div>
      <div aria-hidden className="mt-6 h-80 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
    </main>
  );
}
