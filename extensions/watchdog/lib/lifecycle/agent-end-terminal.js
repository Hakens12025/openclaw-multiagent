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
import { listStageArtifactPaths } from "../stage-results.js";
import { materializeExecutionObservation } from "../execution-observation.js";
import { recordHarnessRun } from "../harness/harness-run-store.js";
import { mergeRuntimeDiagnostics } from "./agent-end-contract-refresh.js";
import {
  maybeFinalizeLoopSession,
  normalizePipelineStageDescriptor,
} from "./agent-end-stage-advance.js";
import { isSessionHardStopped } from "../loop/loop-detection.js";

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
    event,
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
  const effectiveExecutionObservation = materializeExecutionObservation(executionObservation, {
    contractId: effectiveContractForOutcome?.id || trackingState?.contract?.id || null,
    fallbackPrimaryOutputPath: effectiveContractForOutcome?.output || trackingState?.contract?.output || null,
  });
  context.executionObservation = effectiveExecutionObservation;

  const traceVerdict = evaluateTrace(context.sessionKey);
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
    const resolvedOutcome = deferredSystemAction
      ? {
          terminalOutcome: {
            status: CONTRACT_STATUS.COMPLETED,
            reason: `deferred via ${systemActionResult.actionType}`,
            source: "system_action",
          },
          terminalStatus: CONTRACT_STATUS.COMPLETED,
        }
      : systemActionFailureOutcome
        ? systemActionFailureOutcome
        : graphTerminalOutcome
          ? graphTerminalOutcome
        : await resolveTerminalOutcome({
            trackingState,
            contractData: effectiveContractForOutcome,
            executionObservation: effectiveExecutionObservation,
            logger,
          });
    const { terminalOutcome, terminalStatus } = resolvedOutcome;
    const terminalExtraFields = {
      ...buildSystemActionContractFields(systemActionResult, { deferredFollowUp }),
      executionObservation: effectiveExecutionObservation || null,
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

    const suppressCompletionEgress = deferredSystemAction || systemActionDeliveryResult.suppressCompletionEgress;

    if (trackingState.contract && !suppressCompletionEgress) {
      runtimeDiagnostics.completionEgress = await deliveryRunTerminalRuntime({
        trackingState,
        contractData: effectiveContractData,
        terminalStatus,
        outcome: terminalOutcome,
        api: context.api,
        logger,
      });

    } else if (suppressCompletionEgress) {
      const deferredBy = deferredSystemAction
        ? systemActionResult.actionType
        : systemActionDeliveryResult.suppressCompletionEgressBy || "unknown";
      logger.info(`[watchdog] completion egress deferred for ${agentId} via ${deferredBy}`);
    } else if (reviewDeliveryResult.handled) {
      logger.info(`[watchdog] request_review verdict bridged for ${agentId}`);
    }

    if (Object.keys(systemActionDeliveryResult.diagnostics).length > 0) {
      runtimeDiagnostics.systemActionDelivery = systemActionDeliveryResult.diagnostics;
    }
  }

  // Record HarnessRun for observability (non-blocking — must never break the pipeline)
  try {
    // H3: Path A dedup — skip if automation lifecycle already recorded a rich HarnessRun
    const pathARunId = trackingState?.contract?.automationContext?.harnessRunId;
    if (pathARunId) {
      runtimeDiagnostics.harnessRunId = pathARunId;
      logger.info(`[watchdog] harness run already recorded via Path A: ${pathARunId}, skipping Path C`);
    } else {
      const pipelineStage = normalizePipelineStageDescriptor(
        effectiveContractData?.pipelineStage || trackingState?.contract?.pipelineStage,
      );
      const contractId = trackingState?.contract?.id || effectiveContractData?.id || null;
      const toolCallCount = effectiveContractData?.toolCallCount
        || trackingState?.contract?.toolCallCount
        || 0;
      const stageRunResult = effectiveExecutionObservation?.stageRunResult || null;
      const artifactPaths = listStageArtifactPaths(stageRunResult);
      const terminalStatus = trackingState?.contract?.status || null;
      const harnessScopeId = pipelineStage?.loopSessionId
        ? `loop_session:${pipelineStage.loopSessionId}`
        : pipelineStage?.pipelineId
          ? `pipeline:${pipelineStage.pipelineId}`
          : undefined;

      // H1: loop detection diagnostics
      const loopDetected = isSessionHardStopped(context.sessionKey);
      const warnings = runtimeDiagnostics.executionTrace?.offTrack ? ["execution_trace_off_track"] : [];
      if (loopDetected) warnings.push("loop_detected");

      const automationId = harnessScopeId || `agent_end:${agentId}`;

      const harnessRun = await recordHarnessRun({
        automationId,
        round: pipelineStage?.round || 1,
        trigger: "agent_end_terminal",
        enabled: true,
        executionMode: "freeform",
        assuranceLevel: "low_assurance",
        agentId,
        contractId,
        pipelineId: pipelineStage?.pipelineId || null,
        loopId: pipelineStage?.loopId || null,
        sessionKey: context.sessionKey,
        status: terminalStatus === CONTRACT_STATUS.COMPLETED ? "completed" : "failed",
        terminalStatus,
        completionReason: loopDetected ? "loop_detected" : undefined,
        summary: loopDetected ? "session terminated due to repeated tool calls" : (stageRunResult?.summary || ""),
        executor: {
          kind: "agent",
          agentId,
        },
        toolUsage: { totalCalls: toolCallCount },
        artifacts: artifactPaths.map((p) => ({ kind: "stage_artifact", path: p })),
        diagnostics: {
          traceId: context.sessionKey,
          warnings,
          error: runtimeDiagnostics.contractRead?.error || null,
        },
        outcome: {
          result: terminalStatus,
          retryable: false,
          summary: stageRunResult?.summary || "",
        },
      });
      runtimeDiagnostics.harnessRunId = harnessRun.id;
      logger.info(`[watchdog] harness run recorded: ${harnessRun.id} for ${agentId} (contract: ${contractId})`);
    }
  } catch (harnessError) {
    const harnessMsg = harnessError instanceof Error ? harnessError.message : String(harnessError || "unknown");
    logger.warn(`[watchdog] harness run recording failed for ${agentId}: ${harnessMsg}`);
  }

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
