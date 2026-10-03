import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { githubIdentity, plainSegments, reviewableFiles, userInstallationId } from "./browse.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const cfg = { appId: "1", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), webhookSecret: "s" };
const github = (identity_data: Record<string, unknown>) => ({ identities: [{ provider: "github", id: "x", identity_data } as never] });

test("githubIdentity reads the numeric GitHub id and login from the Supabase identity", () => {
  assert.deepEqual(githubIdentity(github({ provider_id: "583231", user_name: "octocat" })), { id: 583231, login: "octocat" });
  assert.equal(githubIdentity({ identities: [] }), null); // email-only account
  assert.equal(githubIdentity(github({ provider_id: "not-a-number", user_name: "octocat" })), null);
});

test("an installation counts only when its account id is the user's GitHub id (renamed logins can't borrow it)", async () => {
  const seen: string[] = [];
  const reply = (body: unknown, status = 200) => {
    globalThis.fetch = (async (url: string | URL) => {
      seen.push(String(url));
      return Response.json(body, { status });
    }) as typeof fetch;
  };
  reply({ id: 42, account: { id: 583231 } });
  assert.equal(await userInstallationId(cfg, { id: 583231, login: "octocat" }), 42);
  assert.match(seen[0], /\/users\/octocat\/installation$/);
  reply({ id: 42, account: { id: 999 } });
  assert.equal(await userInstallationId(cfg, { id: 583231, login: "octocat" }), null);
  reply({ message: "Not Found" }, 404);
  assert.equal(await userInstallationId(cfg, { id: 583231, login: "octocat" }), null);
});

test("only supported files within the review size limit are listed", () => {
  const files = reviewableFiles([
    { path: "src/app.ts", type: "blob", size: 900 },
    { path: "src", type: "tree" },
    { path: "README.md", type: "blob", size: 10 },
    { path: "big.py", type: "blob", size: 250_000 },
    { path: "Main.java", type: "blob", size: 1 },
  ]);
  assert.deepEqual(files.map((f) => f.path), ["src/app.ts", "Main.java"]);
});

test("dot segments are rejected so a path can't steer the token to another API endpoint", () => {
  assert.equal(plainSegments("src/app/main.py"), true);
  assert.equal(plainSegments("owner/repo"), true);
  for (const bad of ["../../user", "src/../../x", "./a", "a//b", "..", "a/"]) assert.equal(plainSegments(bad), false, bad);
});
