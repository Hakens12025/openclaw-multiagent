import { getErrorMessage } from "../core/normalize.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { deliveryRunTerminal } from "./delivery-terminal.js";
import { buildConversationId, recordRound } from "../conversations.js";
import { normalizeReplyTarget } from "../coordination-primitives.js";
import { deliverDeliveryTargets, excludeDeliveryTargets, listContractDeliveryTargets } from "./delivery-targets.js";
import { qqNotify, getQQTarget } from "../qq.js";
import { normalizeDeliveryDiagnostic } from "../lifecycle/runtime-diagnostics.js";
import { applyTerminalDeliverySemantics } from "./delivery-protocols.js";
import {
  buildRuntimeDeliveryResultSource,
  readRuntimeResultContent,
  resolveRuntimeResultOutputPath,
} from "../routing/delivery-result.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { normalizeExecutionObservation } from "../execution-observation.js";
import {
  listStageArtifactPaths,
  normalizeStageRunResult,
} from "../stage-results.js";

async function buildFallbackDeliveryDiagnostic({
  trackingState,
  contractData,
  api,
  logger,
  primaryChannel,
  primaryError,
  conversation = undefined,
}) {
  try {
    const fallback = await deliveryRunTerminal(trackingState, api, logger, contractData);
    return normalizeDeliveryDiagnostic(applyTerminalDeliverySemantics({
      ok: fallback.ok,
      channel: fallback.ok ? "delivery_fallback" : "delivery_fallback_failed",
      primaryChannel,
      primaryError,
      fallback,
      ...(conversation !== undefined ? { conversation } : {}),
    }), { lane: "completion_egress" });
  } catch (fallbackError) {
    const fallbackMessage = getErrorMessage(fallbackError);
    logger.warn(`[watchdog] completion fallback deliver error: ${fallbackMessage}`);
    return normalizeDeliveryDiagnostic(applyTerminalDeliverySemantics({
      ok: false,
      channel: "delivery_fallback_failed",
      primaryChannel,
      primaryError,
      error: fallbackMessage,
      fallback: {
        ok: false,
        channel: "delivery",
        error: fallbackMessage,
      },
      ...(conversation !== undefined ? { conversation } : {}),
    }), { lane: "completion_egress" });
  }
}

function buildSuccessMessage(trackingState, resultContent, elapsedMinutes) {
  if (resultContent) {
    return `✅ 任务完成\n\n${resultContent}\n\n⏱ 耗时: ${elapsedMinutes}分钟`;
  }
  return `✅ 任务完成\n${trackingState.contract.task.slice(0, 60)}\n工具调用: ${trackingState.toolCallTotal} 次 | 耗时: ${elapsedMinutes}分钟`;
}

async function recordConversationRoundIfNeeded(contractData, trackingState, resultContent, elapsedMinutes, resultSource = null) {
  const convId = contractData?.conversationId || buildConversationId(contractData?.replyTo);
  if (!convId) {
    return { recorded: false, skipped: true };
  }

  const runtimeResultSource = resultSource || buildRuntimeDeliveryResultSource({ trackingState, contractData });
  const stageArtifacts = listStageArtifactPaths(runtimeResultSource.stageRunResult);
  const fallbackArtifact = resolveRuntimeResultOutputPath(runtimeResultSource);

  await recordRound(convId, {
    contractId: trackingState.contract.id,
    taskSummary: trackingState.contract.task?.slice(0, 200),
    resultSummary: resultContent ? resultContent.slice(0, 400) : `任务完成 (${elapsedMinutes}分钟)`,
    artifacts: stageArtifacts.length > 0 ? stageArtifacts : (fallbackArtifact ? [fallbackArtifact] : []),
    replyTo: contractData?.replyTo,
  });
  return { recorded: true, conversationId: convId };
}

