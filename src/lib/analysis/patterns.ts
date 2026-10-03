import type { FindingCategory, FixSafety, Language, Severity } from "../schemas.ts";
import type { RawFinding } from "./secrets.ts";

type Rule = {
  rule: string;
  languages: Language[];
  /** Tested against the raw line; the line must also contain code once comments/strings are stripped. */
  test: (raw: string) => boolean;
  message: string;
  category: FindingCategory;
  severity: Severity;
  cwe: string | null;
  fix_safety: FixSafety;
  fix_hint: string;
};

const ALL: Language[] = ["python", "javascript", "typescript", "java"];
const JS: Language[] = ["javascript", "typescript"];

const SQL = /\b(?:select\b[\s\S]*\bfrom|insert\s+into|update\b[\s\S]*\bset|delete\s+from)\b/i;
const DYNAMIC_STRING = /["'`]\s*\+|\+\s*["'`]|\$\{|\bf["']|\.format\(|["']\s*%\s*[(\w]/;

// ponytail: line-level regex rules (a Semgrep stand-in). Misses multi-line taint flows; the AI pass covers those.
const RULES: Rule[] = [
  {
    rule: "sql-string-building",
    languages: ALL,
    test: (l) => SQL.test(l) && DYNAMIC_STRING.test(l),
    message: "SQL query built by concatenating or formatting values into the query string.",
    category: "security",
    severity: "high",
    cwe: "CWE-89",
    fix_safety: "safe",
    fix_hint: "Use a parameterised query with placeholders and pass the values separately.",
  },
  {
    rule: "shell-command-injection",
    languages: JS,
    test: (l) => /\bexec(?:Sync)?\s*\(\s*(?:["'`][^"'`]*["'`]\s*\+|`[^`]*\$\{|\w+\s*\+)/.test(l),
    message: "Shell command built from dynamic input.",
    category: "security",
    severity: "high",
    cwe: "CWE-78",
    fix_safety: "needs_review",
    fix_hint: "Use execFile/spawn with an argument array and validate the input against an allow-list.",
  },
  {
    rule: "shell-command-injection",
    languages: ["java"],
    test: (l) => /Runtime\.getRuntime\(\)\.exec\s*\([^)]*\+|new\s+ProcessBuilder\s*\([^)]*\+/.test(l),
    message: "Process command built by string concatenation.",
    category: "security",
    severity: "high",
    cwe: "CWE-78",
    fix_safety: "needs_review",
    fix_hint: "Pass the command and arguments as separate array elements and validate the input.",
  },
  {
    rule: "string-reference-equality",
    languages: ["java"],
    test: (l) => /"[^"]*"\s*[!=]=(?!=)|[!=]=\s*"/.test(l),
    message: "String compared with == or !=, which compares references, not contents.",
    category: "bug",
    severity: "medium",
    cwe: "CWE-597",
    fix_safety: "safe",
    fix_hint: 'Use "literal".equals(value) to compare string contents.',
  },
  {
    rule: "weak-hash",
    languages: ["java"],
    test: (l) => /MessageDigest\.getInstance\(\s*"(?:MD5|SHA-?1)"/i.test(l),
    message: "Weak hash algorithm (MD5/SHA-1).",
    category: "security",
    severity: "medium",
    cwe: "CWE-327",
    fix_safety: "needs_review",
    fix_hint: "Use SHA-256 or stronger; for passwords use bcrypt, scrypt or Argon2.",
  },
  {
    rule: "weak-hash",
    languages: JS,
    test: (l) => /createHash\(\s*["'](?:md5|sha1)["']/i.test(l),
    message: "Weak hash algorithm (MD5/SHA-1).",
    category: "security",
    severity: "medium",
    cwe: "CWE-327",
    fix_safety: "needs_review",
    fix_hint: "Use sha256 or stronger; for passwords use bcrypt, scrypt or Argon2.",
  },
  {
    rule: "unsafe-deserialization",
    languages: ["java"],
    test: (l) => /new\s+ObjectInputStream\s*\(/.test(l),
    message: "Java deserialization of a stream that may contain untrusted data.",
    category: "security",
    severity: "high",
    cwe: "CWE-502",
    fix_safety: "manual_only",
    fix_hint: "Avoid native deserialization of untrusted data; use a data format such as JSON with explicit types.",
  },
  {
    rule: "empty-catch",
    languages: ["java", ...JS],
    test: (l) => /catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(l),
    message: "Exception caught and silently ignored.",
    category: "quality",
    severity: "low",
    cwe: "CWE-390",
    fix_safety: "needs_review",
    fix_hint: "Handle the error, log it, or let it propagate.",
  },
  {
    rule: "dom-xss-sink",
    languages: JS,
    test: (l) => /\.(?:innerHTML|outerHTML)\s*\+?=|document\.write\s*\(/.test(l),
    message: "HTML written directly into the DOM.",
    category: "security",
    severity: "medium",
    cwe: "CWE-79",
    fix_safety: "needs_review",
    fix_hint: "Use textContent, or sanitise the HTML before inserting it.",
  },
  {
    rule: "tls-verification-disabled",
    languages: JS,
    test: (l) => /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/.test(l),
    message: "TLS certificate verification disabled.",
    category: "security",
    severity: "high",
    cwe: "CWE-295",
    fix_safety: "needs_review",
    fix_hint: "Keep certificate verification on; trust a specific CA instead if needed.",
  },
  {
    rule: "explicit-any",
    languages: ["typescript"],
    test: (l) => /[:<,]\s*any\b(?!\s*\()/.test(l),
    message: "Explicit `any` turns off type checking for this value.",
    category: "quality",
    severity: "info",
    cwe: null,
    fix_safety: "needs_review",
    fix_hint: "Use a specific type, a union, or `unknown` with a type guard.",
  },
];

export function scanPatterns(code: string, stripped: string, language: Language): RawFinding[] {
  const raw = code.split("\n");
  const codeOnly = stripped.split("\n");
  const findings: RawFinding[] = [];
  const rules = RULES.filter((r) => r.languages.includes(language));
  raw.forEach((line, i) => {
    if (!codeOnly[i]?.trim()) return; // comment-only or blank line
    for (const r of rules) {
      if (!r.test(line)) continue;
      const { rule, message, category, severity, cwe, fix_safety, fix_hint } = r;
      findings.push({ tool: "patterns", rule, message, category, severity, cwe, fix_safety, fix_hint, start_line: i + 1, end_line: i + 1 });
    }
  });
  return findings;
}
