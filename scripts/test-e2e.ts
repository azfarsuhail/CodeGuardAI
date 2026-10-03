// End-to-end check of the review pipeline against the running app and the live Supabase database.
//   npm run dev            (in another terminal)
//   npm run test:e2e       (node --env-file=.env scripts/test-e2e.ts)
// Set E2E_BASE_URL to test a deployment instead of localhost.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { aiReview, staticReview } from "../src/lib/pipeline.ts";
import { ReviewDetail, CreateReviewRequest } from "../src/lib/schemas.ts";
import { computeScores } from "../src/lib/scoring.ts";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const POLL_MS = 2000;
const TIMEOUT_MS = 120_000;

// A unique secret per run, so finding it anywhere in the database proves masking failed.
const SECRET = `e2e-${randomBytes(12).toString("hex")}`;
const CODE = `import sqlite3

API_KEY = "${SECRET}"

def find_duplicates(items):
    duplicates = []
    for i in range(len(items)):
        for j in range(len(items)):
            if i != j and items[i] == items[j] and items[i] not in duplicates:
                duplicates.append(items[i])
    return duplicates

def count_users(conn):
    return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
`;
const SECRET_LINE = 3;
const LOOP_LINES = [7, 10];

const results: [string, boolean, string?][] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push([name, true]);
  } catch (e) {
    results.push([name, false, e instanceof Error ? e.message.split("\n")[0] : String(e)]);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Submit through the real route and poll until the AI stage completes.
// ---------------------------------------------------------------------------
const t0 = performance.now();
const post = await fetch(`${BASE}/api/reviews`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ code: CODE, language: "python", mode: "student", file_name: "duplicates.py" }),
});
const accepted = await post.json();
const postMs = performance.now() - t0;
if (post.status !== 202) {
  console.error(`POST /api/reviews returned ${post.status}:`, accepted);
  process.exit(1);
}
const id: string = accepted.review_id;
console.log(`POST /api/reviews -> 202 in ${(postMs / 1000).toFixed(2)}s, review_id=${id}, status=${accepted.status}`);

const statuses: string[] = [];
let firstPoll: ReviewDetail | null = null;
let detail: ReviewDetail;
for (;;) {
  const res = await fetch(`${BASE}/api/reviews/${id}`);
  assert.equal(res.status, 200, `GET returned ${res.status}`);
  detail = ReviewDetail.parse(await res.json()); // also validates the API contract
  firstPoll ??= detail;
  statuses.push(detail.status);
  if (detail.status === "completed" || detail.status === "failed") break;
  if (performance.now() - t0 > TIMEOUT_MS) throw new Error(`Review still ${detail.status} after ${TIMEOUT_MS / 1000}s`);
  await sleep(POLL_MS);
}
const totalMs = performance.now() - t0;
console.log(`Polled ${statuses.length}x (${[...new Set(statuses)].join(" -> ")}), completed in ${(totalMs / 1000).toFixed(1)}s total\n`);

// ---------------------------------------------------------------------------
// 2. Verify the report.
// ---------------------------------------------------------------------------
const lines = CODE.split("\n");
const f = detail.findings;

