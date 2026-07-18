import { readFile } from "node:fs/promises";
import {
  materializeTaskStageTruth,
  deriveDisplayPhases,
  deriveDisplayTotal,
} from "../task-stage-plan.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import {
  routeAfterAgentEnd,
  resolveRouteAfterAgentEndTarget,
} from "../routing/dispatch-graph-policy.js";
import { listResolvedGraphLoops } from "../loop/graph-loop-registry.js";
import {
  advanceLoopSession,
  loadLoopSessionState,
} from "../loop/loop-session-store.js";
import { isSessionHardStopped, getSessionHardStopReason, HARD_STOP_REASON } from "../loop/loop-detection.js";
import { resolveLoopEpochKey } from "../loop/loop-epoch-key.js";
import {
  normalizeContractStageDescriptor,
  resolveStageAdvanceSignal,
} from "./agent-end-stage-advance.js";
import { mergeRuntimeDiagnostics } from "./agent-end-contract-refresh.js";
import { evaluateTrace } from "../store/execution-trace-store.js";
import { isDirectRequestEnvelope } from "../protocol-primitives.js";
import {
  buildGraphRouteProgressionDiagnostic,
  buildSkippedGraphRouteProgressionDiagnostic,
  buildLateCompletionDiagnostic,
  mergeGraphRouteProgressionDiagnostics,
  persistGraphRouteProgressionDiagnostics,
} from "./agent-end-graph-route-diagnostics.js";
import { evaluateLoopBudgetGovernance } from "./agent-end-loop-budget-governance.js";

function normalizePositiveInteger(value, fallback = null) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(numeric);
  }
  return fallback;
}

function contractRouteStage(contract) {
  return normalizeContractStageDescriptor(contract?.pipelineStage);
}

function getRuntimeTraceVerdict(context, contractData) {
  return evaluateTrace(context?.sessionKey)
    || contractData?.runtimeDiagnostics?.executionTrace
    || context?.trackingState?.contract?.runtimeDiagnostics?.executionTrace
    || null;
}

function hasSemanticProgressObservation(executionObservation) {
  if (!executionObservation || typeof executionObservation !== "object") {
    return false;
  }
  return Boolean(
    executionObservation.stageRunResult
    || executionObservation.stageCompletion
    || executionObservation.reviewerResult
    || executionObservation.reviewVerdict
    || executionObservation.researchDirection
    || executionObservation.nextAction
    || executionObservation.searchSpace
    || executionObservation.systemAction
    || (Array.isArray(executionObservation.files) && executionObservation.files.length > 0)
    || (Array.isArray(executionObservation.artifactPaths) && executionObservation.artifactPaths.length > 0)
    || executionObservation.primaryOutputPath
  );
}

async function resolveHardStopProgressGate(context, contractData) {
  const traceVerdict = getRuntimeTraceVerdict(context, contractData);
  if (
    traceVerdict?.systemActionSeen === true
    || hasSemanticProgressObservation(context?.executionObservation)
  ) {
    return {
      kind: "semantic_progress",
    };
  }

  return null;
}

function resolveHardStopTerminalGate(context, contractData) {
  const outputPath = String(
    contractData?.output
    || context?.trackingState?.contract?.output
    || "",
  ).trim();
  const epochKey = resolveLoopEpochKey(context?.trackingState) || context?.sessionKey;
  if (isSessionHardStopped(epochKey)) {
    const hardStopReason = getSessionHardStopReason(epochKey) || HARD_STOP_REASON.LOOP_DETECTED;
    const summaryByReason = {
      [HARD_STOP_REASON.REPEAT_THRESHOLD]: "session terminated due to repeated identical tool calls before final output was committed",
      [HARD_STOP_REASON.MAX_TOOL_CALLS]: "session terminated because executionPolicy.maxToolCalls budget was exhausted",
      // FIX(A4-output-length-stop): keep this parallel summaryByReason map in sync with hard-stop-terminalize.js.
      [HARD_STOP_REASON.OUTPUT_BUDGET_EXHAUSTED]: "session terminated because the cumulative tool-output byte budget was exhausted",
      [HARD_STOP_REASON.MANUAL]: "session terminated by explicit operator intervention",
    };
    return {
      routed: false,
      owned: false,
      action: "terminal",
      reason: hardStopReason,
      target: null,
      terminalOutcome: {
        status: CONTRACT_STATUS.FAILED,
        source: "loop_runtime",
        reason: hardStopReason,
        summary: summaryByReason[hardStopReason]
          || `session hard-stopped (${hardStopReason}) before final output was committed`,
        artifact: outputPath || null,
      },
    };
  }

  return null;
}

