import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";

import { evaluateContractOutcome } from "../lib/contract-outcome.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

test("contract.output is the default artifact evidence when completion criteria are not explicit", async () => {
  const contractId = `TC-DEFAULT-OUTPUT-${Date.now()}`;
  const outputPath = `/tmp/${contractId}.md`;
  await writeFile(outputPath, "Final answer from default output artifact.\n", "utf8");

  try {
    const outcome = await evaluateContractOutcome(
      {
        id: contractId,
        task: "write default output",
        status: CONTRACT_STATUS.RUNNING,
        output: outputPath,
      },
      {
        collected: true,
        stageRunResult: {
          version: 1,
          status: "completed",
          summary: "runtime metadata reported completion",
          artifacts: [],
        },
        explicitRuntimeResult: true,
      },
    );

    assert.equal(outcome.status, CONTRACT_STATUS.COMPLETED);
    assert.equal(outcome.source, "completion_criteria");
  } finally {
    await unlink(outputPath).catch(() => {});
  }
});

test("runtime_result completed status is metadata and does not complete a contract without artifact evidence", async () => {
  const outcome = await evaluateContractOutcome(
    {
      id: "TC-RUNTIME-RESULT-ONLY",
      task: "answer hello",
      status: CONTRACT_STATUS.RUNNING,
      completionCriteria: {},
    },
    {
      collected: true,
      stageRunResult: {
        version: 1,
        status: "completed",
        summary: "runtime marked the stage complete",
        artifacts: [],
      },
      explicitRuntimeResult: true,
    },
  );

  assert.equal(outcome.status, CONTRACT_STATUS.FAILED);
  assert.equal(outcome.source, "completion_criteria");
  assert.equal(outcome.reason, "missing required artifact evidence");
});

test("runtime_result failed status remains an authoritative runtime failure signal", async () => {
  const outcome = await evaluateContractOutcome(
    {
      id: "TC-RUNTIME-RESULT-FAILED",
      task: "answer hello",
      status: CONTRACT_STATUS.RUNNING,
      completionCriteria: {},
    },
    {
      collected: true,
      stageRunResult: {
        version: 1,
        status: "failed",
        summary: "model could not produce a valid answer",
      },
      explicitRuntimeResult: true,
    },
  );

  assert.equal(outcome.status, CONTRACT_STATUS.FAILED);
  assert.equal(outcome.source, "runtime_result");
  assert.equal(outcome.reason, "model could not produce a valid answer");
});

test("runtime_result declared required artifacts all need filesystem evidence", async () => {
  const primaryPath = `/tmp/primary-artifact-${Date.now()}.md`;
  const missingSecondaryPath = `/tmp/missing-secondary-${Date.now()}.md`;
  await writeFile(primaryPath, "Primary artifact exists.\n", "utf8");

  try {
    const outcome = await evaluateContractOutcome(
      {
        id: "TC-RUNTIME-RESULT-SECONDARY",
        task: "produce two artifacts",
        status: CONTRACT_STATUS.RUNNING,
      },
      {
        collected: true,
        stageRunResult: {
          version: 1,
          status: "completed",
          summary: "runtime metadata reported completion",
          primaryArtifactPath: primaryPath,
          artifacts: [
            {
              type: "text_output",
              path: primaryPath,
              label: "primary",
              primary: true,
              required: true,
            },
            {
              type: "notes",
              path: missingSecondaryPath,
              label: "secondary",
              required: true,
            },
          ],
        },
        explicitRuntimeResult: true,
      },
    );

    assert.equal(outcome.status, CONTRACT_STATUS.FAILED);
    assert.equal(outcome.source, "completion_criteria");
    assert.match(outcome.reason, /secondary missing_file/);
  } finally {
    await unlink(primaryPath).catch(() => {});
    await unlink(missingSecondaryPath).catch(() => {});
  }
});
