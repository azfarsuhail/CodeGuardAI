import type { Language } from "./schemas.ts";

// Registry of supported languages (FR-012). Keys double as Monaco language ids.
// Add a language here, to the Language enum in schemas.ts, and to the Prisma enum.
export const LANGUAGES: Record<Language, { label: string; extensions: string[]; sample: string }> = {
  python: {
    label: "Python",
    extensions: [".py"],
    sample: `import sqlite3

API_KEY = "a1b2c3d4-hardcoded-demo-key"

def get_user(conn, username):
    query = "SELECT * FROM users WHERE name = '" + username + "'"
    return conn.execute(query).fetchone()

def average(scores):
    total = 0
    for s in scores:
        total += s
    return total / len(scores)

def has_duplicates(items):
    for i in range(len(items)):
        for j in range(len(items)):
            if i != j and items[i] == items[j]:
                return True
    return False
`,
  },
  javascript: {
    label: "JavaScript",
    extensions: [".js", ".mjs", ".cjs", ".jsx"],
    sample: `const { exec } = require("child_process");

const DB_PASSWORD = "hunter2-demo-password";

function listDir(req, res) {
  exec("ls " + req.query.path, (err, out) => res.send(out));
}

function findUser(users, id) {
  for (var i = 0; i <= users.length; i++) {
    if (users[i].id == id) return users[i];
  }
}

module.exports = { listDir, findUser };
`,
  },
  typescript: {
    label: "TypeScript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    sample: `interface Order {
  id: string;
  total: number;
  items: string[];
}

export function applyDiscount(order: Order, code: any): number {
  let discount;
  if (code === "SAVE10") discount = 0.1;
  return order.total - order.total * discount;
}

export function uniqueItems(orders: Order[]): string[] {
  const result: string[] = [];
  for (const o of orders)
    for (const item of o.items)
      if (!result.includes(item)) result.push(item);
  return result;
}

export async function loadOrder(id: string) {
  const res = await fetch("/api/orders/" + id);
  return res.json();
}
`,
  },
  java: {
    label: "Java",
    extensions: [".java"],
    sample: `import java.sql.*;

public class UserService {
    private static final String PASSWORD = "admin123";

    public User find(Connection conn, String name) throws SQLException {
        Statement st = conn.createStatement();
        ResultSet rs = st.executeQuery("SELECT * FROM users WHERE name = '" + name + "'");
        rs.next();
        return new User(rs.getString("name"));
    }

    public int average(int[] values) {
        int sum = 0;
        for (int i = 0; i < values.length; i++) sum += values[i];
        return sum / values.length;
    }
}
`,
  },
};

export const LANGUAGE_IDS = Object.keys(LANGUAGES) as Language[];

export function languageFromFileName(name: string): Language | null {
  const lower = name.toLowerCase();
  return LANGUAGE_IDS.find((id) => LANGUAGES[id].extensions.some((ext) => lower.endsWith(ext))) ?? null;
}

export function defaultFileName(language: Language): string {
  return `main${LANGUAGES[language].extensions[0]}`;
}

const SIGNALS: Record<Language, RegExp[]> = {
  python: [
    /^\s*def \w+\s*\(.*\)\s*(->\s*[^:]+)?:\s*$/m,
    /^\s*(elif|except|finally)\b.*:\s*$/m,
    /^\s*(from [\w.]+ )?import [\w.]+(\s+as \w+)?\s*$/m,
    /^\s*(for|while|if|class|with)\b[^{;]*:\s*$/m,
    /\bself\./,
    /\bprint\(/,
    /\b(None|True|False)\b/,
  ],
  java: [
    /\b(public|private|protected)\s+(static\s+)?(final\s+)?(class|interface|enum|void|int|long|double|boolean|String)\b/,
    /System\.out\.print/,
    /^\s*import java\./m,
    /^\s*package [\w.]+;/m,
    /\bString\[\]/,
  ],
  javascript: [
    /\b(const|let|var)\s+[\w{[]/,
    /=>/,
    /\bfunction\b/,
    /console\.\w+\(/,
    /\brequire\(/,
    /module\.exports|export (default|function|const|async)/,
    /[!=]==/,
  ],
  typescript: [
    /\binterface \w+(<[^>]*>)?\s*(extends [\w, <>]+)?\s*\{/,
    /\btype \w+(<[^>]*>)?\s*=/,
    /[)\w]\s*:\s*(string|number|boolean|any|unknown|void|never|Promise<|\w+\[\])/,
    /\bas (const|string|number|unknown)\b/,
    /\b(readonly|private|public) \w+\s*[:;=]/,
  ],
};

// ponytail: regex scoring, not a parser. Good enough for a "did you mean" hint; never blocks submission.
export function detectLanguage(code: string): Language | null {
  const hits = (lang: Language) => SIGNALS[lang].filter((re) => re.test(code)).length;
  const js = hits("javascript");
  const ts = hits("typescript");
  // TypeScript is a superset: JS signals count toward TS once any TS-only signal appears.
  const scores: [Language, number][] = [
    ["python", hits("python")],
    ["java", hits("java")],
    ["javascript", js],
    ["typescript", ts ? js + 2 * ts : 0],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [[best, top], [, second]] = scores;
  return top >= 2 && top > second ? best : null;
}