// 中间 handoff 完成校验:即将转发给下一环时，若本环产物文件存在但内容为空/过短，
// 不转发，判 terminal(retryable)——防止"agent 自以为做完、实际没产出实质交付物"被传送带原样推给下游。
// 阈值保守(只拦近乎空/占位输出)，正常短答不误伤；只作用于"有产物文件但内容过短"，无文件交既有 progress gate。
const MIN_HANDOFF_OUTPUT_CHARS = 24;
export async function resolveIncompleteHandoffGate(context, targetAgent) {
  const outputPath = context?.executionObservation?.primaryOutputPath;
  // 复用 extract_output_markers 已读入的同一产物正文（先于 graph_route，避免重复读盘）；
  // 无缓存才回退读盘。readFile 自身对缺失文件抛错，无需额外 existsSync。
  let content = typeof context?._outputContent === "string" ? context._outputContent : null;
  if (content == null) {
    if (typeof outputPath !== "string" || !outputPath.trim()) {
      return null;
    }
    try {
      content = await readFile(outputPath, "utf8");
    } catch {
      return null;
    }
  }
  const len = content.trim().length;
  if (len >= MIN_HANDOFF_OUTPUT_CHARS) {
    return null;
  }
  return {
    routed: false,
    owned: false,
    action: "terminal",
    reason: "incomplete_output",
    target: null,
    terminalOutcome: {
      status: CONTRACT_STATUS.FAILED,
      source: "handoff_completion_gate",
      reason: "incomplete_output",
      retryable: true,
      summary: `产物为空或过短（${len} 字 < ${MIN_HANDOFF_OUTPUT_CHARS} 阈值），未转发给下一环 ${targetAgent || "?"}；需重做并产出实质交付物`,
      artifact: outputPath || null,
    },
  };
}

function buildLoopFeedbackOutput(contractStage, stageAdvanceSignal, executionObservation, agentId) {
  return {
    result: stageAdvanceSignal?.result || null,
    feedback: stageAdvanceSignal?.feedback || null,
    artifactPaths: Array.isArray(stageAdvanceSignal?.artifactPaths) ? stageAdvanceSignal.artifactPaths : [],
    primaryArtifactPath: stageAdvanceSignal?.primaryArtifactPath || null,
    executionObservation: executionObservation || null,
    fromStage: contractStage.stage,
    fromAgent: agentId,
    ts: Date.now(),
  };
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
  contractStage,
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
  const progressionDiagnostic = buildGraphRouteProgressionDiagnostic({
    contractStage,
    nextStage,
    nextRound,
    reason: stageAdvanceSignal?.reason || stageAdvanceSignal?.transitionKind || "graph_route",
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
        contract.phases = deriveDisplayPhases(truth.stagePlan);
        contract.total = deriveDisplayTotal(truth.stagePlan);
      }

      const requestedTask = typeof contract.requestedTask === "string" && contract.requestedTask.trim()
        ? contract.requestedTask.trim()
        : (typeof contract.task === "string" ? contract.task.trim() : "");
      if (requestedTask && contract.requestedTask !== requestedTask) {
        contract.requestedTask = requestedTask;
      }
      if (requestedTask && contract.task !== requestedTask) {
        contract.task = requestedTask;
      }

      contract.pipelineStage = {
        ...(contract.pipelineStage && typeof contract.pipelineStage === "object"
          ? contract.pipelineStage
          : {}),
        pipelineId: contractStage.pipelineId || null,
        loopId: contractStage.loopId || null,
        loopSessionId: contractStage.loopSessionId || null,
        stage: nextStage,
        round: nextRound,
        semanticStageId: truth.stageRuntime?.currentStageId || null,
      };
      mergeGraphRouteProgressionDiagnostics(
        contract,
        progressionDiagnostic,
        lateCompletionDiagnostic,
      );
      return changed;
    },
  };
}

