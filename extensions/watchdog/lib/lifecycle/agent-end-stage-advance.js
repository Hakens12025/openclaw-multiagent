import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { concludeLoopSession } from "../loop/loop-session-store.js";
import {
  normalizeStageCompletion,
  normalizeStageRunResult,
  listStageArtifactPaths,
} from "../stage-results.js";

function normalizeStageIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizePipelineStageDescriptor(stage) {
  if (!stage || typeof stage !== "object") return null;
  const normalizedStage = normalizeStageIdentifier(stage.stage);
  if (!normalizedStage) return null;
  return {
    pipelineId: normalizeStageIdentifier(stage.pipelineId),
    loopId: normalizeStageIdentifier(stage.loopId),
    loopSessionId: normalizeStageIdentifier(stage.loopSessionId),
    stage: normalizedStage,
    round: Number.isFinite(stage.round) && stage.round > 0 ? stage.round : null,
  };
}

function summarizeStageRunResult(stageRunResult, stageCompletion) {
  return [
    stageRunResult?.summary,
    stageCompletion?.feedback,
    stageRunResult?.feedback,
  ].find((entry) => typeof entry === "string" && entry.trim()) || null;
}

export function resolveStageAdvanceSignal(executionObservation) {
  const stageRunResult = normalizeStageRunResult(executionObservation?.stageRunResult);
  if (!stageRunResult) {
    return {
      ok: false,
      reason: "missing_stage_run_result",
      stageRunResult: null,
      stageCompletion: null,
    };
  }

  const stageCompletion = normalizeStageCompletion(
    executionObservation?.stageCompletion,
    stageRunResult.completion || {},
  );
  if (!stageCompletion) {
    return {
      ok: false,
      reason: "missing_stage_completion",
      stageRunResult,
      stageCompletion: null,
    };
  }

  const feedback = stageCompletion.feedback || stageRunResult.feedback || stageRunResult.summary || null;
  const result = summarizeStageRunResult(stageRunResult, stageCompletion);
  const transition = stageCompletion.transition || null;
  const signal = {
    ok: false,
    reason: null,
    stageRunResult,
    stageCompletion,
    feedback,
    result,
    deadEnds: Array.isArray(stageCompletion.deadEnds) ? stageCompletion.deadEnds : [],
    artifactPaths: listStageArtifactPaths(stageRunResult),
    primaryArtifactPath: stageRunResult.primaryArtifactPath || null,
    transitionKind: transition?.kind || null,
    suggestedNext: null,
  };

  if (stageRunResult.status !== "completed" || stageCompletion.status !== "completed") {
    return {
      ...signal,
      reason: `non_completed_stage:${stageRunResult.status}:${stageCompletion.status}`,
    };
  }

  if (!transition) {
    return {
      ...signal,
      reason: "missing_stage_transition",
    };
  }

  if (transition.kind === "hold") {
    return {
      ...signal,
      reason: "explicit_stage_hold",
    };
  }

  if (transition.kind === "conclude") {
    return {
      ...signal,
      ok: true,
      suggestedNext: "concluded",
    };
  }

  if (transition.kind === "advance") {
    const targetStage = normalizeStageIdentifier(transition.targetStage);
    return targetStage
      ? {
          ...signal,
          ok: true,
          suggestedNext: targetStage,
        }
      : {
          ...signal,
          reason: "missing_transition_target",
        };
  }

  if (transition.kind === "follow_graph") {
    return {
      ...signal,
      ok: true,
      suggestedNext: null,
    };
  }

  return {
    ...signal,
    reason: `unsupported_transition:${transition.kind || "unknown"}`,
  };
}

function resolveLoopTerminalStatus(terminalStatus) {
  if (terminalStatus === CONTRACT_STATUS.COMPLETED) {
    return "concluded";
  }
  if (terminalStatus === CONTRACT_STATUS.FAILED) {
    return "failed";
  }
  return "abandoned";
}

export async function maybeFinalizeLoopSession(context, terminalStatus, outcome) {
  const pipelineStage = normalizePipelineStageDescriptor(
    context.effectiveContractData?.pipelineStage || context.trackingState?.contract?.pipelineStage,
  );
  if (!pipelineStage?.loopSessionId) {
    return null;
  }

  const advanceSignal = resolveStageAdvanceSignal(context.executionObservation);
  const concludeReason = terminalStatus === CONTRACT_STATUS.COMPLETED
    ? (
        advanceSignal.transitionKind === "conclude"
          ? "explicit_conclude"
          : (outcome?.reason || "loop_terminal_completed")
      )
    : [
        "loop_terminal",
        terminalStatus,
        pipelineStage.stage,
        outcome?.reason || "unknown",
      ].filter(Boolean).join(": ");

  const concluded = await concludeLoopSession({
    sessionId: pipelineStage.loopSessionId,
    reason: concludeReason,
    currentStage: pipelineStage.stage,
    round: pipelineStage.round || 1,
    status: resolveLoopTerminalStatus(terminalStatus),
    taskStagePlan: context.trackingState?.contract?.stagePlan
      || context.effectiveContractData?.stagePlan
      || null,
    taskStageRuntime: context.trackingState?.contract?.stageRuntime
      || context.effectiveContractData?.stageRuntime
      || null,
  });

  return {
    attempted: true,
    action: concluded ? "concluded" : "missing_loop_session",
    terminalStatus,
    reason: concludeReason,
    stage: pipelineStage.stage,
    pipelineId: pipelineStage.pipelineId || null,
    loopId: pipelineStage.loopId || null,
    loopSessionId: pipelineStage.loopSessionId || null,
    ts: Date.now(),
  };
}
