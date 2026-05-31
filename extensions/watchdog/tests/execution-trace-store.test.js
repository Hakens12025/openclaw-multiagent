import test from "node:test";
import assert from "node:assert/strict";

import {
  clearAllTraces,
  evaluateTrace,
  initTrace,
  recordStep,
} from "../lib/store/execution-trace-store.js";

test.afterEach(() => {
  clearAllTraces();
});

test("blocked write attempts do not mark contract.output as committed", () => {
  const sessionKey = `agent:worker:test:${Date.now()}`;
  const outputPath = `/tmp/${Date.now()}-trace-output.md`;

  initTrace(sessionKey, {
    id: "TC-trace-output-guard",
    output: outputPath,
  });

  recordStep(sessionKey, {
    tool: "write",
    targetPath: outputPath,
    writeSucceeded: false,
  });

  const verdict = evaluateTrace(sessionKey);
  assert.equal(verdict?.outputCommitted, false);
});
