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
const GROQ = "api.groq.com";
const OR = "openrouter.ai";
const unauthorized = () => new Response("Invalid API Key", { status: 401 });
const noZdrEndpoint = () => new Response('{"error":{"message":"No endpoints found matching your data policy"}}', { status: 404 });

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
  mockFetch({ [GROQ]: [reply('```json\n{"answer":"ok"}\n```')] });
  assert.deepEqual(await run(), { data: { answer: "ok" }, model: "groq:openai/gpt-oss-120b" });
  assert.deepEqual(calls, [GROQ]);
});

test("OpenRouter is the only fallback, with zero data retention always enforced", async () => {
  mockFetch({ [GROQ]: [unauthorized], [OR]: [reply('{"answer":"or"}')] });
  assert.deepEqual(await run(), { data: { answer: "or" }, model: "openrouter:nvidia/nemotron-3-super-120b-a12b" });
  assert.deepEqual(calls, [GROQ, OR]);
  assert.deepEqual(bodies[1].provider, { zdr: true, data_collection: "deny", require_parameters: true });
  assert.equal((bodies[1].response_format as { type: string }).type, "json_schema");
  assert.deepEqual(bodies[1].reasoning, { effort: "low", exclude: true });
});

test("a non-reasoning OpenRouter model is not sent `reasoning` (require_parameters would match no endpoint)", async () => {
  process.env.OPENROUTER_MODEL = "meta-llama/llama-3.1-8b-instruct";
  mockFetch({ [GROQ]: [unauthorized], [OR]: [reply('{"answer":"or"}')] });
  await run();
  assert.equal("reasoning" in bodies[1], false);
});

test("Gemini is never called, even with a key set; both down raises LlmUnavailableError", async () => {
  process.env.GEMINI_API_KEY = "still-set";
  mockFetch({ [GROQ]: [unauthorized], [OR]: [noZdrEndpoint] });
  await assert.rejects(run(), LlmUnavailableError);
  assert.deepEqual(calls, [GROQ, OR]);
});

test("free OpenRouter models are refused (their routes may train on prompts)", async () => {
  process.env.OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
  mockFetch({ [GROQ]: [unauthorized] });
  await assert.rejects(run(), LlmUnavailableError);
  assert.deepEqual(calls, [GROQ]);
});

test("upstream error inside a 200 body falls through to the next provider", async () => {
  mockFetch({ [GROQ]: [() => Response.json({ error: { code: 400, message: "Provider returned error" } })], [OR]: [reply('{"answer":"or"}')] });
  assert.equal((await run()).data.answer, "or");
});

test("retries once on schema violation, then falls back", async () => {
  mockFetch({ [GROQ]: [reply('{"answer":"too long"}'), reply("not json")], [OR]: [reply('{"answer":"or"}')] });
  assert.equal((await run()).data.answer, "or");
  assert.deepEqual(calls, [GROQ, GROQ, OR]);
  assert.match(JSON.stringify(bodies[1].messages), /previous response was rejected/);
});

test("Groq's strict-mode schema 400 gets the corrective retry, not a fallback (seen live)", async () => {
  const failed = '{"error":{"message":"Generated JSON does not match the expected schema. Please adjust your prompt. See \'failed_generation\' for more details. Error: jsonschema: \'/findings/0\' does not validate: missing properties: \'student_explanation\'","type":"invalid_request_error","code":"json_validate_failed"}}';
  mockFetch({ [GROQ]: [() => new Response(failed, { status: 400 }), reply('{"answer":"ok"}')] });
  assert.deepEqual(await run(), { data: { answer: "ok" }, model: "groq:openai/gpt-oss-120b" });
  assert.deepEqual(calls, [GROQ, GROQ]);
  assert.match(JSON.stringify(bodies[1].messages), /missing properties: 'student_explanation'/);
});

test("a transient 503 gets one back-off retry on the same model", async () => {
  mockFetch({ [GROQ]: [() => new Response("busy", { status: 503 }), reply('{"answer":"ok"}')] });
  assert.equal((await run()).data.answer, "ok");
  assert.deepEqual(calls, [GROQ, GROQ]);
});

test("a 429 waits for the provider's Retry-After before retrying", async () => {
  mockFetch({ [GROQ]: [() => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }), reply('{"answer":"ok"}')] });
  const started = Date.now();
  assert.equal((await run()).data.answer, "ok");
  assert.ok(Date.now() - started >= 950, "should wait ~1 s");
});

test("a 429 without Retry-After honours Groq's in-body 'try again in Xs' hint", async () => {
  mockFetch({ [GROQ]: [() => new Response('{"error":{"message":"Rate limit reached. Please try again in 1.2s."}}', { status: 429 }), reply('{"answer":"ok"}')] });
  const started = Date.now();
  assert.equal((await run()).data.answer, "ok");
  assert.ok(Date.now() - started >= 1150, "should wait ~1.2 s, not the 2 s default");
  assert.ok(Date.now() - started < 1900);
});

test("a network failure also gets one back-off retry", async () => {
  mockFetch({
    [GROQ]: [
      () => {
        throw new TypeError("fetch failed");
      },
      reply('{"answer":"ok"}'),
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

test("onWait hears about a back-off before it happens, and its failure can't break the review", async () => {
  mockFetch({ [GROQ]: [() => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }), reply('{"answer":"ok"}')] });
  const waits: number[] = [];
  const r = await generateStructured({
    system: "s", user: "u", schema, jsonSchema, deadlineMs: 10_000,
    onWait: (ms) => {
      waits.push(ms);
      throw new Error("database down");
    },
  });
  assert.equal(r.data.answer, "ok");
  assert.deepEqual(waits, [1000, 0]);
});

test("a rate limit is waited out up to three times before falling back; other errors once", async () => {
  const limited = () => new Response("slow down", { status: 429, headers: { "retry-after": "0.05" } });
  mockFetch({ [GROQ]: [limited, limited, limited, reply('{"answer":"ok"}')] });
  assert.equal((await run()).data.answer, "ok");
  assert.equal(calls.length, 4);
  calls = [];
  mockFetch({ [GROQ]: [() => new Response("busy", { status: 503 }), () => new Response("busy", { status: 503 })], [OR]: [reply('{"answer":"or"}')] });
  assert.equal((await run()).data.answer, "or");
  assert.deepEqual(calls, [GROQ, GROQ, OR]);
});
