import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { LlmUnavailableError, generateStructured, providerSchema } from "./llm.ts";

const schema = z.object({ answer: z.string().max(5) });
const jsonSchema = z.toJSONSchema(schema);
const realFetch = globalThis.fetch;
let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];

function mockFetch(responses: Record<string, Array<() => Response>>) {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const host = new URL(String(url)).host;
    calls.push(host);
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const next = responses[host]?.shift();
    if (!next) throw new Error(`unexpected call to ${host}`);
    return next();
  }) as typeof fetch;
}
const reply = (content: string) => () => Response.json({ choices: [{ message: { content } }] });
const ENV = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "GROQ_API_KEY", "GEMINI_API_KEY"];

beforeEach(() => {
  calls = [];
  bodies = [];
  for (const k of ENV) delete process.env[k];
  process.env.OPENROUTER_API_KEY = "test-openrouter";
  process.env.GROQ_API_KEY = "test-groq";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) delete process.env[k];
});

const run = () => generateStructured({ system: "s", user: "u", schema, jsonSchema, deadlineMs: 10_000 });

test("Groq is primary", async () => {
  mockFetch({ "api.groq.com": [reply('```json\n{"answer":"ok"}\n```')] });
  assert.deepEqual(await run(), { data: { answer: "ok" }, model: "groq:openai/gpt-oss-120b" });
  assert.deepEqual(calls, ["api.groq.com"]);
});

test("OpenRouter is the only fallback, with zero data retention always enforced", async () => {
  mockFetch({
    "api.groq.com": [() => new Response("Invalid API Key", { status: 401 })],
    "openrouter.ai": [reply("{\"answer\":\"or\"}")],
  });
  assert.deepEqual(await run(), { data: { answer: "or" }, model: "openrouter:nvidia/nemotron-3-super-120b-a12b" });
  assert.deepEqual(calls, ["api.groq.com", "openrouter.ai"]);
  assert.deepEqual(bodies[1].provider, { zdr: true, data_collection: "deny", require_parameters: true });
  assert.equal((bodies[1].response_format as { type: string }).type, "json_schema");
});

test("Gemini is never called, even with a key set; both down raises LlmUnavailableError", async () => {
  process.env.GEMINI_API_KEY = "still-set";
  mockFetch({
    "api.groq.com": [() => new Response("Invalid API Key", { status: 401 })],
    "openrouter.ai": [() => new Response("{\"error\":{\"message\":\"No endpoints found matching your data policy\"}}", { status: 404 })],
  });
  await assert.rejects(run(), LlmUnavailableError);
  assert.deepEqual(calls, ["api.groq.com", "openrouter.ai"]);
});

test("free OpenRouter models are refused (their routes may train on prompts)", async () => {
  process.env.OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
  mockFetch({ "api.groq.com": [() => new Response("Invalid API Key", { status: 401 })] });
  await assert.rejects(run(), LlmUnavailableError);
  assert.deepEqual(calls, ["api.groq.com"]);
});

test("upstream error inside a 200 body falls through to the next provider", async () => {
  mockFetch({
    "api.groq.com": [() => Response.json({ error: { code: 400, message: "Provider returned error" } })],
    "openrouter.ai": [reply("{\"answer\":\"or\"}")],
  });
  assert.equal((await run()).data.answer, "or");
});

test("retries once on schema violation, then falls back", async () => {
  mockFetch({
    "api.groq.com": [reply("{\"answer\":\"too long\"}"), reply("not json")],
    "openrouter.ai": [reply("{\"answer\":\"or\"}")],
  });
  assert.equal((await run()).data.answer, "or");
  assert.deepEqual(calls, ["api.groq.com", "api.groq.com", "openrouter.ai"]);
  assert.match(JSON.stringify(bodies[1].messages), /previous response was rejected/);
});

test("a transient 503 gets one back-off retry on the same model", async () => {
  mockFetch({ "api.groq.com": [() => new Response("busy", { status: 503 }), reply("{\"answer\":\"ok\"}")] });
  assert.equal((await run()).data.answer, "ok");
  assert.deepEqual(calls, ["api.groq.com", "api.groq.com"]);
});

test("a 429 waits for the provider's Retry-After before retrying", async () => {
  mockFetch({ "api.groq.com": [() => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }), reply("{\"answer\":\"ok\"}")] });
  const started = Date.now();
  assert.equal((await run()).data.answer, "ok");
  assert.ok(Date.now() - started >= 950, "should wait ~1 s");
});

test("a network failure also gets one back-off retry", async () => {
  mockFetch({
    "api.groq.com": [
      () => {
        throw new TypeError("fetch failed");
      },
      reply("{\"answer\":\"ok\"}"),
    ],
  });
  assert.equal((await run()).data.answer, "ok");
});

test("no provider configured is reported as unavailable", async () => {
  for (const k of ENV) delete process.env[k];
  await assert.rejects(run(), /No AI provider/);
});

test("provider schema drops validation keywords but keeps structure", () => {
  const s = providerSchema(jsonSchema) as { properties: { answer: Record<string, unknown> }; required: string[] };
  assert.deepEqual(s.properties.answer, { type: "string" });
  assert.deepEqual(s.required, ["answer"]);
  assert.equal("$schema" in s, false);
});
