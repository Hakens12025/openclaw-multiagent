import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
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

async function cleanupWorkspace(agentId, artifactPaths = []) {
  for (const artifactPath of artifactPaths) {
    await rm(artifactPath, { force: true }).catch(() => {});
  }
  await rm(agentWorkspace(agentId), { recursive: true, force: true }).catch(() => {});
}

test("collectWorkerOutbox requires runtime_result.json and collects declared artifacts", async () => {
  const agentId = `worker-runtime-result-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-RUNTIME-RESULT-${Date.now()}`;
  const outputFileName = `${contractId}.md`;
  const stagePlan = buildInitialTaskStagePlan({
    contractId,
    stages: ["完成用户目标"],
  });
  const stageRuntime = buildInitialTaskStageRuntime({ stagePlan });
  let artifactPaths = [];

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "回答今天星期几",
      assignee: agentId,
      output: join(agentWorkspace("controller"), "output", `${contractId}.md`),
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
      stagePlan,
      stageRuntime,
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, outputFileName), "今天是星期二。\n", "utf8");
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "Answered the weekday question.",
      artifacts: [{
        type: "text_output",
        path: outputFileName,
        label: "final_answer",
        primary: true,
        required: true,
      }],
      primaryArtifactPath: outputFileName,
      completion: {
        status: "completed",
        transition: { kind: "follow_graph", reason: "completed" },
      },
    }, null, 2), "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["runtime_result.json", outputFileName],
      logger,
    });
    artifactPaths = result.artifactPaths || [];

    assert.equal(result.collected, true);
    assert.equal(result.explicitRuntimeResult, true);
    assert.equal(result.stageRunResult?.semanticStageId, stageRuntime.currentStageId);
    assert.equal(result.stageCompletion?.transition?.kind, "follow_graph");
    assert.equal(result.primaryOutputPath?.endsWith(`/${outputFileName}`), true);
  } finally {
    await cleanupWorkspace(agentId, artifactPaths);
  }
});

test("collectWorkerOutbox rejects stage_result.json and contract_result.json as legacy dual truth", async () => {
  const agentId = `worker-runtime-result-reject-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-RUNTIME-RESULT-REJECT-${Date.now()}`;

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "legacy result should not be accepted",
      assignee: agentId,
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, "legacy.md"), "legacy output\n", "utf8");
    await writeFile(join(outboxDir, "stage_result.json"), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "legacy stage result",
    }), "utf8");
    await writeFile(join(outboxDir, "contract_result.json"), JSON.stringify({
      status: "completed",
      summary: "legacy contract result",
    }), "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["stage_result.json", "contract_result.json", "legacy.md"],
      logger,
    });

    assert.equal(result.collected, false);
    assert.match(result.error || "", /runtime_result\.json/);
  } finally {
    await cleanupWorkspace(agentId);
  }
});

test("collectWorkerOutbox carries reviewer verdict through runtime_result without reviewer-specific outbox files", async () => {
  const agentId = `reviewer-runtime-result-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-REVIEWER-RUNTIME-RESULT-${Date.now()}`;
  const reviewNotesFileName = `${contractId}-review.md`;
  const stagePlan = buildInitialTaskStagePlan({
    contractId,
    stages: ["Review implementation"],
  });
  const stageRuntime = buildInitialTaskStageRuntime({ stagePlan });
  let artifactPaths = [];

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "Review current implementation",
      assignee: agentId,
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
      stagePlan,
      stageRuntime,
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, reviewNotesFileName), "Implementation needs one regression test.\n", "utf8");
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "Review completed.",
      artifacts: [{
        type: "notes",
        path: reviewNotesFileName,
        label: "review_notes",
        primary: true,
        required: true,
      }],
      primaryArtifactPath: reviewNotesFileName,
      reviewVerdict: {
        verdict: "reject",
        feedback: "Missing regression test.",
        issues: [{ severity: "error", description: "No regression test covers the failure." }],
      },
      reviewerResult: {
        source: "system_action_review_delivery",
        verdict: "fail",
        continueHint: "rework",
        findings: [{ severity: "error", message: "No regression test covers the failure." }],
      },
      completion: {
        status: "completed",
        transition: { kind: "follow_graph", reason: "review_completed" },
      },
    }, null, 2), "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["runtime_result.json", reviewNotesFileName],
      logger,
    });
    artifactPaths = result.artifactPaths || [];

    assert.equal(result.collected, true);
    assert.equal(result.stageRunResult?.semanticStageId, stageRuntime.currentStageId);
    assert.equal(result.reviewVerdict?.verdict, "reject");
    assert.equal(result.reviewerResult?.verdict, "fail");
    assert.equal(result.reviewerResult?.continueHint, "rework");
    assert.equal(result.artifactKind, "code_review");
  } finally {
    await cleanupWorkspace(agentId, artifactPaths);
  }
});
