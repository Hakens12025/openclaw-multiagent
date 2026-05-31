import { recordHarnessRun } from "../harness/harness-run-store.js";
import { listStageArtifactPaths } from "../stage-results.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { isSessionHardStopped } from "../loop/loop-detection.js";
import { resolveLoopEpochKey } from "../loop/loop-epoch-key.js";
import { resolveAgentEndHarnessAutomationId } from "./agent-end-harness-automation-id.js";

/**
 * Record a HarnessRun for observability at agent_end terminal path (Path C).
 * Returns the runtimeDiagnostics fragment to merge into the contract.
 * Never throws — failures are logged as warnings.
 */
export async function recordAgentEndHarnessRun(context, {
  runtimeDiagnostics,
  effectiveContractData,
  effectiveExecutionObservation,
}) {
  const {
    agentId,
    logger,
    trackingState,
  } = context;

  // H3: Path A dedup — skip if automation lifecycle already recorded a rich HarnessRun
  const pathARunId = trackingState?.contract?.automationContext?.harnessRunId;
  if (pathARunId) {
    logger.info(`[watchdog] harness run already recorded via Path A: ${pathARunId}, skipping Path C`);
    return { harnessRunId: pathARunId };
  }

  try {
    const contractStage = context._contractStageForHarness || null;
    const contractId = trackingState?.contract?.id || effectiveContractData?.id || null;
    const toolCallCount = effectiveContractData?.toolCallCount
      || trackingState?.contract?.toolCallCount
      || 0;
    const stageRunResult = effectiveExecutionObservation?.stageRunResult || null;
    const artifactPaths = listStageArtifactPaths(stageRunResult);
    const terminalStatus = trackingState?.contract?.status || null;

    // H1: loop detection diagnostics
    const loopDetected = isSessionHardStopped(resolveLoopEpochKey(trackingState) || context.sessionKey);
    const warnings = runtimeDiagnostics.executionTrace?.offTrack ? ["execution_trace_off_track"] : [];
    if (loopDetected) warnings.push("loop_detected");

    const automationId = resolveAgentEndHarnessAutomationId({ agentId, contractStage });

    const harnessRun = await recordHarnessRun({
      automationId,
      round: contractStage?.round || 1,
      trigger: "agent_end_terminal",
      enabled: true,
      executionMode: "freeform",
      assuranceLevel: "low_assurance",
      agentId,
      contractId,
      pipelineId: contractStage?.pipelineId || null,
      loopId: contractStage?.loopId || null,
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
    logger.info(`[watchdog] harness run recorded: ${harnessRun.id} for ${agentId} (contract: ${contractId})`);
    return { harnessRunId: harnessRun.id };
  } catch (harnessError) {
    const harnessMsg = harnessError instanceof Error ? harnessError.message : String(harnessError || "unknown");
    logger.warn(`[watchdog] harness run recording failed for ${agentId}: ${harnessMsg}`);
    return {};
  }
}