async function notifyQQMessage(target, trackingState, message) {
  const qqNotifyResult = await qqNotify(target, message);
  broadcast("alert", {
    type: EVENT_TYPE.QQ_NOTIFY,
    contractId: trackingState.contract.id,
    target,
    ok: qqNotifyResult?.ok === true,
    reason: qqNotifyResult?.reason || null,
    detail: qqNotifyResult?.detail || null,
    code: qqNotifyResult?.code || null,
    errCode: qqNotifyResult?.errCode || null,
    traceId: qqNotifyResult?.traceId || null,
    chunkCount: qqNotifyResult?.chunkCount || 1,
    ts: Date.now(),
  });
  return applyTerminalDeliverySemantics({
    ...qqNotifyResult,
    channel: "qq",
    target,
    notified: qqNotifyResult?.ok === true,
    error: qqNotifyResult?.ok === true
      ? null
      : qqNotifyResult?.detail || qqNotifyResult?.reason || "qq_notify_failed",
  });
}

function summarizeFanout(results = []) {
  return {
    total: results.length,
    ok: results.filter((item) => item?.ok === true).length,
    failed: results.filter((item) => item?.ok !== true).length,
  };
}

function resolvePrimaryReplyTarget(contractData, trackingState) {
  return normalizeReplyTarget(contractData?.replyTo || trackingState?.contract?.replyTo || null);
}

async function runConfiguredDeliveryFanout({
  contractData,
  trackingState,
  message,
  logger,
  excludedTargets = [],
}) {
  const deliveryTargets = excludeDeliveryTargets(
    listContractDeliveryTargets(contractData || trackingState?.contract || null),
    excludedTargets,
  );
  if (deliveryTargets.length === 0) return [];
  logger?.info?.(
    `[watchdog] completion fanout: ${trackingState?.contract?.id || "unknown"} -> `
    + deliveryTargets.map((entry) => `${entry.channel}:${entry.target}`).join(", "),
  );
  return deliverDeliveryTargets(deliveryTargets, message, {
    contractId: trackingState?.contract?.id || null,
    logger,
  });
}

async function handleCompletedEgress({ trackingState, contractData, api, logger }) {
  const elapsedMinutes = Math.round((Date.now() - trackingState.startMs) / 60000);
  const resultSource = buildRuntimeDeliveryResultSource({ trackingState, contractData });
  const resultContent = await readRuntimeResultContent(resultSource);
  const message = buildSuccessMessage(trackingState, resultContent, elapsedMinutes);
  let conversation = { recorded: false, skipped: true };

  try {
    conversation = await recordConversationRoundIfNeeded(
      contractData,
      trackingState,
      resultContent,
      elapsedMinutes,
      resultSource,
    );
  } catch (error) {
    conversation = { recorded: false, skipped: false, error: error.message };
  }

  const primaryReplyTarget = resolvePrimaryReplyTarget(contractData, trackingState);
  const qqTarget = getQQTarget(contractData || {});
  let primaryDelivery = null;
  try {
    if (qqTarget) {
      primaryDelivery = normalizeDeliveryDiagnostic({
        conversation,
        ...(await notifyQQMessage(qqTarget, trackingState, message)),
      }, { lane: "completion_egress.primary" });
    } else if (primaryReplyTarget?.agentId) {
      const deliveryResult = await deliveryRunTerminal(trackingState, api, logger, contractData);
      primaryDelivery = normalizeDeliveryDiagnostic({
        ...deliveryResult,
        conversation,
      }, { lane: "completion_egress.primary" });
    } else {
      primaryDelivery = normalizeDeliveryDiagnostic(applyTerminalDeliverySemantics({
        ok: false,
        channel: "none",
        stage: "skipped_no_internal_target",
        persisted: false,
        notified: false,
        skipped: true,
        conversation,
      }), { lane: "completion_egress.primary" });
    }
  } catch (error) {
    const primaryError = getErrorMessage(error);
    logger.warn(`[watchdog] completion notify/deliver error: ${primaryError}`);
    primaryDelivery = await buildFallbackDeliveryDiagnostic({
      trackingState,
      contractData,
      api,
      logger,
      primaryChannel: qqTarget ? "qq" : "delivery",
      primaryError,
      conversation,
    });
  }

  const fanout = await runConfiguredDeliveryFanout({
    contractData,
    trackingState,
    message,
    logger,
    excludedTargets: qqTarget ? [{ channel: "qqbot", target: qqTarget }] : [],
  });

  return normalizeDeliveryDiagnostic({
    ...primaryDelivery,
    ok: primaryDelivery?.ok === true || fanout.some((entry) => entry?.ok === true),
    conversation,
    fanout,
    fanoutSummary: summarizeFanout(fanout),
  }, { lane: "completion_egress" });
}

