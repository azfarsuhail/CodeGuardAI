import { Linter } from "eslint";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";
import { PositionEncoding, Workspace, type Diagnostic } from "@astral-sh/ruff-wasm-nodejs";
import { parse as parseJava } from "java-parser";
import type { FindingCategory, FixSafety, Language, Severity } from "../schemas.ts";
import type { RawFinding } from "./secrets.ts";

type Meta = [FindingCategory, Severity, FixSafety, string | null];

// ---------------------------------------------------------------------------
// ESLint (JavaScript / TypeScript)
// ---------------------------------------------------------------------------

const ESLINT_RULES: Record<string, Meta> = {
  "no-undef": ["bug", "high", "needs_review", "CWE-457"],
  "no-const-assign": ["bug", "high", "needs_review", null],
  "no-func-assign": ["bug", "medium", "needs_review", null],
  "use-isnan": ["bug", "high", "safe", "CWE-480"],
  "valid-typeof": ["bug", "high", "safe", "CWE-480"],
  "no-unsafe-negation": ["bug", "high", "safe", "CWE-480"],
  "no-unsafe-optional-chaining": ["bug", "high", "needs_review", "CWE-476"],
  "no-unreachable": ["bug", "medium", "safe", "CWE-561"],
  "no-dupe-keys": ["bug", "medium", "needs_review", null],
  "no-dupe-else-if": ["bug", "medium", "needs_review", "CWE-561"],
  "no-duplicate-case": ["bug", "medium", "needs_review", "CWE-561"],
  "no-constant-condition": ["bug", "medium", "needs_review", "CWE-570"],
  "no-self-compare": ["bug", "medium", "needs_review", "CWE-480"],
  "no-cond-assign": ["bug", "medium", "needs_review", "CWE-481"],
  "no-fallthrough": ["bug", "medium", "needs_review", "CWE-484"],
  "no-unsafe-finally": ["bug", "medium", "needs_review", "CWE-584"],
  "no-loss-of-precision": ["bug", "medium", "needs_review", "CWE-197"],
  "no-unmodified-loop-condition": ["bug", "medium", "needs_review", "CWE-835"],
  "no-async-promise-executor": ["bug", "medium", "needs_review", null],
  "no-promise-executor-return": ["bug", "low", "needs_review", null],
  "array-callback-return": ["bug", "medium", "needs_review", null],
  "getter-return": ["bug", "medium", "needs_review", null],
  "no-self-assign": ["bug", "low", "safe", null],
  "no-sparse-arrays": ["bug", "low", "safe", null],
  "no-eval": ["security", "high", "needs_review", "CWE-95"],
  "no-implied-eval": ["security", "high", "needs_review", "CWE-95"],
  "no-new-func": ["security", "high", "needs_review", "CWE-95"],
  "no-script-url": ["security", "medium", "needs_review", "CWE-79"],
  "no-await-in-loop": ["performance", "low", "needs_review", null],
  eqeqeq: ["quality", "low", "needs_review", "CWE-597"],
  "no-unused-vars": ["quality", "low", "safe", "CWE-563"],
  "no-var": ["quality", "low", "safe", null],
  "prefer-const": ["quality", "info", "safe", null],
  "no-empty": ["quality", "low", "needs_review", "CWE-390"],
  "no-shadow-restricted-names": ["quality", "medium", "safe", null],
};

const linter = new Linter({ configType: "flat" });
const JS_FILES = ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx", "**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"];

