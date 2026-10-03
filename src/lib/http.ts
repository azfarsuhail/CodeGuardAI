import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

// PRD 15 error model: { error: { code, message, details } }.
export function apiError(status: number, code: string, message: string, details?: unknown, headers?: HeadersInit) {
  return NextResponse.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, { status, headers });
}

// Salted hash so raw IPs are never stored.
export function clientHash(req: Request): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(`${process.env.RATE_LIMIT_SALT ?? ""}:${ip}`).digest("hex").slice(0, 32);
}