await check("202 Accepted returned in under 5 s (static stage only)", () => assert.ok(postMs < 5000, `${postMs.toFixed(0)} ms`));
await check("first poll already had static findings (progressive results)", () =>
  assert.ok(firstPoll!.findings.length > 0 && firstPoll!.scores !== null),
);
await check("status reached completed within the 30 s target", () => {
  assert.equal(detail.status, "completed");
  assert.ok(totalMs < 30_000, `${(totalMs / 1000).toFixed(1)} s`);
});
await check("AI stage ran (not a static-only fallback)", () =>
  assert.equal(detail.static_only, false, `notice: ${detail.notice}`),
);
await check("secret masked in returned code", () => {
  assert.ok(!detail.original_code.includes(SECRET));
  assert.ok(detail.original_code.split("\n")[SECRET_LINE - 1].includes("•"));
});
await check("secret not leaked in any finding text", () =>
  assert.ok(!JSON.stringify(f).includes(SECRET)),
);
await check("hard-coded secret reported as Verified security finding, high or above", () => {
  const s = f.find((x) => x.category === "security" && x.location.start_line === SECRET_LINE);
  assert.ok(s, "no security finding on the secret line");
  assert.ok(["critical", "high"].includes(s.severity), s.severity);
  assert.notEqual(s.source, "ai", "should be backed by static evidence");
  assert.equal(s.cwe, "CWE-798");
});
await check("O(n^2) nested loop reported as performance with a risky (non-safe) fix", () => {
  // The model may cite just the loop or the whole function; either must overlap the loop lines.
  const p = f.find((x) => x.category === "performance" && x.location.start_line <= LOOP_LINES[1] && x.location.end_line >= LOOP_LINES[0]);
  assert.ok(p, "no performance finding on the nested loop");
  assert.notEqual(p.fix_safety, "safe");
  const fn = detail.metrics?.functions.find((m) => m.name === "find_duplicates");
  assert.match(fn?.time_complexity ?? "", /n\s*(\^|\*\*)\s*2|n²|n\s*\*\s*n/i);
});
await check("static evidence merged with AI output (at least one 'both' finding)", () =>
  assert.ok(f.some((x) => x.source === "both")),
);
await check("every finding cites a real, non-empty line", () => {
  for (const x of f) {
    assert.ok(x.location.start_line >= 1 && x.location.end_line <= lines.length, `${x.id} out of range`);
    assert.ok(lines[x.location.start_line - 1].trim(), `${x.id} cites a blank line`);
  }
});
await check("no performance/maintainability fix is classified safe", () =>
  assert.ok(f.every((x) => !(x.fix_safety === "safe" && ["performance", "maintainability"].includes(x.category)))),
);
await check("student mode: explanations under ~80 words and concept primers present", () => {
  for (const x of f.filter((x) => x.source !== "static"))
    assert.ok(x.student_explanation && x.student_explanation.split(/\s+/).length <= 90, `${x.id} explanation missing/too long`);
  assert.ok(detail.concept_primers.length > 0);
});
await check("scores match the Section 13 formula and every deduction maps to a finding", () => {
  const expected = computeScores(f);
  assert.deepEqual(detail.scores, expected);
  const ids = new Set(f.map((x) => x.id));
  assert.ok(expected.deductions.every((d) => ids.has(d.finding_ref)));
  assert.ok(expected.security < 100 && expected.performance < 100);
});

// ---------------------------------------------------------------------------
// 3. Verify persistence directly in Supabase.
// ---------------------------------------------------------------------------
// Remote pooled connections occasionally reset; one reconnect keeps a network blip from failing the run.
async function connect(): Promise<pg.Client> {
  for (let attempt = 1; ; attempt++) {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15_000 });
    client.on("error", (e) => console.warn(`  (db connection error: ${e.message})`));
    try {
      await client.connect();
      await client.query("SELECT 1");
      return client;
    } catch (e) {
      await client.end().catch(() => {});
      if (attempt >= 3) throw e;
      await sleep(1000 * attempt);
    }
  }
}
const db = await connect();
try {
  const { rows: [row] } = await db.query(
    `SELECT "originalCode", status, model, "promptVersion", "staticOnly", "clientHash" FROM "Review" WHERE id = $1`,
    [id],
  );
  await check("review row persisted with model and prompt version", () => {
    assert.ok(row, "row missing");
    assert.equal(row.status, "completed");
    assert.ok(row.model && row.promptVersion);
    assert.match(row.clientHash ?? "", /^[0-9a-f]{32}$/);
  });
  await check("stored code is masked (raw secret never reached the database)", () => {
    assert.ok(!row.originalCode.includes(SECRET));
  });
  const { rows: [counts] } = await db.query(
    `SELECT (SELECT count(*) FROM "Finding" WHERE "reviewId" = $1)::int AS findings,
            (SELECT count(*) FROM "Metrics" WHERE "reviewId" = $1)::int AS metrics,
            (SELECT count(*) FROM "Finding" WHERE "reviewId" = $1
               AND concat_ws(' ', title, problem, why, fix, "fixCode", "studentExplanation") LIKE '%' || $2 || '%')::int AS leaks`,
    [id, SECRET],
  );
  await check("findings and metrics rows persisted; no secret in stored findings", () => {
    assert.equal(counts.findings, f.length);
    assert.equal(counts.metrics, 1);
    assert.equal(counts.leaks, 0);
  });
  const { rows: rls } = await db.query(
    `SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
       AND relname IN ('User','Review','Finding','FixVersion','Metrics')`,
  );
  await check("row-level security enabled on all tables (REST API locked)", () => {
    assert.equal(rls.length, 5);
    assert.ok(rls.every((r) => r.relrowsecurity), JSON.stringify(rls));
  });
} finally {
  await db.end();
}