async function handleNonSuccessEgress({ trackingState, contractData, terminalStatus, outcome, api, logger }) {
  broadcast("alert", {
    type: EVENT_TYPE.CONTRACT_SEMANTIC_FAILURE,
    contractId: trackingState.contract.id,
    agentId: trackingState.agentId,
    status: terminalStatus,
    source: outcome.source || null,
    reason: outcome.reason || null,
    ts: Date.now(),
  });

  const primaryReplyTarget = resolvePrimaryReplyTarget(contractData, trackingState);
  const qqTarget = getQQTarget(contractData || {});
  let failMsg = null;
  let primaryDelivery = null;
  try {
    failMsg = terminalStatus === CONTRACT_STATUS.AWAITING_INPUT
      ? `⚠️ 任务需要补充信息\n${outcome.clarification || outcome.reason || "请补充必要输入"}`
      : `❌ 任务失败\n${outcome.reason || "未满足 contract 完成条件"}`;
    if (qqTarget) {
      primaryDelivery = normalizeDeliveryDiagnostic(
        await notifyQQMessage(qqTarget, trackingState, failMsg.slice(0, 1500)),
        { lane: "completion_egress.primary" },
      );
    } else if (primaryReplyTarget?.agentId) {
      primaryDelivery = normalizeDeliveryDiagnostic(
        await deliveryRunTerminal(trackingState, api, logger, contractData),
        { lane: "completion_egress.primary" },
      );
    } else {
      primaryDelivery = normalizeDeliveryDiagnostic(applyTerminalDeliverySemantics({
        ok: false,
        channel: "none",
        stage: "skipped_no_internal_target",
        persisted: false,
        notified: false,
        skipped: true,
      }), { lane: "completion_egress.primary" });
    }
  } catch (error) {
    const primaryError = getErrorMessage(error);
    logger.warn(`[watchdog] failure notify/deliver error: ${primaryError}`);
    primaryDelivery = await buildFallbackDeliveryDiagnostic({
      trackingState,
      contractData,
      api,
      logger,
      primaryChannel: qqTarget ? "qq" : "delivery",
      primaryError,
    });
  }

  const fanout = await runConfiguredDeliveryFanout({
    contractData,
    trackingState,
    message: (failMsg || "").slice(0, 1500),
    logger,
    excludedTargets: qqTarget ? [{ channel: "qqbot", target: qqTarget }] : [],
  });

  return normalizeDeliveryDiagnostic({
    ...primaryDelivery,
    ok: primaryDelivery?.ok === true || fanout.some((entry) => entry?.ok === true),
    fanout,
    fanoutSummary: summarizeFanout(fanout),
  }, { lane: "completion_egress" });
}

export async function deliveryRunTerminalRuntime({
  trackingState,
  contractData,
  terminalStatus,
  outcome,
  api,
  logger,
}) {
  if (!trackingState?.contract) {
    return normalizeDeliveryDiagnostic(
      { ok: false, channel: "none", error: "missing contract" },
      { lane: "completion_egress" },
    );
  }

  if (terminalStatus === CONTRACT_STATUS.COMPLETED) {
    return handleCompletedEgress({ trackingState, contractData, api, logger });
  }

  return handleNonSuccessEgress({
    trackingState,
    contractData,
    terminalStatus,
    outcome,
    api,
    logger,
  });
}
