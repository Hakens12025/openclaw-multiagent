import {
  buildDeferredSystemActionFollowUp,
  deriveSystemActionTerminalOutcome,
  isDeferredSystemActionAccepted,
} from "../system-action/system-action-runtime-ledger.js";
import { deliveryRunTerminalRuntime } from "../routing/delivery-terminal-runtime.js";
import {
  commitSemanticTerminalState,
  mergeTrackingContractFields,
} from "../terminal-commit.js";
import { normalizeTerminalOutcome, resolveTerminalOutcome } from "../terminal-outcome.js";
import { deliveryRunSystemActionChain } from "../routing/delivery-system-action-chain.js";
import { evaluateTrace } from "../store/execution-trace-store.js";
import {
  CONTRACT_STATUS,
  SYSTEM_ACTION_STATUS,
  isTerminalContractStatus,
} from "../core/runtime-status.js";
import { materializeExecutionObservation } from "../execution-observation.js";
import { mergeRuntimeDiagnostics } from "./agent-end-contract-refresh.js";
import {
  maybeFinalizeLoopSession,
  normalizeContractStageDescriptor,
} from "./agent-end-stage-advance.js";
import { buildOutputIoObservation, mergeIoObservation } from "../io-observation.js";
import { getExecutionIncident } from "../runtime/execution-incident-store.js";
import { resolveLoopEpochKey } from "../loop/loop-epoch-key.js";
import { recordAgentEndHarnessRun } from "./agent-end-harness-recorder.js";

export { resolveAgentEndHarnessAutomationId } from "./agent-end-harness-automation-id.js";

function buildIncidentClarification(executionIncident) {
  if (!executionIncident?.rootFault) {
    return null;
  }
  const parts = [
    executionIncident.rootFault,
    executionIncident.firstFaultCode || null,
  ];
  if (Array.isArray(executionIncident.amplifiers) && executionIncident.amplifiers.length > 0) {
    parts.push(`amplifiers=${executionIncident.amplifiers.join(",")}`);
  }
  return `runtime incident: ${parts.filter(Boolean).join(" / ")}`;
}

function applyExecutionIncidentToTerminalOutcome(terminalOutcome, executionIncident) {
  if (!terminalOutcome || !executionIncident?.rootFault) {
    return terminalOutcome;
  }

  return normalizeTerminalOutcome({
    ...terminalOutcome,
    reason: executionIncident.terminationReason
      || executionIncident.firstFaultCode
      || terminalOutcome.reason,
    clarification: [
      terminalOutcome.clarification,
      buildIncidentClarification(executionIncident),
    ].filter(Boolean).join(" | ") || null,
  }, {
    terminalStatus: terminalOutcome.status,
  });
}

function buildSystemActionContractFields(systemActionResult, {
  deferredFollowUp = null,
} = {}) {
  if (!systemActionResult || systemActionResult.status === SYSTEM_ACTION_STATUS.NO_ACTION) {
    return {};
  }

  return {
    systemAction: {
      type: systemActionResult.actionType || null,
      status: systemActionResult.status || null,
      targetAgent: systemActionResult.targetAgent || null,
      contractId: systemActionResult.contractId || null,
      error: systemActionResult.error || null,
      retryable: systemActionResult.status === SYSTEM_ACTION_STATUS.BUSY,
      wake: systemActionResult.wake || null,
      ts: Date.now(),
    },
    ...(deferredFollowUp ? { followUp: deferredFollowUp } : {}),
  };
}

function markDuplicateTerminalTrackingState(trackingState, terminalStatus, terminalOutcome = null) {
  if (!trackingState) return;
  const effectiveTerminalStatus = isTerminalContractStatus(terminalStatus)
    ? terminalStatus
    : CONTRACT_STATUS.COMPLETED;
  trackingState.status = effectiveTerminalStatus;
  trackingState.lastLabel = `已收口（重复${effectiveTerminalStatus}）`;
  if (!trackingState.contract) return;
  trackingState.contract.status = effectiveTerminalStatus;
  if (terminalOutcome) {
    trackingState.contract.terminalOutcome = terminalOutcome;
  }
  trackingState.pct = 100;
  trackingState.cursor = `${trackingState.contract.total}/${trackingState.contract.total}`;
  trackingState.estimatedPhase = effectiveTerminalStatus === CONTRACT_STATUS.COMPLETED
    ? "已完成"
    : effectiveTerminalStatus;
}

function resolveGraphTerminalOutcome(graphRouteResult) {
  if (!graphRouteResult?.terminalOutcome) {
    return null;
  }
  const terminalOutcome = normalizeTerminalOutcome(
    graphRouteResult.terminalOutcome,
    {
      terminalStatus: graphRouteResult.terminalOutcome.status || CONTRACT_STATUS.COMPLETED,
    },
  );
  return {
    terminalOutcome,
    terminalStatus: terminalOutcome.status,
  };
}

