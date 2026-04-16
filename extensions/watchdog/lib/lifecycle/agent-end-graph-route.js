import {
  materializeTaskStageTruth,
  deriveCompatibilityPhases,
  deriveCompatibilityTotal,
} from "../task-stage-plan.js";
import { getContractPath, mutateContractSnapshot } from "../contracts.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { hasDirectedEdge, loadGraph } from "../agent/agent-graph.js";
import {
  routeAfterAgentEnd,
  resolveRouteAfterAgentEndTarget,
} from "../routing/dispatch-graph-policy.js";
import { listResolvedGraphLoops } from "../loop/graph-loop-registry.js";
import {
  advanceLoopSession,
  loadLoopSessionState,
} from "../loop/loop-session-store.js";
import {
  normalizePipelineStageDescriptor,
  resolveStageAdvanceSignal,
} from "./agent-end-stage-advance.js";
import { mergeRuntimeDiagnostics } from "./agent-end-contract-refresh.js";

function normalizePositiveInteger(value, fallback = null) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(numeric);
  }
  return fallback;
}

function contractRouteStage(contract) {
  return normalizePipelineStageDescriptor(contract?.pipelineStage);
}

function buildLoopFeedbackOutput(pipelineStage, stageAdvanceSignal, executionObservation, agentId) {
  return {
    result: stageAdvanceSignal.result || null,
    feedback: stageAdvanceSignal.feedback || null,
    artifactPaths: Array.isArray(stageAdvanceSignal.artifactPaths) ? stageAdvanceSignal.artifactPaths : [],
    primaryArtifactPath: stageAdvanceSignal.primaryArtifactPath || null,
    executionObservation: executionObservation || null,
    fromStage: pipelineStage.stage,
    fromAgent: agentId,
    ts: Date.now(),
  };
}

function buildLoopStageTask({
  baseTask,
  previousStage,
  previousFeedback,
  previousArtifactPath,
}) {
  const normalizedBaseTask = typeof baseTask === "string" ? baseTask.trim() : "";
  const handoffLines = [
    previousStage ? `上阶段: ${previousStage}` : null,
    previousFeedback ? `上阶段结论: ${previousFeedback}` : null,
    previousArtifactPath ? `上阶段主产物: ${previousArtifactPath}` : null,
  ].filter(Boolean);

  if (handoffLines.length === 0) {
    return normalizedBaseTask;
  }

  return [
    normalizedBaseTask,
    "阶段交接:",
    ...handoffLines.map((line) => `- ${line}`),
  ].filter(Boolean).join("\n");
}

function buildPipelineProgressionDiagnostic({
  pipelineStage,
  nextStage,
  nextRound,
  reason,
}) {
  return {
    attempted: true,
    action: "advanced",
    reason: reason || "stage_advanced",
    from: pipelineStage.stage,
    to: nextStage,
    targetAgent: nextStage,
    pipelineId: pipelineStage.pipelineId || null,
    loopId: pipelineStage.loopId || null,
    loopSessionId: pipelineStage.loopSessionId || null,
    round: nextRound,
    ts: Date.now(),
  };
}

function buildSkippedPipelineProgressionDiagnostic({
  pipelineStage,
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
    from: pipelineStage.stage,
    pipelineId: pipelineStage.pipelineId || null,
    loopId: pipelineStage.loopId || null,
    loopSessionId: pipelineStage.loopSessionId || null,
    round: pipelineStage.round || 1,
    ts: Date.now(),
  };
}

function normalizeLoopBudgetState(activeLoopSession, pipelineStage) {
  const source = activeLoopSession?.budget;
  if (!source || typeof source !== "object") {
    return null;
  }

  const currentRound = normalizePositiveInteger(
    pipelineStage?.round ?? activeLoopSession?.round,
    1,
  ) || 1;
  return {
    maxRounds: normalizePositiveInteger(source.maxRounds, null),
    maxExperiments: normalizePositiveInteger(source.maxExperiments, null),
    usedRounds: normalizePositiveInteger(source.usedRounds, currentRound) || currentRound,
    usedExperiments: normalizePositiveInteger(source.usedExperiments, 0) || 0,
  };
}

