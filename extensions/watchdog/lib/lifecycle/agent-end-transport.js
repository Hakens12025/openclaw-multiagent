import { join } from "node:path";
import { collectOutbox } from "../../runtime-mailbox.js";
import { cleanInbox, getMailboxWorkspace } from "../routing/runtime-mailbox-transport.js";
import { snapshotInboxToTrace, snapshotOutputToTrace } from "./workflow-trace-snapshot.js";
import {
  shouldPreserveMailboxInbox,
} from "../routing/runtime-mailbox-handler-registry.js";
import { materializeExecutionObservation } from "../execution-observation.js";
import {
  isDirectRequestEnvelope,
  resolveDirectRequestEnvelopeSessionKey,
} from "../protocol-primitives.js";
import {
  RUNTIME_WAKE_SEMANTICS,
  runtimeWakeAgentDetailed,
} from "../transport/runtime-wake-transport.js";

export async function handleAgentEndTransport({
  agentId,
  api,
  logger,
  enqueueContract,
  event = null,
  trackingState = null,
}) {
  const collectedTransport = await collectOutbox(agentId, logger);
  void event;
  void trackingState;
  const executionObservation = materializeExecutionObservation(collectedTransport);
  if (executionObservation.collected) {
    logger.info(`[watchdog] collectOutbox(${agentId}): success`);

    // DRAFT lifecycle eliminated — dispatch-graph-policy handles all forwarding.
  }

  return {
    executionObservation,
    preserveInbox: shouldPreserveMailboxInbox(agentId, executionObservation),
  };
}

export async function cleanupAgentEndTransport({
  agentId,
  api = null,
  logger,
  preserveInbox = false,
  trackingState = null,
  executionObservation = null,
}) {
  // 产出件快照到 workflow-trace（旁路补充，绝不破坏清理）。与 inbox 快照同邻域，
  // 但独立于 inbox 保留分支：无论 preserveInbox 与否都尝试快照，让 delivery
  // 在 live 产出件被清后能回退读到最终件。整段 try/catch 吞错，不冒泡。
  try {
    const contractId = trackingState?.contract?.id || null;
    const outputPath = executionObservation?.primaryOutputPath || trackingState?.contract?.output || null;
    if (contractId && outputPath) {
      await snapshotOutputToTrace({ contractId, outputPath });
    }
  } catch (outputSnapshotError) {
    logger?.warn?.(`[watchdog] snapshotOutputToTrace(${agentId}) skipped: ${outputSnapshotError?.message || outputSnapshotError}`);
  }
  // 注：产物独立保存（saveAgentArtifact）已前移到 AGENT_END_MAIN_STAGES 的
  // preserve_artifact 阶段（graph_route 之前），确保下一环派发时上游 artifact 已就绪、
  // wake 能嵌入上游产物。此处不再重复调用。

  if (preserveInbox) {
    return {
      cleaned: false,
      preserved: true,
      preserveReason: "explicit_preserve",
      promotedDirectEnvelope: null,
      wake: null,
    };
  }

  // 清理前快照 inbox 过滤副本到 workflow-trace（旁路补充，绝不破坏清理）。
  // 整段 try/catch 吞错：快照失败不得影响后续 unlink。
  try {
    const contractId = trackingState?.contract?.id || null;
    const workspace = getMailboxWorkspace(agentId);
    if (contractId && workspace) {
      await snapshotInboxToTrace({
        contractId,
        agentId,
        inboxDir: join(workspace, "inbox"),
      });
    }
  } catch (snapshotError) {
    logger?.warn?.(`[watchdog] snapshotInboxToTrace(${agentId}) skipped: ${snapshotError?.message || snapshotError}`);
  }

  const cleanupResult = await cleanInbox(agentId, logger, {
    ownerContractId: trackingState?.contract?.id || null,
  });
  if (cleanupResult?.preserved === true) {
    return {
      cleaned: false,
      preserved: true,
      preserveReason: cleanupResult.preserveReason || "preserved",
      promotedDirectEnvelope: null,
      wake: null,
    };
  }
  const promotedDirectEnvelope = cleanupResult?.promotedDirectEnvelope || null;
  let wake = null;

  if (
    api
    && promotedDirectEnvelope
    && isDirectRequestEnvelope(promotedDirectEnvelope)
  ) {
    const targetSessionKey = resolveDirectRequestEnvelopeSessionKey(promotedDirectEnvelope);
    wake = await runtimeWakeAgentDetailed(
      agentId,
      null,
      api,
      logger,
      {
        ...(targetSessionKey ? { sessionKey: targetSessionKey } : {}),
        wakeSemantic: RUNTIME_WAKE_SEMANTICS.DIRECT_REQUEST_RESUME,
        envelopeId: promotedDirectEnvelope.id,
      },
    );
  }

  return {
    cleaned: cleanupResult?.cleaned === true,
    preserved: false,
    preserveReason: null,
    promotedDirectEnvelope,
    wake,
  };
}
