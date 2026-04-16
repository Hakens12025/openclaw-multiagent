import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("test-runner resetGateway uses explicitConfirm canonical payload", async () => {
  const source = await readFile("/Users/hakens/.openclaw/extensions/watchdog/test-runner.js", "utf8");

  assert.match(source, /explicitConfirm:\s*true/);
  assert.doesNotMatch(source, /confirm:\s*true/);
});
