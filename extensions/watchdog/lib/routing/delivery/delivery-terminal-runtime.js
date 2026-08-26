import { getErrorMessage } from "../../core/normalize.js";
import { broadcast } from "../../transport/sse.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import { deliveryRunTerminal } from "./delivery-terminal.js";
import { normalizeReplyTarget } from "../coordination-primitives.js";
import { deliverDeliveryTargets, excludeDeliveryTargets, listContractDeliveryTargets } from "./delivery-targets.js";
import { qqNotify, getQQTarget, getQQTargetAddress } from "../../transport/channel-notify.js";
import { normalizeDeliveryDiagnostic } from "../runtime-diagnostics.js";
import { applyTerminalDeliverySemantics } from "./delivery-protocols.js";
import {
  buildRuntimeDeliveryResultSource,
  buildUserFacingFailureText,
  isInternalDeliveryReason,
  resolveContractStageLabel,
  resolveTerminalUserFacingResultContent,
} from "./delivery-result.js";
import { CONTRACT_STATUS } from "../../core/runtime-status.js";

async function buildFallbackDeliveryDiagnostic({
  trackingState,
  contractData,
  api,
  logger,
  primaryChannel,
  primaryError,
}) {
  try {
    const fallback = await deliveryRunTerminal(trackingState, api, logger, contractData);
    return normalizeDeliveryDiagnostic(applyTerminalDeliverySemantics({
      ok: fallback.ok,
      channel: fallback.ok ? "delivery_fallback" : "delivery_fallback_failed",
      primaryChannel,
      primaryError,
      fallback,
    }), { lane: "terminal_delivery" });
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
    }), { lane: "terminal_delivery" });
  }
}

function buildSuccessMessage(trackingState, resultContent, elapsedMinutes) {
  if (resultContent) {
    return `✅ 任务完成\n\n${resultContent}\n\n⏱ 耗时: ${elapsedMinutes}分钟`;
  }
  return "✅ 任务完成";
}

function buildNonSuccessMessage(terminalStatus, outcome, stage = null) {
  if (false) { // AWAITING_INPUT 已删除(2026-08-10)
    const clarification = outcome?.clarification || outcome?.reason || "";
    const safeClarification = clarification && !isInternalDeliveryReason(clarification)
      ? clarification
      : "请补充必要输入。";
    return `⚠️ 任务需要补充信息\n${safeClarification}`;
  }
  return buildUserFacingFailureText({
    summary: outcome?.summary,
    reason: outcome?.reason,
    stage,
  });
}

async function notifyQQMessage(target, trackingState, message) {
  const targetAddress = getQQTargetAddress(target);
  const qqNotifyResult = await qqNotify(target, message);
  broadcast("alert", {
    type: EVENT_TYPE.QQ_NOTIFY,
    contractId: trackingState.contract.id,
    target: targetAddress,
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
    target: targetAddress,
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

async function handleCompletedTerminalDelivery({ trackingState, contractData, api, logger }) {
  const elapsedMinutes = Math.round((Date.now() - trackingState.startMs) / 60000);
  const resultSource = buildRuntimeDeliveryResultSource({ trackingState, contractData });
  const resultContent = await resolveTerminalUserFacingResultContent(resultSource);
  const message = buildSuccessMessage(trackingState, resultContent, elapsedMinutes);

  const primaryReplyTarget = resolvePrimaryReplyTarget(contractData, trackingState);
  const qqTarget = getQQTarget(contractData || {});
  let primaryDelivery = null;
  try {
    if (qqTarget) {
      primaryDelivery = normalizeDeliveryDiagnostic(
        await notifyQQMessage(qqTarget, trackingState, message),
        { lane: "terminal_delivery.primary" },
      );
    } else if (primaryReplyTarget?.agentId) {
      const deliveryResult = await deliveryRunTerminal(trackingState, api, logger, contractData);
      primaryDelivery = normalizeDeliveryDiagnostic(deliveryResult, { lane: "terminal_delivery.primary" });
    } else {
      primaryDelivery = normalizeDeliveryDiagnostic(applyTerminalDeliverySemantics({
        ok: false,
        channel: "none",
        stage: "skipped_no_internal_target",
        persisted: false,
        notified: false,
        skipped: true,
      }), { lane: "terminal_delivery.primary" });
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
    });
  }

  const fanout = await runConfiguredDeliveryFanout({
    contractData,
    trackingState,
    message,
    logger,
    excludedTargets: qqTarget ? [{ channel: "qqbot", target: getQQTargetAddress(qqTarget) }] : [],
  });

  return normalizeDeliveryDiagnostic({
    ...primaryDelivery,
    ok: primaryDelivery?.ok === true || fanout.some((entry) => entry?.ok === true),
    fanout,
    fanoutSummary: summarizeFanout(fanout),
  }, { lane: "terminal_delivery" });
}

async function handleNonSuccessTerminalDelivery({ trackingState, contractData, terminalStatus, outcome, api, logger }) {
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
    failMsg = buildNonSuccessMessage(
      terminalStatus,
      outcome,
      resolveContractStageLabel(contractData || trackingState?.contract),
    );
    if (qqTarget) {
      primaryDelivery = normalizeDeliveryDiagnostic(
        await notifyQQMessage(qqTarget, trackingState, failMsg.slice(0, 1500)),
        { lane: "terminal_delivery.primary" },
      );
    } else if (primaryReplyTarget?.agentId) {
      primaryDelivery = normalizeDeliveryDiagnostic(
        await deliveryRunTerminal(trackingState, api, logger, contractData),
        { lane: "terminal_delivery.primary" },
      );
    } else {
      primaryDelivery = normalizeDeliveryDiagnostic(applyTerminalDeliverySemantics({
        ok: false,
        channel: "none",
        stage: "skipped_no_internal_target",
        persisted: false,
        notified: false,
        skipped: true,
      }), { lane: "terminal_delivery.primary" });
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
    excludedTargets: qqTarget ? [{ channel: "qqbot", target: getQQTargetAddress(qqTarget) }] : [],
  });

  return normalizeDeliveryDiagnostic({
    ...primaryDelivery,
    ok: primaryDelivery?.ok === true || fanout.some((entry) => entry?.ok === true),
    fanout,
    fanoutSummary: summarizeFanout(fanout),
  }, { lane: "terminal_delivery" });
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
      { lane: "terminal_delivery" },
    );
  }

  if (terminalStatus === CONTRACT_STATUS.COMPLETED) {
    return handleCompletedTerminalDelivery({ trackingState, contractData, api, logger });
  }

  return handleNonSuccessTerminalDelivery({
    trackingState,
    contractData,
    terminalStatus,
    outcome,
    api,
    logger,
  });
}
