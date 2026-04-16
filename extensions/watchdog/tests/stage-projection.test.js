import test from "node:test";
import assert from "node:assert/strict";

import { applyTrackingStageProjection } from "../lib/stage-projection.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { materializeTaskStagePlan } from "../lib/task-stage-plan.js";

test("applyTrackingStageProjection renders planner-extracted stagePlan as real stage projection", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:worker:projection",
    agentId: "worker",
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-STAGE-PROJECTION",
    task: "planner stage projection",
    status: CONTRACT_STATUS.RUNNING,
    phases: ["收集证据", "交叉比较", "形成结论"],
    stagePlan: materializeTaskStagePlan({
      contractId: "TC-STAGE-PROJECTION",
      phases: ["收集证据", "交叉比较", "形成结论"],
    }),
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "task_stage_truth");
  assert.equal(projection.confidence, "planner");
  assert.deepEqual(projection.stagePlan, ["收集证据", "交叉比较", "形成结论"]);
  assert.equal(projection.currentStageLabel, "收集证据");
  assert.equal(projection.cursor, "0/3");
  assert.equal(projection.pct, 0);
  assert.equal(projection.total, 3);
  assert.equal(trackingState.estimatedPhase, "收集证据");
});

test("applyTrackingStageProjection derives progress from stageRuntime", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:worker:projection-runtime",
    agentId: "worker",
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-STAGE-PROJECTION-RUNTIME",
    task: "planner stage runtime projection",
    status: CONTRACT_STATUS.RUNNING,
    stagePlan: materializeTaskStagePlan({
      contractId: "TC-STAGE-PROJECTION-RUNTIME",
      phases: ["收集证据", "交叉比较", "形成结论"],
    }),
    stageRuntime: {
      version: 1,
      currentStageId: "stage-2",
      completedStageIds: ["stage-1"],
      revisionCount: 0,
      lastRevisionReason: null,
    },
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "task_stage_truth");
  assert.deepEqual(projection.completedStages, ["收集证据"]);
  assert.equal(projection.currentStage, "stage-2");
  assert.equal(projection.currentStageLabel, "交叉比较");
  assert.equal(projection.cursor, "1/3");
  assert.equal(projection.pct, 33);
  assert.equal(trackingState.estimatedPhase, "交叉比较");
});

test("applyTrackingStageProjection derives canonical stage projection from compatibility phases when stagePlan is absent", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:worker:activity-only",
    agentId: "worker",
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-STAGE-ACTIVITY",
    task: "activity fallback",
    status: CONTRACT_STATUS.RUNNING,
    phases: ["分析", "写报告"],
    // no stagePlan — only phases array
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "task_stage_truth");
  assert.equal(projection.confidence, "planner");
  assert.deepEqual(projection.stagePlan, ["分析", "写报告"]);
  assert.equal(projection.currentStage, "stage-1");
  assert.equal(projection.currentStageLabel, "分析");
  assert.equal(projection.cursor, "0/2");
  assert.equal(projection.pct, 0);
  assert.equal(trackingState.estimatedPhase, "分析");
});

test("applyTrackingStageProjection marks completed terminal state as full progress", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:worker:completed",
    agentId: "worker",
    parentSession: null,
  });
  trackingState.status = CONTRACT_STATUS.COMPLETED;
  trackingState.contract = {
    id: "TC-STAGE-COMPLETED",
    task: "completed projection",
    status: CONTRACT_STATUS.COMPLETED,
    phases: ["分析", "写报告"],
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "ui_terminal_placeholder");
  assert.equal(projection.cursor, "2/2");
  assert.equal(projection.pct, 100);
  assert.equal(trackingState.estimatedPhase, "已完成");
});

test("applyTrackingStageProjection prefers terminal completed truth over stale stageRuntime", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:worker:completed-stale-runtime",
    agentId: "worker",
    parentSession: null,
  });
  trackingState.status = CONTRACT_STATUS.COMPLETED;
  trackingState.contract = {
    id: "TC-STAGE-COMPLETED-STALE",
    task: "completed projection with stale runtime",
    status: CONTRACT_STATUS.COMPLETED,
    stagePlan: materializeTaskStagePlan({
      contractId: "TC-STAGE-COMPLETED-STALE",
      phases: ["框架调研与资料收集", "多维度对比分析", "报告整合与输出"],
    }),
    stageRuntime: {
      version: 1,
      currentStageId: "stage-1",
      completedStageIds: [],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    terminalOutcome: {
      status: CONTRACT_STATUS.COMPLETED,
      reason: "artifacts verified",
      source: "completion_criteria",
    },
    executionObservation: {
      collected: true,
      contractId: "TC-STAGE-COMPLETED-STALE",
      stageCompletion: {
        status: "completed",
      },
    },
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection.source, "task_stage_truth");
  assert.deepEqual(
    projection.completedStages,
    ["框架调研与资料收集", "多维度对比分析", "报告整合与输出"],
  );
  assert.equal(projection.currentStage, "已完成");
  assert.equal(projection.currentStageLabel, "已完成");
  assert.equal(projection.cursor, "3/3");
  assert.equal(projection.pct, 100);
  assert.equal(trackingState.estimatedPhase, "已完成");
});
