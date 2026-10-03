import { LIMITS, type Language, type Severity, type StaticFinding, type StaticMetrics } from "../schemas.ts";
import { runLinter } from "./linters.ts";
import { computeMetrics, stripCode } from "./metrics.ts";
import { scanPatterns } from "./patterns.ts";
import { scanSecrets, type RawFinding } from "./secrets.ts";

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export type StaticAnalysis = {
  /** Submitted code with secrets masked. This is the only copy that is stored or sent anywhere. */
  code: string;
  findings: StaticFinding[];
  metrics: StaticMetrics;
};

// Deterministic first stage of the pipeline (PRD 10): secrets -> linter -> patterns -> metrics.
export function runStaticAnalysis(rawCode: string, language: Language, fileName: string): StaticAnalysis {
  const { code, findings: secrets } = scanSecrets(rawCode);
  const stripped = stripCode(code, language);
  const { metrics, findings: metricFindings } = computeMetrics(stripped, language);

  let lint: RawFinding[] = [];
  try {
    lint = runLinter(code, language, fileName);
  } catch (e) {
    // An analyzer crash must not sink the review; the other stages and the AI still run.
    console.error(`[analysis] ${language} linter failed`, e);
  }

  const lineCount = code.split("\n").length;
  const all = [...secrets, ...lint, ...scanPatterns(code, stripped, language), ...metricFindings].map((f) => {
    const start = Math.min(Math.max(1, f.start_line), lineCount);
    return { ...f, start_line: start, end_line: Math.min(Math.max(start, f.end_line), lineCount) };
  });

  // Several tools can flag the same issue (e.g. Ruff S608 and the SQL pattern): keep the most severe per line+category.
  const best = new Map<string, RawFinding>();
  for (const f of all) {
    const key = `${f.category}:${f.start_line}`;
    const prev = best.get(key);
    if (!prev || SEVERITY_RANK[f.severity] < SEVERITY_RANK[prev.severity]) best.set(key, f);
  }

  const findings = [...best.values()]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.start_line - b.start_line)
    .slice(0, LIMITS.maxStaticFindings)
    .sort((a, b) => a.start_line - b.start_line)
    .map((f, i) => ({ id: `S-${i + 1}`, ...f }));

  return { code, findings, metrics };
}
