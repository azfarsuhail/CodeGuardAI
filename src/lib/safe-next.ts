// Only same-site paths are allowed as post-login destinations ("//evil.com" and "https://..." are open redirects).
export function safeNext(next: string | null | undefined, fallback = "/history"): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : fallback;
}
