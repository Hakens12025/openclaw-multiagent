import test from "node:test";
import assert from "node:assert/strict";

import { buildFinalModuleRun } from "../lib/harness/harness-module-evaluators.js";

const HARNESS_RUN = {
  automationId: "auto-1",
  round: 1,
  requestedAt: 1,
  startedAt: 1,
  status: "completed",
};

test("buildFinalModuleRun final-only branches consume canonical finalize evidence without legacy base residue", () => {
  const schemaRun = buildFinalModuleRun(
    "harness:gate.schema",
    HARNESS_RUN,
    { id: "auto-1" },
    {},
    {
      stageResult: {
        stage: "review",
        metadata: {
          schemaValid: true,
          schema: "review_finding_v1",
        },
      },
    },
  );
  assert.equal(schemaRun.status, "passed");
  assert.equal(schemaRun.evidence.stage, "review");

  const testRun = buildFinalModuleRun(
    "harness:gate.test",
    HARNESS_RUN,
    { id: "auto-1" },
    {
      terminalOutcome: {
        testsPassed: true,
      },
    },
    {},
  );
  assert.equal(testRun.status, "passed");
  assert.equal(testRun.evidence.status, "passed");

  const evalInputRun = buildFinalModuleRun(
    "harness:normalizer.eval_input",
    HARNESS_RUN,
    { id: "auto-1" },
    {},
    {
      summary: "artifact reviewed",
    },
  );
  assert.equal(evalInputRun.status, "passed");
  assert.equal(evalInputRun.evidence.summaryPresent, true);

  const failureRun = buildFinalModuleRun(
    "harness:normalizer.failure",
    HARNESS_RUN,
    { id: "auto-1" },
    {
      terminalOutcome: {
        reason: "task failed",
      },
    },
    {
      terminalStatus: "failed",
    },
  );
  assert.equal(failureRun.status, "passed");
  assert.equal(failureRun.evidence.failureClass, "failed");
});
