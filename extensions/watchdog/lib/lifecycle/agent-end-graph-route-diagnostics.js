import { getContractPath, mutateContractSnapshot } from "../contracts.js";
import { mergeRuntimeDiagnostics } from "./agent-end-contract-refresh.js";

export function buildGraphRouteProgressionDiagnostic({
  contractStage,
  nextStage,
  nextRound,
  reason,
}) {
  return {
    attempted: true,
    action: "advanced",
    reason: reason || "stage_advanced",
    from: contractStage.stage,
    to: nextStage,
    targetAgent: nextStage,
    pipelineId: contractStage.pipelineId || null,
    loopId: contractStage.loopId || null,
    loopSessionId: contractStage.loopSessionId || null,
    round: nextRound,
    ts: Date.now(),
  };
}

export function buildSkippedGraphRouteProgressionDiagnostic({
  contractStage,
  reason,
  action = null,
  error = null,
}) {
  return {
    attempted: false,
    skipped: true,
    action,
    reason: reason || "graph_hold",
    error,
    from: contractStage.stage,
    pipelineId: contractStage.pipelineId || null,
    loopId: contractStage.loopId || null,
    loopSessionId: contractStage.loopSessionId || null,
    round: contractStage.round || 1,
    ts: Date.now(),
  };
}

export function buildLateCompletionDiagnostic(lateCompletionLease) {
  if (!lateCompletionLease) {
    return null;
  }
  return {
    recovered: true,
    reason: lateCompletionLease.reason || "tracker_timeout",
    stage: lateCompletionLease.stage || null,
    pipelineId: lateCompletionLease.pipelineId || null,
    loopId: lateCompletionLease.loopId || null,
    loopSessionId: lateCompletionLease.loopSessionId || null,
    contractId: lateCompletionLease.contractId || null,
    armedAt: lateCompletionLease.armedAt || null,
    resumedAt: lateCompletionLease.resumedAt || Date.now(),
    diagnostic: lateCompletionLease.diagnostic || null,
  };
}

export function mergeGraphRouteProgressionDiagnostics(contract, progressionDiagnostic, lateCompletionDiagnostic = null) {
  if (!contract || typeof contract !== "object") {
    return;
  }
  contract.runtimeDiagnostics = mergeRuntimeDiagnostics(
    contract.runtimeDiagnostics,
    {
      graphRouteProgression: progressionDiagnostic,
      ...(lateCompletionDiagnostic ? { lateCompletion: lateCompletionDiagnostic } : {}),
    },
  );
}

export async function persistGraphRouteProgressionDiagnostics(context, progressionDiagnostic, {
  lateCompletionDiagnostic = null,
} = {}) {
  const contractPath = context?.trackingState?.contract?.path
    || (context?.effectiveContractData?.id ? getContractPath(context.effectiveContractData.id) : null);
  mergeGraphRouteProgressionDiagnostics(
    context?.effectiveContractData,
    progressionDiagnostic,
    lateCompletionDiagnostic,
  );
  if (context?.trackingState?.contract && context.trackingState.contract !== context.effectiveContractData) {
    mergeGraphRouteProgressionDiagnostics(
      context.trackingState.contract,
      progressionDiagnostic,
      lateCompletionDiagnostic,
    );
  }
  if (!contractPath) {
    return;
  }
  await mutateContractSnapshot(contractPath, context?.logger, (contract) => {
    mergeGraphRouteProgressionDiagnostics(contract, progressionDiagnostic, lateCompletionDiagnostic);
  });
}
