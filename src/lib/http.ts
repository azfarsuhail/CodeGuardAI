import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

// PRD 15 error model: { error: { code, message, details } }.
export function apiError(status: number, code: string, message: string, details?: unknown, headers?: HeadersInit) {
  return NextResponse.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status, headers });
}

// Rate-limit key: the account for signed-in users, a salted hash of the IP for guests (raw IPs are never stored).
export function clientHash(req: Request, userId?: string | null): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
  const subject = userId ? `user:${userId}` : `ip:${ip}`;
  return createHash("sha256").update(`${process.env.RATE_LIMIT_SALT ?? ""}:${subject}`).digest("hex").slice(0, 32);
}
