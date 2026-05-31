import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dashboard-graph no longer owns loop flow animation side effects", async () => {
  const source = await readFile(new URL("../dashboard-graph.js", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\baddActiveFlow\b/);
  assert.doesNotMatch(source, /\bremoveFlowLine\b/);
  assert.doesNotMatch(source, /flow\.type === ['"]loop['"]/);
});
