// lib/stage/stage-projection.js — Contract stage projection
//
// Builds a stage projection from contract.stagePlan (planner-extracted).
// No external runtime dependency — projection is driven entirely by
// the contract's own stagePlan + stageRunResult.

import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { materializeTaskStageTruth } from "./task-stage-truth.js";

function hasObservedContractStageTruth(contract) {
  return Boolean(
    contract?.stagePlan
    || contract?.stageRuntime
    || contract?.executionObservation
    || contract?.terminalOutcome
    || contract?.runtimeDiagnostics
    || contract?.systemActionDelivery
  );
}

// ── Projection builder ──────────────────────────────────────────────────────

function buildStagePlanProjection(trackingState, contract) {
  const truth = materializeTaskStageTruth({
    contractId: contract?.stagePlan?.contractId || contract?.id || null,
    stagePlan: contract?.stagePlan ?? null,
    stageRuntime: contract?.stageRuntime ?? null,
    // 自报推进的输入:阶段完成声明随合约快照走(witness 引擎删除后这是唯一推进源)。
    stageRunResult: contract?.stageRunResult ?? null,
    executionObservation: contract?.executionObservation ?? null,
    terminalOutcome: contract?.terminalOutcome ?? null,
    runtimeDiagnostics: contract?.runtimeDiagnostics ?? null,
    systemActionDelivery: contract?.systemActionDelivery ?? null,
    phases: contract?.phases ?? null,
  });
  const canonicalPlan = truth.stagePlan;
  const stageRuntime = truth.stageRuntime;
  if (!canonicalPlan || !Array.isArray(canonicalPlan.stages) || canonicalPlan.stages.length === 0) {
    return null;
  }
  if (!stageRuntime || !Array.isArray(canonicalPlan.stages) || canonicalPlan.stages.length === 0) {
    return null;
  }

  const stagePlan = canonicalPlan.stages.map((entry) => entry.label);
  const total = stagePlan.length;
  const completedSet = new Set(stageRuntime.completedStageIds || []);
  const completedStages = canonicalPlan.stages
    .filter((entry) => completedSet.has(entry.id))
    .map((entry) => entry.label);
  const done = completedStages.length;
  const currentStageId = stageRuntime.currentStageId || null;
  const currentStageEntry = currentStageId
    ? canonicalPlan.stages.find((entry) => entry.id === currentStageId) || null
    : null;

  return {
    source: "task_stage_truth",
    confidence: "planner",
    stagePlan,
    completedStages,
    currentStage: (done >= total) ? "已完成" : (currentStageId || null),
    currentStageLabel: (done >= total) ? "已完成" : (currentStageEntry?.label || null),
    cursor: `${done}/${total}`,
    pct: total > 0 ? Math.round((done / total) * 100) : null,
    done,
    total,
    runtimeStatus: trackingState?.status || contract?.status || null,
  };
}

function buildTerminalProjection(trackingState, contract) {
  const phases = Array.isArray(contract?.phases) ? contract.phases.filter(Boolean) : [];
  const total = phases.length || 1;
  return {
    source: "ui_terminal_placeholder",
    confidence: phases.length > 0 ? "planner" : "none",
    stagePlan: phases,
    completedStages: phases,
    currentStage: "已完成",
    currentStageLabel: "已完成",
    cursor: `${total}/${total}`,
    pct: 100,
    done: total,
    total,
    runtimeStatus: trackingState?.status || contract?.status || null,
  };
}

function buildFallbackProjection(trackingState) {
  return {
    source: "ui_activity_placeholder",
    confidence: "none",
    stagePlan: [],
    completedStages: [],
    currentStage: null,
    currentStageLabel: null,
    cursor: null,
    pct: null,
    done: null,
    total: null,
    runtimeStatus: trackingState?.status || trackingState?.contract?.status || null,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export function applyTrackingStageProjection(trackingState) {
  if (!trackingState || typeof trackingState !== "object") return null;

  const contract = trackingState.contract || null;

  // 1. Contract can materialize canonical stage truth → real stage projection
  if (contract) {
    const projection = buildStagePlanProjection(trackingState, contract);
    if (
      projection
      && (
        trackingState.status !== CONTRACT_STATUS.COMPLETED
        || hasObservedContractStageTruth(contract)
        || projection.pct === 100
      )
    ) {
      trackingState.stageProjection = projection;
      trackingState.cursor = projection.cursor;
      trackingState.pct = projection.pct;
      trackingState.estimatedPhase = projection.currentStageLabel || "";
      return projection;
    }
  }

  // 2. Terminal status → fully completed projection
  if (trackingState.status === CONTRACT_STATUS.COMPLETED) {
    const projection = buildTerminalProjection(trackingState, contract);
    trackingState.stageProjection = projection;
    trackingState.cursor = projection.cursor;
    trackingState.pct = projection.pct;
    trackingState.estimatedPhase = projection.currentStageLabel;
    return projection;
  }

  // 3. No stage info → fallback
  const projection = buildFallbackProjection(trackingState);
  trackingState.stageProjection = projection;
  trackingState.cursor = null;
  trackingState.pct = null;
  trackingState.estimatedPhase = "";
  return projection;
}

export async function refreshTrackingProjection(trackingState) {
  if (!trackingState || typeof trackingState !== "object") return null;
  return applyTrackingStageProjection(trackingState);
}
