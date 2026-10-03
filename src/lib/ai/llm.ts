import { z } from "zod";

export class LlmUnavailableError extends Error {}

type Call = (model: string, system: string, user: string, schema: unknown, signal: AbortSignal) => Promise<string>;
type Provider = { name: string; model: string; call: Call };

class HttpError extends Error {}

// Groq first: its API terms exclude customer data from training (PRD 18). Gemini's free tier does not.
function providers(): Provider[] {
  const list: Provider[] = [];
  if (process.env.GROQ_API_KEY) list.push({ name: "groq", model: process.env.GROQ_MODEL || "openai/gpt-oss-120b", call: callGroq });
  if (process.env.GEMINI_API_KEY) list.push({ name: "gemini", model: process.env.GEMINI_MODEL || "gemini-3.6-flash", call: callGemini });
  return list;
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new HttpError(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const callGroq: Call = async (model, system, user, schema, signal) => {
  const reasoning = model.startsWith("openai/gpt-oss");
  const body = await post(
    "https://api.groq.com/openai/v1/chat/completions",
    { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    {
      model,
      temperature: 0.2,
      max_completion_tokens: 16384,
      ...(reasoning ? { reasoning_effort: "low" } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // Strict (constrained decoding) is only offered on some models; others get best-effort JSON + our Zod check.
      response_format: { type: "json_schema", json_schema: { name: "codeguard_output", strict: reasoning, schema } },
    },
    signal,
  );
  return body.choices?.[0]?.message?.content ?? "";
};

const callGemini: Call = async (model, system, user, schema, signal) => {
  const body = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { "x-goog-api-key": process.env.GEMINI_API_KEY! },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 16384,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
        // Gemini 3.x: low thinking keeps a review inside the 30 s budget (PRD 9).
        ...(model.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
      },
    },
    signal,
  );
  const candidate = body.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== "STOP") throw new Error(`finishReason ${candidate.finishReason}`);
  return (candidate?.content?.parts ?? [])
    .filter((p: { thought?: boolean }) => !p.thought)
    .map((p: { text?: string }) => p.text ?? "")
    .join("");
};

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
  if (!list.length) throw new LlmUnavailableError("No AI provider is configured (set GROQ_API_KEY or GEMINI_API_KEY).");
  const schema = providerSchema(opts.jsonSchema);
  const deadline = Date.now() + opts.deadlineMs;
  const errors: string[] = [];

  for (const p of list) {
    let user = opts.user;
    // Second attempt only for malformed output; HTTP/network failures move straight to the next provider.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 3000) {
        errors.push(`${p.name}: out of time`);
        break;
      }
      let text: string;
      try {
        text = await p.call(p.model, opts.system, user, schema, AbortSignal.timeout(remaining));
      } catch (e) {
        errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
      let issue: string;
      try {
        const result = opts.schema.safeParse(JSON.parse(unfence(text)));
        if (result.success) return { data: result.data, model: `${p.name}:${p.model}` };
        issue = z.prettifyError(result.error).slice(0, 2000);
      } catch {
        issue = "The response was not valid JSON.";
      }
      errors.push(`${p.name} attempt ${attempt}: invalid output`);
      user = `${opts.user}\n\nYour previous response was rejected:\n${issue}\nReturn a corrected JSON object only.`;
    }
  }
  throw new LlmUnavailableError(errors.join("; "));
}
