// lib/routing/delivery/delivery-terminal.js — Terminal result delivery to gateway agents

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  agentWorkspace,
  atomicWriteFile,
  isPathWithin,
} from "../../state.js";
import { CONTROL_PLANE_PATHS } from "../../control-plane/control-plane-paths.js";
import { getDeliveryDir, readContractSnapshotByPath } from "../../contract/contracts.js";
import { broadcast } from "../../transport/sse.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import { CONTRACT_STATUS } from "../../core/runtime-status.js";
import {
  buildRuntimeDeliveryResultSource,
  buildUserFacingFailureText,
  isInternalDeliveryReason,
  resolveContractStageLabel,
  resolveTerminalUserFacingResultContent,
  resolveRuntimeResultOutputPath,
} from "./delivery-result.js";
import { normalizeExecutionObservation } from "../../stage/execution-observation.js";
import { normalizeTerminalOutcome } from "../../contract/terminal-outcome.js";
import {
  RUNTIME_WAKE_SEMANTICS,
  runtimeWakeAgentDetailed,
} from "../../transport/runtime-wake-transport.js";
import { isGatewayAgent } from "../../agent/agent-identity.js";
import { buildAgentContractSessionKey } from "../../session/session-keys.js";
import { applyTerminalDeliverySemantics } from "./delivery-protocols.js";

function isResumeSessionDirectServiceContract(contract) {
  return contract?.serviceSession?.mode === "direct_service"
    && contract?.serviceSession?.returnPolicy === "resume_session";
}

function resolveAllowedOutputDirs(contract) {
  const dirs = [CONTROL_PLANE_PATHS.outputDir];
  const assignee = typeof contract?.assignee === "string" && contract.assignee.trim()
    ? contract.assignee.trim()
    : null;
  if (assignee) {
    dirs.push(join(agentWorkspace(assignee), "output"));
  }
  return dirs;
}

function buildNonSuccessResultSummary(resultStatus, trackingState, terminalOutcome, stage = null) {
  if (false) { // AWAITING_INPUT 已删除(2026-08-10)
    const clarification = terminalOutcome?.clarification || terminalOutcome?.reason || trackingState?.lastLabel || "";
    const safeClarification = clarification && !isInternalDeliveryReason(clarification)
      ? clarification
      : "请补充必要输入。";
    return `⚠️ 需要补充信息\n${safeClarification}`;
  }
  // lastLabel 刻意不参与失败文案：它是最后一条运行期进度标签，而非为收件人书写的解释。
  return buildUserFacingFailureText({
    summary: terminalOutcome?.summary,
    reason: terminalOutcome?.reason,
    stage,
  });
}

async function resolveReplyTarget(trackingState, contractDataOverride, logger) {
  if (
    contractDataOverride
    && Object.prototype.hasOwnProperty.call(contractDataOverride, "replyTo")
  ) {
    return contractDataOverride.replyTo || null;
  }

  if (
    trackingState?.contract
    && Object.prototype.hasOwnProperty.call(trackingState.contract, "replyTo")
  ) {
    return trackingState.contract.replyTo || null;
  }

  const contractPath = trackingState?.contract?.path;
  if (!contractPath) return null;

  try {
    const contractData = await readContractSnapshotByPath(contractPath, { preferCache: true });
    if (!contractData) {
      throw new Error("contract snapshot missing");
    }
    return contractData.replyTo || null;
  } catch (e) {
    logger.warn(`[watchdog] deliveryRunTerminal: failed to read contract for replyTo: ${e.message}`);
    return null;
  }
}