export async function handleSuccessfulTrackingCompletion(context) {
  const {
    agentId,
    logger,
    executionObservation,
    systemActionResult,
    contractReadDiagnostic,
    trackingState,
    effectiveContractData,
  } = context;
  const duplicateTerminalContract = isTerminalContractStatus(effectiveContractData?.status);
  const runtimeDiagnostics = {};
  let effectiveContractForOutcome = effectiveContractData || trackingState?.contract || null;
  let effectiveExecutionObservation = materializeExecutionObservation(executionObservation, {
    contractId: effectiveContractForOutcome?.id || trackingState?.contract?.id || null,
    fallbackPrimaryOutputPath: effectiveContractForOutcome?.output || trackingState?.contract?.output || null,
  });
  context.executionObservation = effectiveExecutionObservation;

  const traceVerdict = evaluateTrace(context.sessionKey);
  const executionIncident = getExecutionIncident({
    contractId: effectiveContractForOutcome?.id || trackingState?.contract?.id || null,
    epochKey: resolveLoopEpochKey(trackingState) || context.sessionKey,
    sessionKey: context.sessionKey,
  });
  if (traceVerdict) {
    runtimeDiagnostics.executionTrace = traceVerdict;
    effectiveContractForOutcome = {
      ...(effectiveContractForOutcome || {}),
      runtimeDiagnostics: mergeRuntimeDiagnostics(
        effectiveContractForOutcome?.runtimeDiagnostics,
        { executionTrace: traceVerdict },
      ),
    };
    if (traceVerdict.offTrack) {
      logger.warn(`[watchdog] TRACE OFF-TRACK: ${context.sessionKey} — ${traceVerdict.totalCalls} calls, output not committed`);
    }
    if (traceVerdict.delegationReceipt) {
      const dr = traceVerdict.delegationReceipt;
      logger.info(`[watchdog] DELEGATION RECEIPT: ${dr.delegationId} — ${dr.intentType}${dr.targetAgent ? ` → ${dr.targetAgent}` : ""} (valid: ${dr.valid})`);
    }
  }

  if (contractReadDiagnostic) {
    runtimeDiagnostics.contractRead = contractReadDiagnostic;
  }
  if (executionIncident) {
    runtimeDiagnostics.executionIncident = executionIncident;
  }
  if (context.lateCompletionLease) {
    runtimeDiagnostics.lateCompletion = {
      recovered: true,
      reason: context.lateCompletionLease.reason || "tracker_timeout",
      stage: context.lateCompletionLease.stage || null,
      pipelineId: context.lateCompletionLease.pipelineId || null,
      loopId: context.lateCompletionLease.loopId || null,
      loopSessionId: context.lateCompletionLease.loopSessionId || null,
      contractId: context.lateCompletionLease.contractId || null,
      armedAt: context.lateCompletionLease.armedAt || null,
      resumedAt: context.lateCompletionLease.resumedAt || Date.now(),
      diagnostic: context.lateCompletionLease.diagnostic || null,
    };
  }

  if (duplicateTerminalContract) {
    logger.info(
      `[watchdog] contract ${trackingState.contract.id} already ${effectiveContractData.status}, `
      + "skipping duplicate delivery",
    );
    markDuplicateTerminalTrackingState(
      trackingState,
      effectiveContractData.status,
      effectiveContractData.terminalOutcome || trackingState.contract?.terminalOutcome || null,
    );
    runtimeDiagnostics.duplicateTerminal = {
      skipped: true,
      terminalStatus: effectiveContractData.status,
      reason: "duplicate_terminal_contract",
      ts: Date.now(),
    };
  } else {
    const deferredSystemAction = isDeferredSystemActionAccepted(systemActionResult);
    const deferredFollowUp = deferredSystemAction
      ? buildDeferredSystemActionFollowUp(systemActionResult)
      : null;
    const systemActionFailureOutcome = deferredSystemAction
      ? null
      : deriveSystemActionTerminalOutcome(systemActionResult, effectiveExecutionObservation);
    const graphTerminalOutcome = deferredSystemAction
      ? null
      : resolveGraphTerminalOutcome(context.graphRouteResult);
    // 终态优先级（短路顺序与原嵌套三元完全一致）：deferred > systemAction失败 > graph终态 > 兜底解析。
    // await 仅在前三者全 falsy 时求值，异步边界不变。
    let resolvedOutcome;
    if (deferredSystemAction) {
      resolvedOutcome = {
        terminalOutcome: {
          status: CONTRACT_STATUS.COMPLETED,
          reason: `deferred via ${systemActionResult.actionType}`,
          source: "system_action",
        },
        terminalStatus: CONTRACT_STATUS.COMPLETED,
      };
    } else if (systemActionFailureOutcome) {
      resolvedOutcome = systemActionFailureOutcome;
    } else if (graphTerminalOutcome) {
      resolvedOutcome = graphTerminalOutcome;
    } else {
      resolvedOutcome = await resolveTerminalOutcome({
        trackingState,
        contractData: effectiveContractForOutcome,
        executionObservation: effectiveExecutionObservation,
        logger,
      });
    }
    const terminalOutcome = applyExecutionIncidentToTerminalOutcome(
      resolvedOutcome.terminalOutcome,
      executionIncident,
    );
    const terminalStatus = terminalOutcome?.status || resolvedOutcome.terminalStatus;
    const outputIoObservation = await buildOutputIoObservation({
      executionObservation: effectiveExecutionObservation,
      terminalOutcome,
    });
    if (outputIoObservation) {
      trackingState.ioObservation = mergeIoObservation(
        trackingState.ioObservation,
        outputIoObservation,
      );
    }
    const terminalExtraFields = {
      ...buildSystemActionContractFields(systemActionResult, { deferredFollowUp }),
      executionObservation: effectiveExecutionObservation || null,
      runtimeDiagnostics: mergeRuntimeDiagnostics(
        effectiveContractForOutcome?.runtimeDiagnostics || trackingState?.contract?.runtimeDiagnostics,
        trackingState.ioObservation ? { ioObservation: trackingState.ioObservation } : null,
      ),
    };

    const commitResult = await commitSemanticTerminalState({
      trackingState,
      terminalStatus,
      terminalOutcome,
      logger,
      extraFields: terminalExtraFields,
    });
    if (!commitResult.committed) {
      logger.error(`[agent-end] contract status persist failed for ${agentId}: ${commitResult.reason}`);
    }

    const loopTerminalDiagnostic = !commitResult.committed
      ? null
      : await maybeFinalizeLoopSession(context, terminalStatus, terminalOutcome);
    if (loopTerminalDiagnostic) {
      runtimeDiagnostics.loopTerminal = loopTerminalDiagnostic;
    }

    const systemActionDeliveryResult = await deliveryRunSystemActionChain({
      agentId,
      trackingState,
      contractData: effectiveContractData,
      terminalStatus,
      outcome: terminalOutcome,
      executionObservation: effectiveExecutionObservation,
      api: context.api,
      logger,
    });
    const reviewDeliveryResult = systemActionDeliveryResult.results.system_action_review_verdict || { handled: false };

    const suppressTerminalDelivery = deferredSystemAction || systemActionDeliveryResult.suppressCompletionEgress;

    if (trackingState.contract && !suppressTerminalDelivery) {
      runtimeDiagnostics.terminalDelivery = await deliveryRunTerminalRuntime({
        trackingState,
        contractData: effectiveContractData,
        terminalStatus,
        outcome: terminalOutcome,
        api: context.api,
        logger,
      });

    } else if (suppressTerminalDelivery) {
      const deferredBy = deferredSystemAction
        ? systemActionResult.actionType
        : systemActionDeliveryResult.suppressCompletionEgressBy || "unknown";
      logger.info(`[watchdog] terminal delivery deferred for ${agentId} via ${deferredBy}`);
    } else if (reviewDeliveryResult.handled) {
      logger.info(`[watchdog] request_review verdict bridged for ${agentId}`);
    }

    if (Object.keys(systemActionDeliveryResult.diagnostics).length > 0) {
      runtimeDiagnostics.systemActionDelivery = systemActionDeliveryResult.diagnostics;
    }
  }

  // Record HarnessRun for observability (Path C). Never breaks lifecycle commit.
  const contractStage = normalizeContractStageDescriptor(
    effectiveContractData?.pipelineStage || trackingState?.contract?.pipelineStage,
  );
  // Pass contractStage via context so harness recorder can read it
  context._contractStageForHarness = contractStage;
  const harnessFragment = await recordAgentEndHarnessRun(context, {
    runtimeDiagnostics,
    effectiveContractData,
    effectiveExecutionObservation,
  });
  Object.assign(runtimeDiagnostics, harnessFragment);

  if (Object.keys(runtimeDiagnostics).length > 0) {
    await mergeTrackingContractFields({
      trackingState,
      extraFields: {
        runtimeDiagnostics: mergeRuntimeDiagnostics(
          trackingState.contract?.runtimeDiagnostics,
          runtimeDiagnostics,
        ),
      },
      logger,
    });
  }

  if (trackingState?.contract?.automationContext) {
    try {
      const { handleAutomationContractTerminal } = await import("../automation/automation-executor.js");
      await handleAutomationContractTerminal(trackingState.contract, { logger });
    } catch (error) {
      logger.warn(`[watchdog] automation contract terminal hook failed: ${error.message}`);
    }
  }
}