async function routeLoopTaggedSharedContract(context, contractStage) {
  const contractData = context.effectiveContractData || context.trackingState?.contract || null;
  const stageAdvanceSignal = resolveStageAdvanceSignal(context.executionObservation);
  const lateCompletionDiagnostic = buildLateCompletionDiagnostic(context.lateCompletionLease);
  const loopSessionState = await loadLoopSessionState();
  const activeLoopSession = loopSessionState?.activeSession?.id === contractStage.loopSessionId
    ? loopSessionState.activeSession
    : null;
  const archivedLoopSession = activeLoopSession
    ? null
    : (Array.isArray(loopSessionState?.recentSessions)
      ? loopSessionState.recentSessions.find((entry) => entry?.id === contractStage.loopSessionId) || null
      : null);
  if (!activeLoopSession) {
    const progressionDiagnostic = buildSkippedGraphRouteProgressionDiagnostic({
      contractStage,
      reason: archivedLoopSession?.status
        ? `inactive_loop_session:${archivedLoopSession.status}`
        : "missing_loop_session",
      action: "loop_session_inactive",
      error: archivedLoopSession?.status
        ? `loop session ${contractStage.loopSessionId} is ${archivedLoopSession.status}`
        : `loop session ${contractStage.loopSessionId} is missing`,
    });
    await persistGraphRouteProgressionDiagnostics(context, progressionDiagnostic, {
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
  const semanticTruth = materializeTaskStageTruth({
    contractId: contractData?.id || null,
    stagePlan: contractData?.stagePlan || null,
    stageRuntime: contractData?.stageRuntime || null,
    executionObservation: context.executionObservation || null,
  });

  const resolvedLoops = await listResolvedGraphLoops();
  const targetLoop = resolvedLoops.find((loop) => (
    loop?.id === contractStage.loopId
    || loop?.id === contractStage.pipelineId
  )) || null;
  const resolvedRoute = await resolveRouteAfterAgentEndTarget(context.agentId, {
    status: "completed",
  });

  if (!resolvedRoute.routable || !resolvedRoute.target) {
    const progressionDiagnostic = buildSkippedGraphRouteProgressionDiagnostic({
      contractStage,
      reason: resolvedRoute.action || "terminal",
      action: resolvedRoute.action || null,
    });
    await persistGraphRouteProgressionDiagnostics(context, progressionDiagnostic, {
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
    contractStage.stage,
    resolvedRoute.target,
    contractStage.round,
  );
  const budgetGovernance = evaluateLoopBudgetGovernance({
    activeLoopSession,
    contractStage,
    nextStage: resolvedRoute.target,
    nextRound,
  });
  if (budgetGovernance.exhausted) {
    if (contractStage.loopSessionId && budgetGovernance.updatedBudget) {
      await advanceLoopSession({
        sessionId: contractStage.loopSessionId,
        currentStage: contractStage.stage,
        round: contractStage.round || 1,
        budget: budgetGovernance.updatedBudget,
      });
    }
    const progressionDiagnostic = buildSkippedGraphRouteProgressionDiagnostic({
      contractStage,
      reason: budgetGovernance.reason,
      action: "loop_budget_exhausted",
      error: `loop runtime blocked routing to ${resolvedRoute.target} after round ${contractStage.round || 1}`,
    });
    await persistGraphRouteProgressionDiagnostics(context, progressionDiagnostic, {
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
    contractStage,
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

  if (routeResult.routed && contractStage.loopSessionId) {
    await advanceLoopSession({
      sessionId: contractStage.loopSessionId,
      previousStage: contractStage.stage,
      currentStage: resolvedRoute.target,
      round: nextRound,
      budget: budgetGovernance.updatedBudget,
      feedback: stageAdvanceSignal.feedback || stageAdvanceSignal.result || null,
      feedbackOutput: buildLoopFeedbackOutput(
        contractStage,
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
  if (isDirectRequestEnvelope(contractData) || isDirectRequestEnvelope(context.trackingState?.contract)) {
    return {
      routed: false,
      action: "direct_request",
      target: null,
    };
  }
  if (
    context.event?.protocolBoundary === "canonical_outbox_commit"
    && context.event?.commitType === "output_commit"
  ) {
    return {
      routed: false,
      owned: true,
      action: "output_commit_observed",
      target: null,
    };
  }

  const contractStage = contractRouteStage(contractData);
  if (contractStage) {
    const hardStopGate = resolveHardStopTerminalGate(context, contractData);
    if (hardStopGate) {
      const progressGate = await resolveHardStopProgressGate(context, contractData);
      if (!progressGate) return hardStopGate;
    }
    return routeLoopTaggedSharedContract(context, contractStage);
  }

  const resolvedRoute = await resolveRouteAfterAgentEndTarget(context.agentId, {
    status: "completed",
  });
  const hardStopGate = resolveHardStopTerminalGate(context, contractData);
  if (hardStopGate) {
    const traceVerdict = getRuntimeTraceVerdict(context, contractData);
    if (traceVerdict?.outputCommitted === true && resolvedRoute.routable && resolvedRoute.target) {
      return routeAfterAgentEnd(context.agentId, contractId, {
        status: "completed",
        api: context.api,
        logger: context.logger,
        targetAgent: resolvedRoute.target,
      });
    }
    const progressGate = await resolveHardStopProgressGate(context, contractData);
    if (progressGate) {
      if (resolvedRoute.routable && resolvedRoute.target) {
        return routeAfterAgentEnd(context.agentId, contractId, {
          status: "completed",
          api: context.api,
          logger: context.logger,
          targetAgent: resolvedRoute.target,
        });
      }
      if (!resolvedRoute.routable || resolvedRoute.action === "terminal") {
        return {
          routed: false,
          action: resolvedRoute.action || "terminal",
          target: resolvedRoute.target || null,
        };
      }
    }
    return hardStopGate;
  }
  if (resolvedRoute.routable && resolvedRoute.target) {
    const incompleteGate = await resolveIncompleteHandoffGate(context, resolvedRoute.target);
    if (incompleteGate) {
      context.logger?.warn?.(`[graph-route] incomplete_output: ${contractId} 产物为空/过短，未转发给 ${resolvedRoute.target}`);
      return incompleteGate;
    }
    return routeAfterAgentEnd(context.agentId, contractId, {
      status: "completed",
      api: context.api,
      logger: context.logger,
      targetAgent: resolvedRoute.target,
    });
  }

  const routeResult = await routeAfterAgentEnd(context.agentId, contractId, {
    status: "completed",
    api: context.api,
    logger: context.logger,
  });
  return routeResult;
}

// Re-export diagnostic helpers for consumers that import from this module
export {
  buildLateCompletionDiagnostic,
  mergeGraphRouteProgressionDiagnostics,
} from "./agent-end-graph-route-diagnostics.js";

// Re-export budget governance for consumers
export { evaluateLoopBudgetGovernance } from "./agent-end-loop-budget-governance.js";