export async function deliveryRunTerminal(trackingState, api, logger, contractDataOverride = null) {
  const c = trackingState.contract;
  if (!c) {
    return applyTerminalDeliverySemantics({
      ok: false,
      channel: "none",
      stage: "preflight",
      error: "missing_contract",
    });
  }
  const resultStatus = trackingState.status || CONTRACT_STATUS.COMPLETED;

  const replyTo = await resolveReplyTarget(trackingState, contractDataOverride, logger);

  if (!replyTo || !replyTo.agentId) {
    if (isResumeSessionDirectServiceContract(contractDataOverride || trackingState?.contract)) {
      logger.info(`[watchdog] deliveryRunTerminal: no replyTo for resume_session direct_service contract ${c.id}, skipping delivery as in-band completion`);
      broadcast("alert", {
        type: EVENT_TYPE.DELIVERY_SKIPPED,
        contractId: c.id,
        stage: "resolve_reply_target",
        reason: "in_band_direct_service_completion",
        ts: Date.now(),
      });
      return applyTerminalDeliverySemantics({
        ok: true,
        channel: "in_band_direct_service",
        stage: "resolve_reply_target",
        deliveryId: null,
        persisted: false,
        notified: true,
        skipped: true,
      });
    }

    logger.info(`[watchdog] deliveryRunTerminal: no replyTo in contract, skipping delivery`);
    broadcast("alert", {
      type: EVENT_TYPE.DELIVERY_SKIPPED,
      contractId: c.id,
      stage: "resolve_reply_target",
      reason: "missing_reply_target",
      ts: Date.now(),
    });
    return applyTerminalDeliverySemantics({
      ok: false,
      channel: "delivery",
      stage: "resolve_reply_target",
      error: "missing_reply_target",
      persisted: false,
      notified: false,
    });
  }

  const isNonSuccess = resultStatus !== CONTRACT_STATUS.COMPLETED;
  const runtimeResultSource = buildRuntimeDeliveryResultSource({
    trackingState,
    contractData: contractDataOverride || c,
  });
  const executionObservation = normalizeExecutionObservation(
    runtimeResultSource.executionObservation,
  );
  const terminalOutcome = normalizeTerminalOutcome(
    runtimeResultSource.terminalOutcome,
    { terminalStatus: resultStatus },
  );
  const userFacingResult = await resolveTerminalUserFacingResultContent(runtimeResultSource);
  let resultSummary = isNonSuccess
    ? buildNonSuccessResultSummary(
      resultStatus,
      trackingState,
      terminalOutcome,
      resolveContractStageLabel(contractDataOverride || c),
    )
    : userFacingResult || "(任务完成)";
  const outputPath = resolveRuntimeResultOutputPath(runtimeResultSource);
  const fallbackSummary = userFacingResult || await resolveTerminalUserFacingResultContent({
    ...runtimeResultSource,
    terminalOutcome,
  });
  if (fallbackSummary && !isNonSuccess) {
    resultSummary = fallbackSummary;
  }
  let safeOutputPath = outputPath || c.output || "";
  if (outputPath) {
    const allowedOutputDirs = resolveAllowedOutputDirs(c);

    if (!allowedOutputDirs.some((dir) => isPathWithin(outputPath, dir))) {
      logger.warn(
        `[watchdog] deliveryRunTerminal: PATH TRAVERSAL BLOCKED — output path "${outputPath}" `
        + `is outside ${allowedOutputDirs.join(", ")}`,
      );
      safeOutputPath = "";
    }
  }

  const deliveryId = `DL-${c.id}`;

  if (replyTo.kind === "test_run" && replyTo.runId) {
    logger.info(`[watchdog] TEST DELIVERY: ${deliveryId} → ${replyTo.runId}`);
    broadcast("alert", { type: EVENT_TYPE.TEST_DELIVERY_RECORDED, runId: replyTo.runId, contractId: c.id, deliveryId, agentId: replyTo.agentId || "test-run", ts: Date.now() });
    broadcast("alert", { type: EVENT_TYPE.TEST_SINK_NOTIFIED, runId: replyTo.runId, contractId: c.id, deliveryId, agentId: replyTo.agentId || "test-run", ts: Date.now() });
    return applyTerminalDeliverySemantics({
      ok: true,
      channel: "test_run",
      stage: "sink",
      deliveryId,
      persisted: false,
      notified: true,
      replyToAgentId: replyTo.agentId || "test-run",
    });
  }

  const deliveryDir = getDeliveryDir(replyTo.agentId);
  const delivery = {
    id: deliveryId,
    contractId: c.id,
    task: c.task,
    status: "pending",
    resultStatus,
    resultSummary,
    outputPath: safeOutputPath,
    replyTo,
    toolCallCount: trackingState.toolCallTotal,
    elapsedMs: Date.now() - trackingState.startMs,
    createdAt: Date.now(),
  };

  try {
    await mkdir(deliveryDir, { recursive: true });
    const deliveryPath = join(deliveryDir, `${deliveryId}.json`);
    await atomicWriteFile(deliveryPath, JSON.stringify(delivery, null, 2));
    logger.info(`[watchdog] DELIVERY CREATED: ${deliveryId} → ${replyTo.agentId}`);
    broadcast("alert", { type: EVENT_TYPE.DELIVERY_CREATED, contractId: c.id, deliveryId, agentId: replyTo.agentId, ts: Date.now() });
  } catch (e) {
    logger.error(`[watchdog] deliveryRunTerminal: write delivery failed: ${e.message}`);
    broadcast("alert", {
      type: EVENT_TYPE.DELIVERY_WRITE_FAILED,
      contractId: c.id,
      deliveryId,
      agentId: replyTo.agentId,
      error: e.message,
      ts: Date.now(),
    });
    return applyTerminalDeliverySemantics({
      ok: false,
      channel: "delivery",
      stage: "write",
      deliveryId,
      error: e.message,
      persisted: false,
      notified: false,
      replyToAgentId: replyTo.agentId,
    });
  }

  try {
    // Gateway agents (controller, qqbot) get results via SSE/QQ — no wake needed.
    // Non-gateway agents need wake to consume delivery for their workflow.
    const skipWake = isGatewayAgent(replyTo.agentId);
    if (!skipWake) {
      await runtimeWakeAgentDetailed(replyTo.agentId, null, api, logger, {
        sessionKey: buildAgentContractSessionKey(replyTo.agentId, c.id),
        wakeSemantic: RUNTIME_WAKE_SEMANTICS.TERMINAL_DELIVERY_READY,
        contractId: c.id,
        deliveryId,
      });
      logger.info(`[watchdog] DELIVERY HEARTBEAT: ${replyTo.agentId}`);
    } else {
      logger.info(`[watchdog] DELIVERY READY: ${deliveryId} → ${replyTo.agentId} (SSE only, gateway agent)`);
    }
    broadcast("alert", { type: EVENT_TYPE.DELIVERY_NOTIFIED, contractId: c.id, deliveryId, agentId: replyTo.agentId, ts: Date.now() });
    return applyTerminalDeliverySemantics({
      ok: true,
      channel: "delivery",
      stage: "notify",
      deliveryId,
      persisted: true,
      notified: true,
      replyToAgentId: replyTo.agentId,
    });
  } catch (e) {
    logger.error(`[watchdog] deliveryRunTerminal: heartbeat failed: ${e.message}`);
    broadcast("alert", {
      type: EVENT_TYPE.DELIVERY_NOTIFY_FAILED,
      contractId: c.id,
      deliveryId,
      agentId: replyTo.agentId,
      error: e.message,
      ts: Date.now(),
    });
    return applyTerminalDeliverySemantics({
      ok: false,
      partial: true,
      channel: "delivery",
      stage: "notify",
      deliveryId,
      error: e.message,
      persisted: true,
      notified: false,
      replyToAgentId: replyTo.agentId,
    });
  }
}
