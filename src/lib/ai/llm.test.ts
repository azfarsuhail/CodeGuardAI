import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { LlmUnavailableError, generateStructured, providerSchema } from "./llm.ts";

const schema = z.object({ answer: z.string().max(5) });
const jsonSchema = z.toJSONSchema(schema);
const realFetch = globalThis.fetch;
let calls: string[] = [];

function mockFetch(responses: Record<string, Array<() => Response>>) {
  globalThis.fetch = (async (url: string | URL) => {
    const host = new URL(String(url)).host;
    calls.push(host);
    const next = responses[host]?.shift();
    if (!next) throw new Error(`unexpected call to ${host}`);
    return next();
  }) as typeof fetch;
}
const groqReply = (content: string) => () => Response.json({ choices: [{ message: { content } }] });
const geminiReply = (text: string) => () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] });

beforeEach(() => {
  calls = [];
  process.env.GROQ_API_KEY = "test-groq";
  process.env.GEMINI_API_KEY = "test-gemini";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

const run = () => generateStructured({ system: "s", user: "u", schema, jsonSchema, deadlineMs: 10_000 });

test("returns validated output and strips code fences", async () => {
  mockFetch({ "api.groq.com": [groqReply('```json\n{"answer":"ok"}\n```')] });
  assert.deepEqual(await run(), { data: { answer: "ok" }, model: "groq:openai/gpt-oss-120b" });
});

test("retries once on schema violation, then falls back to the next provider", async () => {
  mockFetch({
    "api.groq.com": [groqReply('{"answer":"too long"}'), groqReply("not json")],
    "generativelanguage.googleapis.com": [geminiReply('{"answer":"gem"}')],
  });
  const out = await run();
  assert.equal(out.data.answer, "gem");
  assert.deepEqual(calls, ["api.groq.com", "api.groq.com", "generativelanguage.googleapis.com"]);
});

test("a transient 503 gets one back-off retry on the same model", async () => {
  mockFetch({ "api.groq.com": [() => new Response("high demand", { status: 503 }), groqReply('{"answer":"ok"}')] });
  assert.equal((await run()).data.answer, "ok");
  assert.deepEqual(calls, ["api.groq.com", "api.groq.com"]);
});

test("a 429 waits for the provider's Retry-After before retrying", async () => {
  mockFetch({ "api.groq.com": [() => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }), groqReply('{"answer":"ok"}')] });
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
      groqReply('{"answer":"ok"}'),
    ],
  });
  assert.equal((await run()).data.answer, "ok");
  assert.deepEqual(calls, ["api.groq.com", "api.groq.com"]);
});

test("auth errors skip straight to the next provider; Gemini overload falls back to the lite model", async () => {
  const overloaded = () => new Response("high demand", { status: 503 });
  mockFetch({
    "api.groq.com": [() => new Response("Invalid API Key", { status: 401 })],
    "generativelanguage.googleapis.com": [overloaded, overloaded, geminiReply('{"answer":"lite"}')],
  });
  const out = await run();
  assert.equal(out.model, "gemini:gemini-3.5-flash-lite");
  assert.deepEqual(calls, ["api.groq.com", ...Array(3).fill("generativelanguage.googleapis.com")]);
});

test("everything failing raises LlmUnavailableError", async () => {
  const down = () => new Response("down", { status: 400 });
  mockFetch({ "api.groq.com": [down], "generativelanguage.googleapis.com": [down, down] });
  await assert.rejects(run(), LlmUnavailableError);
  assert.equal(calls.length, 3);
});

test("no provider configured is reported as unavailable", async () => {
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(run(), /No AI provider/);
});

test("provider schema drops validation keywords but keeps structure", () => {
  const s = providerSchema(jsonSchema) as { properties: { answer: Record<string, unknown> }; required: string[] };
  assert.deepEqual(s.properties.answer, { type: "string" });
  assert.deepEqual(s.required, ["answer"]);
  assert.equal("$schema" in s, false);
});
