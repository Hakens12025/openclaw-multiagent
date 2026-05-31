import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { commitSemanticTerminalState } from "../terminal-commit.js";
import { finalizeAgentSession } from "../lifecycle/runtime-lifecycle.js";
import { mergeRuntimeDiagnostics } from "../lifecycle/agent-end-contract-refresh.js";
import { getSessionHardStopReason, HARD_STOP_REASON } from "../loop/loop-detection.js";
import { resolveLoopEpochKey } from "../loop/loop-epoch-key.js";
import { getExecutionIncident } from "./execution-incident-store.js";
import { normalizeTerminalOutcome, resolveTerminalOutcome } from "../terminal-outcome.js";
import { evaluateTrace } from "../store/execution-trace-store.js";
import { resolveRouteAfterAgentEndTarget } from "../routing/dispatch-graph-policy.js";

const terminalizingSessions = new Set();

function resolveHardStopReason(epochKey) {
  return getSessionHardStopReason(epochKey) || HARD_STOP_REASON.LOOP_DETECTED;
}

function buildHardStopTerminalOutcome(reason, outputPath) {
  const summaryByReason = {
    [HARD_STOP_REASON.REPEAT_THRESHOLD]: "session terminated due to repeated identical tool calls before final output was committed",
    [HARD_STOP_REASON.MAX_TOOL_CALLS]: "session terminated because executionPolicy.maxToolCalls budget was exhausted",
    [HARD_STOP_REASON.MANUAL]: "session terminated by explicit operator intervention",
  };
  return normalizeTerminalOutcome({
    status: CONTRACT_STATUS.FAILED,
    source: "loop_runtime",
    reason,
    summary: summaryByReason[reason] || `session hard-stopped (${reason}) before final output was committed`,
    artifact: outputPath || null,
  }, {
    terminalStatus: CONTRACT_STATUS.FAILED,
  });
}

function mergeExecutionIncidentIntoOutcome(terminalOutcome, executionIncident) {
  if (!executionIncident?.rootFault) {
    return terminalOutcome;
  }
  return normalizeTerminalOutcome({
    ...terminalOutcome,
    reason: executionIncident.terminationReason
      || executionIncident.firstFaultCode
      || terminalOutcome.reason,
    clarification: [
      terminalOutcome.clarification,
      `runtime incident: ${[
        executionIncident.rootFault,
        executionIncident.firstFaultCode || null,
      ].filter(Boolean).join(" / ")}`,
    ].filter(Boolean).join(" | ") || null,
  }, {
    terminalStatus: CONTRACT_STATUS.FAILED,
  });
}

async function shouldDeferHardStopTerminalization({
  agentId,
  sessionKey,
} = {}) {
  const traceVerdict = evaluateTrace(sessionKey);
  const route = await resolveRouteAfterAgentEndTarget(agentId, { status: "completed" });
  if (route?.routable && route?.target && traceVerdict?.outputCommitted === true) {
    return {
      defer: true,
      reason: "graph_route_after_committed_output",
    };
  }

  return {
    defer: false,
    reason: null,
  };
}

async function resolveAuthoritativeHardStopOutcome({
  trackingState,
  logger,
} = {}) {
  const executionObservation = trackingState?.contract?.executionObservation || null;
  const resolvedOutcome = await resolveTerminalOutcome({
    trackingState,
    contractData: trackingState?.contract || null,
    executionObservation,
    logger,
  });
  const source = resolvedOutcome?.terminalOutcome?.source || null;
  if (source === "runtime_result") {
    return resolvedOutcome;
  }
  if (source === "completion_criteria") {
    const terminalStatus = resolvedOutcome?.terminalOutcome?.status
      || resolvedOutcome?.terminalStatus
      || null;
    if (terminalStatus !== CONTRACT_STATUS.COMPLETED) {
      return resolvedOutcome;
    }
    const hasExplicitRuntimeResult = executionObservation?.explicitRuntimeResult === true
      || Boolean(executionObservation?.stageRunResult);
    const hasExplicitRequiredFiles = Array.isArray(trackingState?.contract?.completionCriteria?.requiredFiles)
      && trackingState.contract.completionCriteria.requiredFiles.length > 0;
    if (hasExplicitRuntimeResult || hasExplicitRequiredFiles) {
      return resolvedOutcome;
    }
  }
  return null;
}

export async function terminalizeHardStoppedRuntimeSession({
  agentId,
  sessionKey,
  trackingState,
  api,
  logger,
} = {}) {
  if (!trackingState?.contract?.id || !sessionKey || !agentId) {
    return { terminalized: false, reason: "missing_tracking_contract" };
  }
  if (trackingState.status === CONTRACT_STATUS.FAILED || trackingState.contract.status === CONTRACT_STATUS.FAILED) {
    return { terminalized: false, reason: "already_failed" };
  }
  if (trackingState.status === CONTRACT_STATUS.COMPLETED || trackingState.contract.status === CONTRACT_STATUS.COMPLETED) {
    return { terminalized: false, reason: "already_completed" };
  }

  const epochKey = resolveLoopEpochKey(trackingState) || sessionKey;
  const lockKey = `${sessionKey}:${trackingState.contract.id}`;
  if (terminalizingSessions.has(lockKey)) {
    return { terminalized: false, reason: "terminalize_in_progress" };
  }
  terminalizingSessions.add(lockKey);
  try {
    const deferCheck = await shouldDeferHardStopTerminalization({
      agentId,
      sessionKey,
    });
    if (deferCheck.defer) {
      return { terminalized: false, reason: deferCheck.reason };
    }

    const hardStopReason = resolveHardStopReason(epochKey);
    const executionIncident = getExecutionIncident({
      contractId: trackingState.contract.id,
      epochKey,
      sessionKey,
    });
    const authoritativeOutcome = await resolveAuthoritativeHardStopOutcome({
      trackingState,
      logger,
    });
    const terminalOutcome = mergeExecutionIncidentIntoOutcome(
      authoritativeOutcome?.terminalOutcome
        || buildHardStopTerminalOutcome(hardStopReason, trackingState.contract.output || null),
      executionIncident,
    );
    const terminalStatus = terminalOutcome?.status
      || authoritativeOutcome?.terminalStatus
      || CONTRACT_STATUS.FAILED;
    const runtimeDiagnostics = mergeRuntimeDiagnostics(
      trackingState.contract.runtimeDiagnostics,
      {
        loopHardStop: {
          terminalized: true,
          reason: hardStopReason,
          epochKey,
          ts: Date.now(),
        },
        ...(executionIncident ? { executionIncident } : {}),
      },
    );
    const commitResult = await commitSemanticTerminalState({
      trackingState,
      terminalStatus,
      terminalOutcome,
      logger,
      extraFields: {
        runtimeDiagnostics,
      },
    });
    if (!commitResult.committed) {
      return { terminalized: false, reason: commitResult.reason || "commit_failed" };
    }

    await finalizeAgentSession({
      agentId,
      sessionKey,
      trackingState,
      api,
      logger,
    });
    return {
      terminalized: true,
      reason: hardStopReason,
      terminalOutcome,
    };
  } finally {
    terminalizingSessions.delete(lockKey);
  }
}
