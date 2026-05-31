import test from "node:test";
import assert from "node:assert/strict";

import { waitForCliRunCompletion } from "../lib/test-runner-cli-client.js";

test("test-runner completion waits for formal run status, not contract status residue", async () => {
  const details = [
    {
      status: "running",
      currentCaseId: "simple-01",
      contractRuntime: { contractStatus: "completed" },
      terminalOutcome: { status: "completed" },
    },
    {
      status: "completed",
      currentCaseId: null,
      passedCases: 1,
      failedCases: 0,
      blockedCases: 0,
    },
  ];
  let polls = 0;

  const result = await waitForCliRunCompletion({
    runId: "TR-residue",
    requestJSON: async () => {
      polls += 1;
      return details.shift();
    },
    sleep: async () => {},
    pollIntervalMs: 1,
    timeoutMs: 100,
  });

  assert.equal(polls, 2);
  assert.equal(result.status, "completed");
});
