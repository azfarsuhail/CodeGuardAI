import { createHmac, createSign, timingSafeEqual } from "node:crypto";

// DB-free GitHub App plumbing: config, webhook signatures, app JWT and a small REST client.
// Imported by unit tests, so relative imports only.

export type GitHubConfig = { appId: string; privateKey: string; webhookSecret: string };

/** null when the app isn't configured; callers answer 503 instead of crashing at import/build time. */
export function githubConfig(env: Record<string, string | undefined> = process.env): GitHubConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
  return appId && privateKey && webhookSecret ? { appId, privateKey, webhookSecret } : null;
}

/** Verifies X-Hub-Signature-256 ("sha256=<hex>") over the raw body in constant time. */
export function verifySignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"), "utf8");
  const given = Buffer.from(header.slice(7), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** RS256 app JWT. iat is backdated 60 s for clock drift; GitHub rejects exp more than 10 min ahead. */
export function createAppJwt(appId: string, privateKey: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const data = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(privateKey, "base64url")}`;
}

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

const API = "https://api.github.com";

async function call(token: string, method: string, url: string, body?: unknown): Promise<Response> {
  const res = await fetch(url.startsWith("http") ? url : API + url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "CodeGuard-AI",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const detail = await res.json().then((j: { message?: string }) => j.message, () => undefined);
    throw new GitHubError(res.status, `GitHub ${method} ${url.replace(API, "")} failed with ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res;
}

export async function githubRequest<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  return (await call(token, method, path, body)).json() as Promise<T>;
}

export async function getInstallationToken(cfg: GitHubConfig, installationId: number): Promise<string> {
  const jwt = createAppJwt(cfg.appId, cfg.privateKey);
  return (await githubRequest<{ token: string }>(jwt, "POST", `/app/installations/${installationId}/access_tokens`)).token;
}

export type PullFile = { filename: string; status: string; patch?: string; changes: number };

/** Follows Link rel="next" until `max` files are collected. */
export async function listPullFiles(token: string, repo: string, prNumber: number, max = 100): Promise<PullFile[]> {
  const files: PullFile[] = [];
  let url: string | null = `/repos/${repo}/pulls/${prNumber}/files?per_page=100`;
  while (url && files.length < max) {
    const res: Response = await call(token, "GET", url);
    files.push(...((await res.json()) as PullFile[]));
    url = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return files.slice(0, max);
}

/** File text at a commit, or null for binary files and files GitHub won't inline (over 1 MB). */
export async function getFileContent(token: string, repo: string, path: string, ref: string): Promise<string | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const file = await githubRequest<{ content?: string; encoding?: string }>(
    token,
    "GET",
    `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
  );
  if (file.encoding !== "base64" || typeof file.content !== "string") return null;
  const text = Buffer.from(file.content, "base64").toString("utf8");
  return text.includes("\u0000") ? null : text;
}