function runEslint(code: string, language: Language, fileName: string): RawFinding[] {
  const ts = language === "typescript";
  const jsx = /\.[jt]sx$/i.test(fileName);
  const rules = Object.fromEntries(
    Object.keys(ESLINT_RULES)
      .filter((r) => !(ts && r === "no-undef")) // TypeScript's own checker covers this; ESLint misfires on types
      .map((r) => [r, "warn" as const]),
  );
  const messages = linter.verify(
    code,
    [
      {
        files: JS_FILES,
        languageOptions: {
          ...(ts ? { parser: tsParser } : {}),
          parserOptions: { ecmaFeatures: { jsx } },
          globals: { ...globals.node, ...globals.browser },
        },
        rules,
      },
    ],
    fileName,
  );
  return messages.map((m) => {
    const line = Math.max(1, m.line);
    if (m.fatal || !m.ruleId) return syntaxError("eslint", m.message, line);
    const [category, severity, fix_safety, cwe] = ESLINT_RULES[m.ruleId] ?? ["quality", "low", "needs_review", null];
    return {
      tool: "eslint",
      rule: m.ruleId,
      message: m.message,
      category,
      severity,
      start_line: line,
      end_line: Math.max(line, m.endLine ?? line),
      cwe,
      fix_safety,
      fix_hint: m.suggestions?.[0]?.desc ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Ruff (Python), compiled to WebAssembly
// ---------------------------------------------------------------------------

let ruff: Workspace | null = null;

// F = pyflakes, E9 = syntax/IO errors, B = bugbear, S = bandit (security), PERF = perflint,
// PLE/PLW = pylint errors/warnings, A = shadowed builtins.
const RUFF_SELECT = ["F", "E9", "B", "S", "PERF", "PLE", "PLW", "A"];

const RUFF_SECURITY: Record<string, [Severity, string]> = {
  S102: ["high", "CWE-95"], // exec
  S105: ["high", "CWE-798"],
  S106: ["high", "CWE-798"],
  S107: ["high", "CWE-798"],
  S301: ["high", "CWE-502"], // pickle
  S307: ["high", "CWE-95"], // eval
  S324: ["medium", "CWE-327"],
  S501: ["high", "CWE-295"],
  S506: ["high", "CWE-502"], // yaml.load
  S602: ["high", "CWE-78"],
  S605: ["high", "CWE-78"],
  S608: ["high", "CWE-89"],
  S311: ["low", "CWE-330"],
  S101: ["info", "CWE-617"],
  S113: ["low", "CWE-400"],
};

function ruffMeta(code: string): Meta {
  if (code.startsWith("E9") || code.startsWith("PLE")) return ["bug", "high", "needs_review", null];
  if (code === "F821" || code === "F822" || code === "F823") return ["bug", "high", "needs_review", "CWE-457"];
  if (code.startsWith("S")) {
    const [severity, cwe] = RUFF_SECURITY[code] ?? ["medium", null];
    return ["security", severity, "needs_review", cwe];
  }
  if (code.startsWith("B")) return ["bug", "medium", "needs_review", null];
  if (code.startsWith("PERF")) return ["performance", "low", "needs_review", null];
  if (code === "F401" || code === "F841") return ["quality", "low", "safe", "CWE-563"];
  return ["quality", "low", "needs_review", null];
}

function runRuff(code: string): RawFinding[] {
  ruff ??= new Workspace({ "line-length": 120, lint: { select: RUFF_SELECT } }, PositionEncoding.Utf16);
  return (ruff.check(code) as Diagnostic[]).map((d) => {
    const rule = d.code ?? "invalid-syntax";
    const line = Math.max(1, d.start_location.row);
    if (rule === "invalid-syntax") return syntaxError("ruff", d.message, line);
    const [category, severity, fix_safety, cwe] = ruffMeta(rule);
    return {
      tool: "ruff",
      rule,
      message: d.message,
      category,
      severity,
      start_line: line,
      end_line: Math.max(line, d.end_location.row),
      cwe,
      fix_safety,
      fix_hint: d.fix?.message ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Java: syntax check via java-parser (the parser behind prettier-plugin-java)
// ---------------------------------------------------------------------------

function runJavaParser(code: string): RawFinding[] {
  try {
    parseJava(code);
    return [];
  } catch (e) {
    const m = /line: (\d+), column: (\d+)/.exec(e instanceof Error ? e.message : String(e));
    const line = m ? Number(m[1]) : 1;
    return [syntaxError("java-parser", `Syntax error: the parser could not continue at line ${line}${m ? `, column ${m[2]}` : ""}.`, line)];
  }
}

function syntaxError(tool: string, message: string, line: number): RawFinding {
  return {
    tool,
    rule: "syntax-error",
    message,
    category: "bug",
    severity: "high",
    start_line: line,
    end_line: line,
    cwe: null,
    fix_safety: "needs_review",
    fix_hint: null,
  };
}

export function runLinter(code: string, language: Language, fileName: string): RawFinding[] {
  if (language === "python") return runRuff(code);
  if (language === "java") return runJavaParser(code);
  return runEslint(code, language, fileName);
}
