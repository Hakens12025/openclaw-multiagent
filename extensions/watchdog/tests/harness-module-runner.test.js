import test from "node:test";
import assert from "node:assert/strict";

import { finalizeHarnessRunModules } from "../lib/harness/harness-module-runner.js";

test("finalizeHarnessRunModules derives reviewerResult from canonical gate and normalizer module ids", async () => {
  const finalizedRun = await finalizeHarnessRunModules({
    automationId: "auto-runner-1",
    round: 1,
    requestedAt: Date.now() - 1000,
    startedAt: Date.now() - 500,
    status: "running",
    enabled: true,
    moduleRefs: [
      "harness:gate.artifact",
      "harness:normalizer.failure",
    ],
    coverage: {
      hardShaped: ["required_artifact_gate", "failure_classification"],
      softGuided: [],
      freeform: [],
    },
  }, {
    automationSpec: {
      id: "auto-runner-1",
    },
    terminalSource: {
      terminalOutcome: {
        reason: "task failed",
      },
    },
    terminalStatus: "failed",
    finalizedAt: Date.now(),
  });

  assert.equal(finalizedRun.reviewerResult?.verdict, "fail");
  assert.equal(finalizedRun.reviewerResult?.continueHint, "rework");
  assert.equal(finalizedRun.reviewerResult?.failureClass, "failed");
  assert.equal(finalizedRun.reviewerResult?.findings?.length, 1);
  assert.equal(finalizedRun.reviewerResult?.findings?.[0]?.category, "gate");
  assert.equal(finalizedRun.reviewerResult?.findings?.[0]?.severity, "error");
});
