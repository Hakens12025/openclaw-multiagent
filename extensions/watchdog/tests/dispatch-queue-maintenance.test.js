import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const INDEX_SOURCE_URL = new URL("../index.js", import.meta.url);

test("watchdog periodic maintenance runs full dispatch queue maintenance", async () => {
  const source = await readFile(INDEX_SOURCE_URL, "utf8");

  assert.match(source, /export async function maintainDispatchQueue/);
  assert.match(source, /await reconcileDispatchRuntimeTruth\(logger\)/);
  assert.match(source, /await syncDispatchTargetsFromRuntime\(logger\)/);
  assert.match(source, /await drainIdleDispatchTargets\(api,\s*logger\)/);
  assert.match(source, /await persistDispatchRuntimeState\(logger\)/);
  assert.match(source, /void maintainDispatchQueue\(\{\s*api,\s*logger\s*\}\)/);
});

test("watchdog index keeps dispatch maintenance wiring in the entrypoint only", async () => {
  const source = await readFile(INDEX_SOURCE_URL, "utf8");

  assert.doesNotMatch(source, /from "node:path";\nimport \{[^}]*basename/u);
  assert.doesNotMatch(source, /scanPendingContracts/);
});
