import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  collectWorkerOutbox,
} from "../lib/routing/runtime-mailbox-outbox-handlers.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
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
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "worker result",
      artifacts: [
        { type: "text_output", path: outputFileName, primary: true, required: true },
      ],
      primaryArtifactPath: outputFileName,
      completion: { status: "completed" },
    }, null, 2), "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["runtime_result.json", outputFileName],
      logger,
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

// Regression: the task-facing inbox copy STRIPS `output` (not in TASK_FACING_INBOX_ALLOW_KEYS), but the
// SHARED contract carries it. collectWorkerOutbox must resolve `output` from the shared contract so the
// worker's primary mirrors to the canonical contract.output path — otherwise evaluateContractOutcome fails
// the contract with "contract.output missing_file" despite a real delivery (live-reproduced: a "讲个笑话"
// dispatch showed contract→failed; with this resolution it shows completed).
test("collectWorkerOutbox mirrors the primary to the SHARED contract.output when the inbox copy strips it", async () => {
  const agentId = `worker-output-mirror-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-WORKER-OUTPUT-MIRROR-${Date.now()}`;
  const canonicalOutput = join(tmpdir(), `oc-mirror-${contractId}.md`);
  let artifactPath = null;
  try {
    // inbox copy = task-facing, NO `output` (exactly what stageInboxContract writes)
    await writeActiveContract(agentId, {
      id: contractId, task: "讲个笑话", assignee: agentId, status: "running",
    });
    // shared contract (routing truth) HAS output → the canonical deliverable path
    await persistContractSnapshot(getContractPath(contractId), {
      id: contractId, task: "讲个笑话", assignee: agentId, status: "running", output: canonicalOutput,
    });
    await mkdir(outboxDir, { recursive: true });
    // worker wrote a free-named artifact + a minimal runtime_result (status completed, primaryArtifactPath,
    // NO artifacts[] array) — the real-world shape that previously failed.
    await writeFile(join(outboxDir, "artifact.md"), "# 笑话\n\nOct 31 = Dec 25\n", "utf8");
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1, status: "completed", summary: "joke", primaryArtifactPath: "artifact.md",
    }), "utf8");

    const result = await collectWorkerOutbox({
      agentId, outboxDir, files: ["runtime_result.json", "artifact.md"], logger,
    });
    artifactPath = result.primaryOutputPath;

    const mirrored = await readFile(canonicalOutput, "utf8").catch(() => null);
    assert.ok(mirrored && mirrored.includes("Oct 31"), "primary mirrored to the shared contract.output canonical path");
  } finally {
    await rm(canonicalOutput, { force: true }).catch(() => {});
    await rm(getContractPath(contractId), { force: true }).catch(() => {});
    await cleanupWorkspace(agentId, artifactPath);
  }
});

test("collectWorkerOutbox treats all artifact files as committed artifacts when runtime_result is minimal", async () => {
  const agentId = `worker-stage-minimal-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-WORKER-STAGE-MINIMAL-${Date.now()}`;
  const stagePlan = buildInitialTaskStagePlan({
    contractId,
    stages: ["整理资料", "形成结论"],
  });
  const stageRuntime = buildInitialTaskStageRuntime({ stagePlan });
  const primaryFileName = `worker-stage-minimal-${Date.now()}.md`;
  const secondaryFileName = `worker-stage-minimal-${Date.now()}.json`;
  let primaryArtifactPath = null;
  let collectedArtifactPaths = [];

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "整理资料并形成结论",
      assignee: agentId,
      output: join(agentWorkspace("controller"), "output", `${contractId}.md`),
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
      stagePlan,
      stageRuntime,
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, primaryFileName), "# primary output\n", "utf8");
    await writeFile(join(outboxDir, secondaryFileName), JSON.stringify({ ok: true }, null, 2), "utf8");
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "最小 runtime_result 只声明完成状态",
      completion: {
        status: "completed",
      },
    }, null, 2), "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["runtime_result.json", primaryFileName, secondaryFileName],
      logger,
    });

    primaryArtifactPath = result.primaryOutputPath;
    collectedArtifactPaths = Array.isArray(result.artifactPaths) ? result.artifactPaths : [];

    assert.equal(result.collected, true);
    assert.equal(result.stageRunResult?.status, "completed");
    assert.equal(result.stageCompletion?.status, "completed");
    assert.deepEqual(
      collectedArtifactPaths.map((filePath) => filePath.split("/").pop()).sort(),
      [primaryFileName, secondaryFileName].sort(),
      "all non-control outbox files should be collected without manifest parsing",
    );
    assert.equal(
      primaryArtifactPath?.split("/").pop(),
      primaryFileName,
      "primary output should default to the contract output-compatible markdown artifact",
    );
  } finally {
    for (const artifactPath of collectedArtifactPaths) {
      await rm(artifactPath, { force: true }).catch(() => {});
    }
    await cleanupWorkspace(agentId, primaryArtifactPath);
  }
});

test("collectWorkerOutbox rejects legacy outbox manifest residue", async () => {
  const agentId = `worker-stage-manifest-residue-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-WORKER-STAGE-MANIFEST-${Date.now()}`;

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "legacy manifest should not be accepted",
      assignee: agentId,
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify({ artifacts: [] }, null, 2), "utf8");
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "legacy manifest residue",
    }, null, 2), "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["runtime_result.json", "_manifest.json"],
      logger,
    });

    assert.equal(result.collected, false);
    assert.match(result.error || "", /legacy outbox manifest/i);
  } finally {
    await cleanupWorkspace(agentId);
  }
});

test("collectWorkerOutbox carries reviewer semantic stage id through runtime_result truth", async () => {
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
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "实现符合预期",
      reviewVerdict: {
        verdict: "approve",
        feedback: "实现符合预期",
      },
      completion: { status: "completed" },
    }, null, 2), "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["runtime_result.json"],
      logger,
    });
    artifactPath = result.primaryOutputPath;

    assert.equal(result.collected, true);
    assert.equal(result.stageRunResult?.semanticStageId, stageRuntime.currentStageId);
    assert.equal(result.reviewVerdict?.verdict, "approve");
    assert.equal(result.reviewerResult?.verdict, "pass");
    assert.equal("semanticStageAction" in (result.stageRunResult || {}), false);
    assert.equal(result.stageCompletion?.status, "completed");
  } finally {
    await cleanupWorkspace(agentId, artifactPath);
  }
});
