import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  collectReviewerOutbox,
  collectWorkerOutbox,
} from "../lib/routing/runtime-mailbox-outbox-handlers.js";
import { agentWorkspace } from "../lib/state.js";
import {
  buildInitialTaskStagePlan,
  buildInitialTaskStageRuntime,
} from "../lib/task-stage-plan.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

async function writeActiveContract(agentId, contract) {
  const inboxDir = join(agentWorkspace(agentId), "inbox");
  await mkdir(inboxDir, { recursive: true });
  await writeFile(join(inboxDir, "contract.json"), JSON.stringify(contract, null, 2), "utf8");
}

async function cleanupWorkspace(agentId, artifactPath = null) {
  if (artifactPath) {
    await rm(artifactPath, { force: true }).catch(() => {});
  }
  await rm(agentWorkspace(agentId), { recursive: true, force: true }).catch(() => {});
}

test("collectWorkerOutbox carries semantic stage id from active contract truth without self-reported completion action", async () => {
  const agentId = `worker-stage-truth-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-WORKER-STAGE-TRUTH-${Date.now()}`;
  const stagePlan = buildInitialTaskStagePlan({
    contractId,
    stages: ["收集证据", "形成结论"],
  });
  const stageRuntime = buildInitialTaskStageRuntime({ stagePlan });
  const outputFileName = `worker-stage-truth-${Date.now()}.md`;
  let artifactPath = null;

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "收集证据并形成结论",
      assignee: agentId,
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
      stagePlan,
      stageRuntime,
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, outputFileName), "# worker result\n", "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: [outputFileName],
      logger,
      manifest: null,
    });
    artifactPath = result.primaryOutputPath;

    assert.equal(result.collected, true);
    assert.equal(result.stageRunResult?.semanticStageId, stageRuntime.currentStageId);
    assert.equal("semanticStageAction" in (result.stageRunResult || {}), false);
    assert.equal(result.stageCompletion?.status, "completed");
  } finally {
    await cleanupWorkspace(agentId, artifactPath);
  }
});

test("collectReviewerOutbox carries semantic stage id from active contract truth without self-reported completion action", async () => {
  const agentId = `reviewer-stage-truth-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-REVIEWER-STAGE-TRUTH-${Date.now()}`;
  const stagePlan = buildInitialTaskStagePlan({
    contractId,
    stages: ["代码审查"],
  });
  const stageRuntime = buildInitialTaskStageRuntime({ stagePlan });
  let artifactPath = null;

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "审查当前实现",
      assignee: agentId,
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
      stagePlan,
      stageRuntime,
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, "code_verdict.json"), JSON.stringify({
      verdict: "approve",
      feedback: "实现符合预期",
    }, null, 2), "utf8");

    const result = await collectReviewerOutbox({
      agentId,
      outboxDir,
      files: ["code_verdict.json"],
      logger,
      manifest: null,
    });
    artifactPath = result.primaryOutputPath;

    assert.equal(result.collected, true);
    assert.equal(result.stageRunResult?.semanticStageId, stageRuntime.currentStageId);
    assert.equal("semanticStageAction" in (result.stageRunResult || {}), false);
    assert.equal(result.stageCompletion?.status, "completed");
  } finally {
    await cleanupWorkspace(agentId, artifactPath);
  }
});
