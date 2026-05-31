/**
 * W3 收口锁定测试：runtime-stage-progress 不得写回 trackingState.contract.stageRuntime
 *
 * 背景（备忘录100）：stage 真值三路并立 — 只有 Path A（contract 磁盘 stageRuntime）
 * 才是 canonical 真值 owner。Path C（runtime-stage-progress 启发式推算）只能更新
 * runtimeObservation，不能把结果写回 trackingState.contract，否则违反指标#1"真值唯一"。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createTrackingState } from "../lib/session-bootstrap.js";
import { materializeTaskStagePlan } from "../lib/task-stage-plan.js";
import { syncTrackingRuntimeStageProgress } from "../lib/runtime-stage-progress.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

function buildTrackingStateWithStages(contractId, phases) {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-projection-test:${contractId}`,
    agentId: "worker-projection-test",
    parentSession: null,
  });
  const originalRuntime = {
    version: 1,
    currentStageId: "stage-1",
    completedStageIds: [],
    revisionCount: 0,
    lastRevisionReason: null,
  };
  trackingState.contract = {
    id: contractId,
    task: "projection only — must not mutate contract stageRuntime",
    assignee: "worker-projection-test",
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stagePlan: materializeTaskStagePlan({
      contractId,
      phases,
    }),
    stageRuntime: originalRuntime,
    phases,
    total: phases.length,
  };
  return { trackingState, originalRuntime };
}

test("syncTrackingRuntimeStageProgress does not mutate trackingState.contract.stageRuntime (Path C must not own canonical truth)", async () => {
  const contractId = `TC-PROJECTION-ONLY-${Date.now()}`;
  const { trackingState, originalRuntime } = buildTrackingStateWithStages(
    contractId,
    ["阶段一", "阶段二", "阶段三"],
  );

  // Provide evidence that would cause heuristic advance (1 completed session)
  const history = [{
    contractId,
    sessionKey: "agent:planner:session-boundary",
    status: CONTRACT_STATUS.RUNNING,
    endMs: Date.now() - 1000,
  }];

  const contractBefore = trackingState.contract;
  const runtimeBefore = trackingState.contract.stageRuntime;

  const result = await syncTrackingRuntimeStageProgress(trackingState, { history });

  // Return value must carry the advanced stage (heuristic result for callers)
  assert.equal(result.stageRuntime?.currentStageId, "stage-2");
  assert.deepEqual(result.stageRuntime?.completedStageIds, ["stage-1"]);

  // Contract object must NOT have been replaced
  assert.strictEqual(trackingState.contract, contractBefore,
    "trackingState.contract object identity must not change");

  // stageRuntime on the contract must NOT have been mutated
  assert.strictEqual(trackingState.contract.stageRuntime, runtimeBefore,
    "trackingState.contract.stageRuntime must be the same object reference");

  assert.equal(trackingState.contract.stageRuntime.currentStageId, "stage-1",
    "canonical contract stageRuntime must remain at stage-1 (not advanced by heuristic)");

  // runtimeObservation IS permitted to be updated (observation layer only)
  assert.ok(trackingState.runtimeObservation?.progressEvidence,
    "runtimeObservation.progressEvidence must be populated");
  assert.equal(trackingState.runtimeObservation.progressEvidence.completedSessionCount, 1);
});

test("syncTrackingRuntimeStageProgress keeps runtimeObservation as observation-only — progressEvidence source is runtime_stage_progress", async () => {
  const contractId = `TC-PROJECTION-SOURCE-${Date.now()}`;
  const { trackingState } = buildTrackingStateWithStages(
    contractId,
    ["阶段一", "阶段二"],
  );

  const result = await syncTrackingRuntimeStageProgress(trackingState, {
    history: [],
    currentSessionBoundary: true,
  });

  assert.equal(trackingState.runtimeObservation?.progressEvidence?.source, "runtime_stage_progress");
  assert.equal(result.runtimeObservation?.progressEvidence?.source, "runtime_stage_progress");
});