function evaluateLoopBudgetGovernance({
  activeLoopSession,
  pipelineStage,
  nextStage,
  nextRound,
}) {
  const budget = normalizeLoopBudgetState(activeLoopSession, pipelineStage);
  if (!budget) {
    return {
      exhausted: false,
      updatedBudget: null,
    };
  }

  const normalizedNextRound = normalizePositiveInteger(nextRound, pipelineStage?.round || 1)
    || pipelineStage?.round
    || 1;
  if (budget.maxRounds && normalizedNextRound > budget.maxRounds) {
    return {
      exhausted: true,
      reason: "loop_budget_exhausted:max_rounds",
      updatedBudget: {
        ...budget,
        usedRounds: budget.maxRounds,
      },
      terminalOutcome: {
        status: CONTRACT_STATUS.COMPLETED,
        source: "loop_runtime_governance",
        reason: "loop_budget_exhausted:max_rounds",
        summary: `Loop reached maxRounds=${budget.maxRounds} before routing to ${nextStage}`,
        artifact: {
          loopId: pipelineStage?.loopId || pipelineStage?.pipelineId || null,
          loopSessionId: pipelineStage?.loopSessionId || null,
          exhaustedBy: "maxRounds",
          maxRounds: budget.maxRounds,
          usedRounds: budget.maxRounds,
          blockedNextStage: nextStage || null,
        },
      },
    };
  }

  return {
    exhausted: false,
    updatedBudget: {
      ...budget,
      usedRounds: Math.max(budget.usedRounds, normalizedNextRound),
    },
  };
}

