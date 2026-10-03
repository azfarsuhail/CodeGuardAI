import { z } from "zod";

export class LlmUnavailableError extends Error {}

type Call = (model: string, system: string, user: string, schema: unknown, signal: AbortSignal) => Promise<string>;
type Provider = { name: string; model: string; call: Call };

// Groq's strict mode validates the model's JSON itself and reports a mismatch as HTTP 400 (json_validate_failed):
// that is bad output, not a bad request, so it gets the same corrective retry as a Zod failure.
class InvalidOutputError extends Error {}

class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, message: string, retryAfterMs: number | null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// Rate limits and overload ("high demand") are usually momentary: worth one short back-off on the same model.
// Free tiers are tight (Groq: 8K tokens/min), so honour the provider's Retry-After when it's short.
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 10_000;
const MAX_OUTPUT_TOKENS = 8192;
// No single attempt may starve the tiers after it (a stalled free endpoint otherwise eats the whole deadline).
const PER_CALL_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Privacy-first cascade (PRD 18): only providers whose terms exclude training on submitted code.
//   1. Groq: API data is not used for training; ~7 s per review, inside the 30 s target (PRD 9).
//   2. OpenRouter, paid Nemotron, routed exclusively to zero-data-retention endpoints (enforced per request).
//      Its only ZDR endpoint is often rate-limited upstream, which is why it is the fallback, not the primary.
// No Gemini and no free-tier models: their terms allow training on prompts. If both fail, the review
// degrades to static-analysis results, so code never goes anywhere else.
export const OPENROUTER_DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";

function providers(): Provider[] {
  const list: Provider[] = [];
  if (process.env.GROQ_API_KEY) list.push({ name: "groq", model: process.env.GROQ_MODEL || "openai/gpt-oss-120b", call: callGroq });
  const orModel = process.env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL;
  // Free routes may train on prompts; refuse them outright rather than rely on ZDR routing to 404.
  if (process.env.OPENROUTER_API_KEY && !orModel.endsWith(":free")) list.push({ name: "openrouter", model: orModel, call: callOpenRouter });
  return list;
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && /json_validate_failed|does not match the expected schema/.test(text)) {
      throw new InvalidOutputError(/Error: (jsonschema:[^"]*)/.exec(text)?.[1]?.slice(0, 600) ?? "The JSON did not match the schema.");
    }
    // Retry-After header, or Groq's in-body hint ("Please try again in 4.545s").
    const seconds = Number(res.headers.get("retry-after")) || Number(/try again in ([\d.]+)s/i.exec(text)?.[1]);
    throw new HttpError(res.status, `HTTP ${res.status}: ${text.slice(0, 300)}`, seconds > 0 ? Math.ceil(seconds * 1000) : null);
  }
  return res.json();
}

// OpenAI-compatible chat completions (Groq, OpenRouter): same message + json_schema response_format shape.
async function chatCompletion(url: string, apiKey: string, payload: Record<string, unknown>, signal: AbortSignal) {
  const body = await post(url, { Authorization: `Bearer ${apiKey}` }, payload, signal);
  // OpenRouter can report upstream failures inside a 200 body.
  if (body.error) throw new HttpError(Number(body.error.code) || 502, `upstream: ${String(body.error.message).slice(0, 300)}`, null);
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error("output truncated (finish_reason length)");
  return (choice?.message?.content as string | undefined) ?? "";
}

const messages = (system: string, user: string) => [
  { role: "system", content: system },
  { role: "user", content: user },
];

const callGroq: Call = (model, system, user, schema, signal) => {
  const reasoning = model.startsWith("openai/gpt-oss");
  return chatCompletion(
    "https://api.groq.com/openai/v1/chat/completions",
    process.env.GROQ_API_KEY!,
    {
      model,
      temperature: 0.2,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      ...(reasoning ? { reasoning_effort: "low" } : {}),
      messages: messages(system, user),
      // Strict (constrained decoding) is only offered on some models; others get best-effort JSON + our Zod check.
      response_format: { type: "json_schema", json_schema: { name: "codeguard_output", strict: reasoning, schema } },
    },
    signal,
  );
};

const callOpenRouter: Call = (model, system, user, schema, signal) =>
  chatCompletion(
    "https://openrouter.ai/api/v1/chat/completions",
    process.env.OPENROUTER_API_KEY!,
    {
      model,
      temperature: 0.2,
      // Reasoning tokens count against max_tokens; Student Mode output alone can exceed 8K. (Groq stays at 8K: its TPM limit.)
      max_tokens: 2 * MAX_OUTPUT_TOKENS,
      messages: messages(system, user),
      response_format: { type: "json_schema", json_schema: { name: "codeguard_output", strict: true, schema } },
      // Unbounded reasoning can run for minutes and eat the output budget.
      reasoning: { effort: "low", exclude: true },
      // Always enforced, not configurable: route only to zero-data-retention endpoints that don't collect
      // data, and only to endpoints that honour response_format. No compliant endpoint -> 404 -> Groq.
      provider: { zdr: true, data_collection: "deny", require_parameters: true },
    },
    signal,
  );

// Providers reject some validation keywords; keep the shape (types, enums, required) and let Zod enforce limits.
const UNSUPPORTED = new Set(["$schema", "pattern", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "format"]);
export function providerSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(providerSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([k]) => !UNSUPPORTED.has(k))
      .map(([k, v]) => [k, k === "properties" ? Object.fromEntries(Object.entries(v as object).map(([p, s]) => [p, providerSchema(s)])) : providerSchema(v)]),
  );
}

