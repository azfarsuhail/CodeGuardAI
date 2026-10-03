import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { createAppJwt, getInstallationToken, githubConfig, GitHubError, listPullFiles, verifySignature } from "./client.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

test("verifySignature accepts the right HMAC and rejects wrong or missing ones", () => {
  const body = '{"zen":"Keep it logically awesome."}';
  const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
  assert.equal(verifySignature("s3cret", body, sig), true);
  assert.equal(verifySignature("other", body, sig), false);
  assert.equal(verifySignature("s3cret", body + " ", sig), false);
  assert.equal(verifySignature("s3cret", body, sig.slice(0, -2)), false);
  assert.equal(verifySignature("s3cret", body, null), false);
  assert.equal(verifySignature("s3cret", body, sig.replace("sha256=", "sha1=")), false);
});

test("githubConfig needs all three vars and unescapes \\n in the key", () => {
  assert.equal(githubConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k" }), null);
  const cfg = githubConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "-----BEGIN-----\\nabc\\n-----END-----", GITHUB_WEBHOOK_SECRET: "s" });
  assert.equal(cfg?.privateKey, "-----BEGIN-----\nabc\n-----END-----");
});

test("createAppJwt makes a verifiable RS256 JWT with backdated iat and 9 min exp", () => {
  const now = 1_700_000_000_000;
  const jwt = createAppJwt("12345", pem, now);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url").toString()), { iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: "12345" });
  assert.equal(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, s, "base64url"), true);
});

type Call = { url: string; init: RequestInit };
function mockFetch(responses: Response[]) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses.shift()!;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}
const json = (v: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(v), { status: 200, ...init });

test("getInstallationToken exchanges the app JWT for an installation token", async () => {
  const m = mockFetch([json({ token: "ghs_abc" }, { status: 201 })]);
  try {
    const token = await getInstallationToken({ appId: "7", privateKey: pem, webhookSecret: "x" }, 99);
    assert.equal(token, "ghs_abc");
    assert.equal(m.calls[0].url, "https://api.github.com/app/installations/99/access_tokens");
    assert.equal(m.calls[0].init.method, "POST");
    const headers = m.calls[0].init.headers as Record<string, string>;
    assert.match(headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(headers.Accept, "application/vnd.github+json");
    assert.ok(headers["User-Agent"]);
  } finally {
    m.restore();
  }
});

test("listPullFiles follows Link rel=next and stops at the cap", async () => {
  const page = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ filename: `f${from + i}.ts`, status: "added", changes: 1 }));
  const m = mockFetch([
    json(page(100, 0), { headers: { link: '<https://api.github.com/repositories/1/pulls/2/files?per_page=100&page=2>; rel="next", <https://x>; rel="last"' } }),
    json(page(60, 100)),
  ]);
  try {
    const files = await listPullFiles("t", "o/r", 2, 150);
    assert.equal(files.length, 150);
    assert.equal(files[149].filename, "f149.ts");
    assert.equal(m.calls[0].url, "https://api.github.com/repos/o/r/pulls/2/files?per_page=100");
    assert.equal(m.calls[1].url, "https://api.github.com/repositories/1/pulls/2/files?per_page=100&page=2");
  } finally {
    m.restore();
  }
  const m2 = mockFetch([json(page(100, 0), { headers: { link: '<https://api.github.com/next>; rel="next"' } })]);
  try {
    assert.equal((await listPullFiles("t", "o/r", 2)).length, 100);
    assert.equal(m2.calls.length, 1);
  } finally {
    m2.restore();
  }
});

test("HTTP errors surface as GitHubError with the status code", async () => {
  const m = mockFetch([json({ message: "Not Found" }, { status: 404 })]);
  try {
    await assert.rejects(listPullFiles("t", "o/r", 2), (e: unknown) => e instanceof GitHubError && e.status === 404 && /Not Found/.test(e.message));
  } finally {
    m.restore();
  }
});
