import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTrackingState } from "../lib/session-bootstrap.js";
import { materializeTaskStagePlan } from "../lib/task-stage-plan.js";
import { agentWorkspace, taskHistory } from "../lib/state.js";
import { syncTrackingRuntimeStageProgress } from "../lib/runtime-stage-progress.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

function createPlannedTrackingState(contractId) {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-stage-progress:${contractId}`,
    agentId: "worker-stage-progress",
    parentSession: null,
  });
  trackingState.contract = {
    id: contractId,
    task: "runtime stage progress should follow real execution evidence",
    assignee: "worker-stage-progress",
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stagePlan: materializeTaskStagePlan({
      contractId,
      phases: ["阶段一", "阶段二", "阶段三", "阶段四"],
    }),
    stageRuntime: {
      version: 1,
      currentStageId: "stage-1",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    phases: ["阶段一", "阶段二", "阶段三", "阶段四"],
    total: 4,
    output: join(agentWorkspace("controller"), "output", `${contractId}.md`),
  };
  return trackingState;
}

test.afterEach(async () => {
  taskHistory.length = 0;
  await rm(join(agentWorkspace("controller"), "output"), { recursive: true, force: true }).catch(() => {});
});

test("syncTrackingRuntimeStageProgress keeps the first stage active with no prior execution evidence", async () => {
  const contractId = `TC-STAGE-PROGRESS-BASE-${Date.now()}`;
  const trackingState = createPlannedTrackingState(contractId);

  const result = await syncTrackingRuntimeStageProgress(trackingState, {
    history: [],
  });

  assert.equal(result.stageRuntime?.currentStageId, "stage-1");
  assert.deepEqual(result.stageRuntime?.completedStageIds, []);
  assert.equal(result.runtimeObservation?.progressEvidence?.completedSessionCount, 0);
});

test("syncTrackingRuntimeStageProgress advances to the next stage after a completed session boundary", async () => {
  const contractId = `TC-STAGE-PROGRESS-BOUNDARY-${Date.now()}`;
  const trackingState = createPlannedTrackingState(contractId);

  const history = [{
    contractId,
    sessionKey: "agent:planner:contract-boundary",
    status: CONTRACT_STATUS.RUNNING,
    endMs: Date.now(),
  }];

  const result = await syncTrackingRuntimeStageProgress(trackingState, {
    history,
  });

  assert.equal(result.stageRuntime?.currentStageId, "stage-2");
  assert.deepEqual(result.stageRuntime?.completedStageIds, ["stage-1"]);
  assert.equal(result.runtimeObservation?.progressEvidence?.completedSessionCount, 1);
});

test("syncTrackingRuntimeStageProgress counts the current terminalized session as a new stage boundary", async () => {
  const contractId = `TC-STAGE-PROGRESS-CURRENT-BOUNDARY-${Date.now()}`;
  const trackingState = createPlannedTrackingState(contractId);

  const result = await syncTrackingRuntimeStageProgress(trackingState, {
    history: [],
    currentSessionBoundary: true,
  });

  assert.equal(result.stageRuntime?.currentStageId, "stage-2");
  assert.deepEqual(result.stageRuntime?.completedStageIds, ["stage-1"]);
  assert.equal(result.runtimeObservation?.progressEvidence?.currentSessionBoundary, true);
});

test("syncTrackingRuntimeStageProgress promotes later stages when the live output artifact has materially grown", async () => {
  const contractId = `TC-STAGE-PROGRESS-OUTPUT-${Date.now()}`;
  const trackingState = createPlannedTrackingState(contractId);
  const outputDir = join(agentWorkspace("controller"), "output");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    trackingState.contract.output,
    [
      "# 第一部分",
      "",
      "这里是较长的阶段化执行输出，用于模拟系统真实观察到的产物增长。",
      "",
      "## 第二部分",
      "",
      "继续补充内容，确保系统可以把当前运行阶段推进到更靠后的阶段。",
      "",
      "## 第三部分",
      "",
      "再补充一段内容，让输出体积跨过最小阈值。",
    ].join("\n").repeat(30),
    "utf8",
  );

  const history = [
    {
      contractId,
      sessionKey: "agent:planner:contract-output-progress",
      status: CONTRACT_STATUS.RUNNING,
      endMs: Date.now() - 1000,
    },
    {
      contractId,
      sessionKey: "agent:worker:contract-output-progress",
      status: CONTRACT_STATUS.RUNNING,
      endMs: Date.now() - 500,
    },
  ];

  const result = await syncTrackingRuntimeStageProgress(trackingState, {
    history,
  });

  assert.equal(result.stageRuntime?.currentStageId, "stage-4");
  assert.deepEqual(result.stageRuntime?.completedStageIds, ["stage-1", "stage-2", "stage-3"]);
  assert.ok((result.runtimeObservation?.outputArtifact?.size || 0) > 0);
  assert.ok((result.runtimeObservation?.progressEvidence?.outputBoost || 0) >= 1);
});

test("syncTrackingRuntimeStageProgress does not treat planner stage scaffold output as real execution progress", async () => {
  const contractId = `TC-STAGE-PROGRESS-SCAFFOLD-${Date.now()}`;
  const trackingState = createPlannedTrackingState(contractId);
  const outputDir = join(agentWorkspace("controller"), "output");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    trackingState.contract.output,
    [
      "[STAGE] 阶段一",
      "- 目标：先定义研究目标",
      "- 交付：阶段计划条目",
      "- 完成标准：目标清晰",
      "",
      "[STAGE] 阶段二",
      "- 目标：列出比较维度",
      "- 交付：维度清单",
      "- 完成标准：覆盖核心维度",
      "",
      "[STAGE] 阶段三",
      "- 目标：准备后续执行",
      "- 交付：执行提纲",
      "- 完成标准：提纲完整",
    ].join("\n"),
    "utf8",
  );

  const history = [{
    contractId,
    sessionKey: "agent:planner:contract-stage-scaffold",
    status: CONTRACT_STATUS.RUNNING,
    endMs: Date.now(),
  }];

  const result = await syncTrackingRuntimeStageProgress(trackingState, {
    history,
  });

  assert.equal(result.stageRuntime?.currentStageId, "stage-2");
  assert.deepEqual(result.stageRuntime?.completedStageIds, ["stage-1"]);
  assert.equal(result.runtimeObservation?.progressEvidence?.outputBoost, 0);
  assert.equal(result.runtimeObservation?.outputArtifact?.isScaffoldOnly, true);
});