// Models occasionally wrap JSON in fences despite instructions.
const unfence = (text: string) => text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

export async function generateStructured<T>(opts: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  jsonSchema: unknown;
  deadlineMs: number;
}): Promise<{ data: T; model: string }> {
  const list = providers();
  if (!list.length) throw new LlmUnavailableError("No AI provider is configured (set OPENROUTER_API_KEY or GROQ_API_KEY).");
  const schema = providerSchema(opts.jsonSchema);
  const deadline = Date.now() + opts.deadlineMs;
  const errors: string[] = [];

  for (const p of list) {
    const label = `${p.name}:${p.model}`;
    let user = opts.user;
    let backoffs = 1;
    // A second attempt for malformed output, one back-off for transient HTTP errors; anything else
    // (bad key, bad request, network failure) moves straight to the next provider.
    for (let attempt = 1; attempt <= 2; ) {
      const remaining = deadline - Date.now();
      if (remaining < 3000) {
        errors.push(`${label}: out of time`);
        break;
      }
      const reject = (issue: string) => {
        errors.push(`${label} attempt ${attempt}: invalid output`);
        user = `${opts.user}\n\nYour previous response was rejected:\n${issue}\nReturn a corrected JSON object only.`;
        attempt++;
      };
      let text: string;
      try {
        text = await p.call(p.model, opts.system, user, schema, AbortSignal.timeout(Math.min(remaining, PER_CALL_TIMEOUT_MS)));
      } catch (e) {
        if (e instanceof InvalidOutputError) {
          reject(e.message);
          continue;
        }
        errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
        // Network blips ("fetch failed") are as transient as a 503; a stalled call already used its 30 s, so move on.
        const transient = e instanceof HttpError ? TRANSIENT.has(e.status) : !(e instanceof Error && /Timeout|Abort/.test(e.name));
        const wait = Math.min(MAX_BACKOFF_MS, (e instanceof HttpError && e.retryAfterMs) || BACKOFF_MS);
        if (transient && backoffs-- > 0 && deadline - Date.now() > wait + 5000) {
          await sleep(wait);
          continue;
        }
        break;
      }
      let issue: string;
      try {
        const result = opts.schema.safeParse(JSON.parse(unfence(text)));
        if (result.success) {
          // Retry/fallback rates are an operational metric (PRD 19.2); log what it took to get here.
          if (errors.length) console.warn(`[llm] served by ${label} after: ${errors.join("; ").slice(0, 1000)}`);
          return { data: result.data, model: label };
        }
        issue = z.prettifyError(result.error).slice(0, 600); // short: the retry must fit the same token budget
      } catch {
        issue = "The response was not valid JSON.";
      }
      reject(issue);
    }
  }
  throw new LlmUnavailableError(errors.join("; "));
}