function buildLateCompletionDiagnostic(lateCompletionLease) {
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

function mergeLoopProgressionDiagnostics(contract, progressionDiagnostic, lateCompletionDiagnostic = null) {
  if (!contract || typeof contract !== "object") {
    return;
  }
  contract.runtimeDiagnostics = mergeRuntimeDiagnostics(
    contract.runtimeDiagnostics,
    {
      pipelineProgression: progressionDiagnostic,
      ...(lateCompletionDiagnostic ? { lateCompletion: lateCompletionDiagnostic } : {}),
    },
  );
}

async function persistLoopProgressionDiagnostics(context, progressionDiagnostic, {
  lateCompletionDiagnostic = null,
} = {}) {
  const contractPath = context?.trackingState?.contract?.path
    || (context?.effectiveContractData?.id ? getContractPath(context.effectiveContractData.id) : null);
  mergeLoopProgressionDiagnostics(
    context?.effectiveContractData,
    progressionDiagnostic,
    lateCompletionDiagnostic,
  );
  if (context?.trackingState?.contract && context.trackingState.contract !== context.effectiveContractData) {
    mergeLoopProgressionDiagnostics(
      context.trackingState.contract,
      progressionDiagnostic,
      lateCompletionDiagnostic,
    );
  }
  if (!contractPath) {
    return;
  }
  await mutateContractSnapshot(contractPath, context?.logger, (contract) => {
    mergeLoopProgressionDiagnostics(contract, progressionDiagnostic, lateCompletionDiagnostic);
  });
}

function computeLoopNextRound(loop, fromStage, toStage, currentRound) {
  const normalizedRound = Number.isFinite(currentRound) && currentRound > 0 ? currentRound : 1;
  if (!loop || !Array.isArray(loop.nodes) || loop.nodes.length < 2) {
    return normalizedRound;
  }

  const lastStage = loop.nodes[loop.nodes.length - 1];
  const entryStage = loop.entryAgentId || loop.nodes[0] || null;
  if (fromStage === lastStage && toStage === entryStage) {
    return normalizedRound + 1;
  }
  return normalizedRound;
}

function buildLoopContractRouteMutation({
  contractData,
  pipelineStage,
  stageAdvanceSignal,
  executionObservation,
  nextStage,
  nextRound,
  lateCompletionLease = null,
}) {
  const truth = materializeTaskStageTruth({
    contractId: contractData?.id || null,
    stagePlan: contractData?.stagePlan || null,
    stageRuntime: contractData?.stageRuntime || null,
    executionObservation,
  });
  const progressionDiagnostic = buildPipelineProgressionDiagnostic({
    pipelineStage,
    nextStage,
    nextRound,
    reason: stageAdvanceSignal.reason || stageAdvanceSignal.transitionKind,
  });
  const lateCompletionDiagnostic = buildLateCompletionDiagnostic(lateCompletionLease);

  return {
    truth,
    updateContract(contract) {
      let changed = false;
      contract.executionObservation = executionObservation || null;
      changed = true;

      if (truth.stagePlan) {
        contract.stagePlan = truth.stagePlan;
        contract.stageRuntime = truth.stageRuntime;
        contract.phases = deriveCompatibilityPhases(truth.stagePlan);
        contract.total = deriveCompatibilityTotal(truth.stagePlan);
      }

      const requestedTask = typeof contract.requestedTask === "string" && contract.requestedTask.trim()
        ? contract.requestedTask.trim()
        : (typeof contract.task === "string" ? contract.task.trim() : "");
      if (requestedTask && contract.requestedTask !== requestedTask) {
        contract.requestedTask = requestedTask;
      }
      contract.task = buildLoopStageTask({
        baseTask: requestedTask,
        previousStage: pipelineStage.stage,
        previousFeedback: stageAdvanceSignal.result || stageAdvanceSignal.feedback || null,
        previousArtifactPath: stageAdvanceSignal.primaryArtifactPath || null,
      });

      contract.pipelineStage = {
        ...(contract.pipelineStage && typeof contract.pipelineStage === "object"
          ? contract.pipelineStage
          : {}),
        pipelineId: pipelineStage.pipelineId || null,
        loopId: pipelineStage.loopId || null,
        loopSessionId: pipelineStage.loopSessionId || null,
        stage: nextStage,
        round: nextRound,
        semanticStageId: truth.stageRuntime?.currentStageId || null,
        previousStage: pipelineStage.stage,
        previousFeedback: stageAdvanceSignal.result || stageAdvanceSignal.feedback || null,
        previousArtifactPath: stageAdvanceSignal.primaryArtifactPath || null,
      };
      mergeLoopProgressionDiagnostics(
        contract,
        progressionDiagnostic,
        lateCompletionDiagnostic,
      );
      return changed;
    },
  };
}

async function routeLoopTaggedSharedContract(context, pipelineStage) {
  const contractData = context.effectiveContractData || context.trackingState?.contract || null;
  const stageAdvanceSignal = resolveStageAdvanceSignal(context.executionObservation);
  const lateCompletionDiagnostic = buildLateCompletionDiagnostic(context.lateCompletionLease);
  const loopSessionState = await loadLoopSessionState();
  const activeLoopSession = loopSessionState?.activeSession?.id === pipelineStage.loopSessionId
    ? loopSessionState.activeSession
    : null;
  const archivedLoopSession = activeLoopSession
    ? null
    : (Array.isArray(loopSessionState?.recentSessions)
      ? loopSessionState.recentSessions.find((entry) => entry?.id === pipelineStage.loopSessionId) || null
      : null);
  if (!activeLoopSession) {
    const progressionDiagnostic = buildSkippedPipelineProgressionDiagnostic({
      pipelineStage,
      reason: archivedLoopSession?.status
        ? `inactive_loop_session:${archivedLoopSession.status}`
        : "missing_loop_session",
      action: "loop_session_inactive",
      error: archivedLoopSession?.status
        ? `loop session ${pipelineStage.loopSessionId} is ${archivedLoopSession.status}`
        : `loop session ${pipelineStage.loopSessionId} is missing`,
    });
    await persistLoopProgressionDiagnostics(context, progressionDiagnostic, {
      lateCompletionDiagnostic,
    });
    return {
      routed: false,
      owned: false,
      action: "terminal",
      reason: progressionDiagnostic.reason,
      target: null,
    };
  }
  if (!stageAdvanceSignal.ok) {
    const progressionDiagnostic = buildSkippedPipelineProgressionDiagnostic({
      pipelineStage,
      reason: stageAdvanceSignal.reason,
    });
    await persistLoopProgressionDiagnostics(context, progressionDiagnostic, {
      lateCompletionDiagnostic,
    });
    return {
      routed: false,
      owned: true,
      action: "hold",
      reason: stageAdvanceSignal.reason,
      target: null,
    };
  }

  if (stageAdvanceSignal.transitionKind === "conclude") {
    return {
      routed: false,
      action: "terminal",
      reason: "explicit_conclude",
      target: null,
    };
  }

  const resolvedLoops = await listResolvedGraphLoops();
  const targetLoop = resolvedLoops.find((loop) => (
    loop?.id === pipelineStage.loopId
    || loop?.id === pipelineStage.pipelineId
  )) || null;
  const graph = await loadGraph();

  if (
    stageAdvanceSignal.suggestedNext
    && !hasDirectedEdge(graph, context.agentId, stageAdvanceSignal.suggestedNext)
  ) {
    const progressionDiagnostic = buildSkippedPipelineProgressionDiagnostic({
      pipelineStage,
      reason: "illegal_transition",
      action: "invalid_state",
      error: `illegal transition ${context.agentId} -> ${stageAdvanceSignal.suggestedNext}`,
    });
    await persistLoopProgressionDiagnostics(context, progressionDiagnostic, {
      lateCompletionDiagnostic,
    });
    return {
      routed: false,
      owned: true,
      action: "invalid_state",
      reason: "illegal_transition",
      error: `illegal transition ${context.agentId} -> ${stageAdvanceSignal.suggestedNext}`,
      target: null,
    };
  }

  const resolvedRoute = stageAdvanceSignal.suggestedNext
    ? {
        routable: true,
        action: "explicit",
        target: stageAdvanceSignal.suggestedNext,
      }
    : await resolveRouteAfterAgentEndTarget(context.agentId, {
        status: "completed",
      });

  if (!resolvedRoute.routable || !resolvedRoute.target) {
    const progressionDiagnostic = buildSkippedPipelineProgressionDiagnostic({
      pipelineStage,
      reason: resolvedRoute.action || "terminal",
      action: resolvedRoute.action || null,
    });
    await persistLoopProgressionDiagnostics(context, progressionDiagnostic, {
      lateCompletionDiagnostic,
    });
    return {
      routed: false,
      owned: resolvedRoute.action !== "terminal",
      action: resolvedRoute.action || "terminal",
      reason: resolvedRoute.action || "terminal",
      target: null,
    };
  }

  const nextRound = computeLoopNextRound(
    targetLoop,
    pipelineStage.stage,
    resolvedRoute.target,
    pipelineStage.round,
  );
  const budgetGovernance = evaluateLoopBudgetGovernance({
    activeLoopSession,
    pipelineStage,
    nextStage: resolvedRoute.target,
    nextRound,
  });
  if (budgetGovernance.exhausted) {
    const progressionDiagnostic = buildSkippedPipelineProgressionDiagnostic({
      pipelineStage,
      reason: budgetGovernance.reason,
      action: "loop_budget_exhausted",
      error: `loop runtime blocked routing to ${resolvedRoute.target} after round ${pipelineStage.round || 1}`,
    });
    await persistLoopProgressionDiagnostics(context, progressionDiagnostic, {
      lateCompletionDiagnostic,
    });
    return {
      routed: false,
      owned: false,
      action: "terminal",
      reason: budgetGovernance.reason,
      target: null,
      terminalOutcome: budgetGovernance.terminalOutcome,
    };
  }
  const mutation = buildLoopContractRouteMutation({
    contractData,
    pipelineStage,
    stageAdvanceSignal,
    executionObservation: context.executionObservation || null,
    nextStage: resolvedRoute.target,
    nextRound,
    lateCompletionLease: context.lateCompletionLease,
  });

  const routeResult = await routeAfterAgentEnd(
    context.agentId,
    contractData?.id || context.trackingState?.contract?.id || null,
    {
      status: "completed",
      api: context.api,
      logger: context.logger,
      targetAgent: resolvedRoute.target,
      updateContract: mutation.updateContract,
    },
  );

  if (routeResult.routed && pipelineStage.loopSessionId) {
    await advanceLoopSession({
      sessionId: pipelineStage.loopSessionId,
      previousStage: pipelineStage.stage,
      currentStage: resolvedRoute.target,
      round: nextRound,
      budget: budgetGovernance.updatedBudget,
      feedback: stageAdvanceSignal.feedback || stageAdvanceSignal.result || null,
      feedbackOutput: buildLoopFeedbackOutput(
        pipelineStage,
        stageAdvanceSignal,
        context.executionObservation || null,
        context.agentId,
      ),
      taskStagePlan: mutation.truth.stagePlan || contractData?.stagePlan || null,
      taskStageRuntime: mutation.truth.stageRuntime || contractData?.stageRuntime || null,
    });
  }

  return {
    ...routeResult,
    owned: true,
    reason: stageAdvanceSignal.reason || null,
    target: resolvedRoute.target,
  };
}

export async function runAgentEndGraphRoute(context) {
  const contractData = context.effectiveContractData || context.trackingState?.contract || null;
  const contractId = context.executionObservation?.contractId || context.trackingState?.contract?.id || null;
  if (!contractId || !context.event?.success) {
    return null;
  }
  if (contractId.startsWith("DIRECT-")) {
    return {
      routed: false,
      action: "direct_request",
      target: null,
    };
  }

  const pipelineStage = contractRouteStage(contractData);
  if (pipelineStage) {
    return routeLoopTaggedSharedContract(context, pipelineStage);
  }

  const routeResult = await routeAfterAgentEnd(context.agentId, contractId, {
    status: "completed",
    api: context.api,
    logger: context.logger,
  });
  return routeResult;
}
