import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGUAGE_IDS, LANGUAGES, detectLanguage, languageFromFileName } from "./languages.ts";

test("detects every bundled sample as its own language", () => {
  for (const id of LANGUAGE_IDS) assert.equal(detectLanguage(LANGUAGES[id].sample), id, id);
});

test("stays quiet on ambiguous or tiny input", () => {
  assert.equal(detectLanguage(""), null);
  assert.equal(detectLanguage("x = 1"), null);
});

test("maps file extensions", () => {
  assert.equal(languageFromFileName("App.TSX"), "typescript");
  assert.equal(languageFromFileName("server.mjs"), "javascript");
  assert.equal(languageFromFileName("Main.java"), "java");
  assert.equal(languageFromFileName("notes.txt"), null);
});