// ---------------------------------------------------------------------------
// 4. Phase 4 endpoints: Fix All Safe Issues and false-positive feedback.
// ---------------------------------------------------------------------------
{
  const fixRes = await fetch(`${BASE}/api/reviews/${id}/fix`, { method: "POST" });
  const version = await fixRes.json();
  const after = ReviewDetail.parse(await (await fetch(`${BASE}/api/reviews/${id}`)).json());
  await check(`Fix All Safe Issues creates a new version (${fixRes.status}, validated=${version.validated})`, () => {
    assert.equal(fixRes.status, 201, JSON.stringify(version));
    assert.notEqual(version.code, detail.original_code);
    assert.ok(version.changes.length > 0 && version.changes.every((c: { safety: string }) => c.safety === "safe"));
    if (!version.validated) console.log(`  (validation flagged: ${version.validation_errors.join("; ")})`);
  });
  await check("original code is unchanged after fixing, and the version is listed", () => {
    assert.equal(after.original_code, detail.original_code);
    assert.equal(after.fix_versions[0]?.id, version.id);
  });
  const optIn = f.find((x) => x.fix_safety === "needs_review" && x.fix_code);
  if (optIn) {
    const res = await fetch(`${BASE}/api/reviews/${id}/fix`, { method: "POST", body: JSON.stringify({ finding_ids: [optIn.id] }) });
    const v = await res.json();
    await check("needs-review fix applies only when explicitly listed", () => {
      assert.equal(res.status, 201);
      assert.deepEqual(v.changes.map((c: { finding_ref: string }) => c.finding_ref), [optIn.id]);
    });
  }

  const target = f.find((x) => x.category === "security")!;
  const flag = async (status: string) =>
    (await fetch(`${BASE}/api/reviews/${id}/findings/${target.id}`, { method: "PATCH", body: JSON.stringify({ status }) })).json();
  const flagged = await flag("false_positive");
  const reopened = await flag("open");
  await check("marking a false positive rescores (security rises), undo restores it", () => {
    assert.ok(flagged.scores.security > detail.scores!.security, `${flagged.scores.security} vs ${detail.scores!.security}`);
    assert.equal(reopened.scores.security, detail.scores!.security);
  });
}

// ---------------------------------------------------------------------------
// 5. Provider cascade, live: break providers in-process and re-run the AI stage.
// ---------------------------------------------------------------------------
const req = CreateReviewRequest.parse({ code: CODE, language: "python", mode: "developer", file_name: "duplicates.py" });
const { analysis } = staticReview(req);
const real = { openrouter: process.env.OPENROUTER_API_KEY, groq: process.env.GROQ_API_KEY, gemini: process.env.GEMINI_API_KEY };
const BROKEN = "invalid-key-for-fallback-test";
const silence = console.error;
const silenceWarn = console.warn;
const providerErrors: string[] = [];
console.error = (...args: unknown[]) => providerErrors.push(args.map(String).join(" ")); // expected; shown on failure
console.warn = console.error;
try {
  if (real.openrouter) {
    process.env.OPENROUTER_API_KEY = BROKEN;
    const tier2 = await aiReview(req, analysis, 45_000);
    await check(`OpenRouter rejected -> tier 2 Groq serves the review (${tier2.model ?? "none"})`, () => assert.match(tier2.model ?? "none", /^groq:/));
  }
  if (real.gemini) {
    process.env.OPENROUTER_API_KEY = BROKEN;
    process.env.GROQ_API_KEY = BROKEN;
    const tier3 = await aiReview(req, analysis, 45_000);
    await check(`OpenRouter and Groq rejected -> tier 3 Gemini serves the review (${tier3.model ?? "none"})`, () =>
      assert.match(tier3.model ?? "none", /^gemini:/),
    );
  }

  for (const k of ["OPENROUTER_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY"]) if (process.env[k]) process.env[k] = BROKEN;
  const degraded = await aiReview(req, analysis, 20_000);
  await check("both providers down -> static-only report with notice, still scored", () => {
    assert.equal(degraded.model, null);
    assert.ok(degraded.notice);
    assert.ok(degraded.findings.length > 0 && degraded.findings.every((x) => x.source === "static"));
    assert.ok(degraded.scores.overall < 100);
  });
} finally {
  process.env.OPENROUTER_API_KEY = real.openrouter;
  process.env.GROQ_API_KEY = real.groq;
  process.env.GEMINI_API_KEY = real.gemini;
  console.error = silence;
  console.warn = silenceWarn;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`Model: ${detail.model}  prompt: ${detail.prompt_version}  pipeline duration: ${detail.duration_ms} ms`);
console.log(`Scores: ${JSON.stringify({ ...detail.scores, deductions: detail.scores?.deductions.length })}\n`);
for (const x of f)
  console.log(
    `  ${x.id} ${x.severity.padEnd(8)} ${x.category.padEnd(15)} ${x.source.padEnd(6)} L${x.location.start_line}-${x.location.end_line} ${x.fix_safety.padEnd(12)} conf=${x.confidence} ${x.cwe ?? ""}  ${x.title}`,
  );
console.log("");
for (const [name, ok, why] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${why ? `  (${why})` : ""}`);
const failed = results.filter(([, ok]) => !ok).length;
if (failed) for (const e of providerErrors) console.log(`  provider log: ${e.slice(0, 400)}`);
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
