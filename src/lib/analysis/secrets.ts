import type { StaticFinding } from "../schemas.ts";

export type RawFinding = Omit<StaticFinding, "id">;

// Credential-looking names assigned a string literal: API_KEY = "...", password: '...'.
const NAMED_SECRET =
  /\b([\w-]*(?:pass(?:word|wd)?|secret|api[_-]?key|apikey|token|private[_-]?key|access[_-]?key|auth[_-]?key|credential)[\w-]*)\s*[:=]\s*(["'`])([^"'`\n]{4,})\2/gi;

// Well-known token formats, wherever they appear.
const KNOWN_TOKENS: [RegExp, string][] = [
  [/AKIA[0-9A-Z]{16}/g, "AWS access key"],
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, "GitHub token"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "API secret key"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, "Slack token"],
  [/AIza[0-9A-Za-z_-]{35}/g, "Google API key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, "private key"],
];

// Same length as the secret so line/column positions survive masking.
const mask = (s: string) => s.slice(0, 2) + "•".repeat(Math.max(0, s.length - 2));

// Detects hard-coded secrets and masks them (FR-033): the masked code is what gets stored,
// sent to the LLM and shown in the UI, so the raw secret never leaves this function.
export function scanSecrets(code: string): { code: string; findings: RawFinding[] } {
  const findings: RawFinding[] = [];
  const lines = code.split("\n").map((text, i) => {
    const lineNo = i + 1;
    let out = text;
    for (const [re, label] of KNOWN_TOKENS) {
      out = out.replace(re, (m) => {
        findings.push(secretFinding(lineNo, `Hard-coded ${label} in source code.`, "critical"));
        return mask(m);
      });
    }
    out = out.replace(NAMED_SECRET, (whole, name: string, quote: string, value: string) => {
      if (value.includes("•")) return whole; // already masked by a known-token rule
      findings.push(secretFinding(lineNo, `Hard-coded credential assigned to \`${name}\`.`, "high"));
      return whole.slice(0, whole.length - value.length - 1) + mask(value) + quote;
    });
    return out;
  });
  return { code: lines.join("\n"), findings };
}

function secretFinding(line: number, message: string, severity: "critical" | "high"): RawFinding {
  return {
    tool: "secrets",
    rule: "hardcoded-secret",
    message,
    category: "security",
    severity,
    start_line: line,
    end_line: line,
    cwe: "CWE-798",
    fix_safety: "safe",
    fix_hint: "Load the value from an environment variable or secret manager, and rotate the exposed secret.",
  };
}
