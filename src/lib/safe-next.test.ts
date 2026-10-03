import { test } from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "./safe-next.ts";

test("post-login redirects stay on this site", () => {
  assert.equal(safeNext("/reset-password"), "/reset-password");
  assert.equal(safeNext("/history?language=java"), "/history?language=java");
  for (const evil of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "evil.example", ""])
    assert.equal(safeNext(evil), "/history", evil);
  assert.equal(safeNext(null), "/history");
});
