import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("test-runner no longer derives contract terminal status from track_end residue", async () => {
  const source = await readFile("/Users/hakens/.openclaw/extensions/watchdog/test-runner.js", "utf8");

  assert.match(source, /\bwaitForTerminalContractStatus\b/);
  assert.doesNotMatch(source, /contractStatus = statusEvent\.data\?\.status \|\| "completed"/);
});
