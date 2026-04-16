import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("test-runner waits for delivery artifact persistence before validating output", async () => {
  const source = await readFile("/Users/hakens/.openclaw/extensions/watchdog/test-runner.js", "utf8");

  assert.match(source, /\bwaitForDeliveryArtifacts\b/);
  assert.match(source, /await waitForDeliveryArtifacts\(contractId/);
  assert.doesNotMatch(source, /delivery\.path/);
});
