import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("runtime reset admin surface passes runtime api into reset state", async () => {
  const source = await readFile(new URL("../lib/admin/operations/admin-surface-operations.js", import.meta.url), "utf8");

  assert.match(
    source,
    /"runtime\.reset":\s*\(\{\s*logger,\s*onAlert,\s*runtimeContext\s*\}\)\s*=>\s*resetRuntimeState\(\{[\s\S]*runtimeApi:\s*runtimeContext\?\.api\s*\|\|\s*null/,
  );
});
