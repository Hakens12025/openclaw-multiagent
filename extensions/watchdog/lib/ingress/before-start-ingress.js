// lib/before-start-ingress.js — before_agent_start envelope handling

import {
  rememberRecentOperation,
} from "../state.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { dispatchAcceptIngressMessage } from "./dispatch-entry.js";
import { isInternalWakeSemanticType } from "../transport/runtime-wake-envelope.js";
import {
  PENDING_SIGNAL_KINDS,
  registerPendingSignal,
  clearPendingSignal,
} from "../runtime/pending-signal-registry.js";
import {
  executeScheduleTrigger,
  parseScheduleTriggerCommandArgs,
  SCHEDULE_TRIGGER_COMMAND,
} from "../schedule/schedule-trigger.js";
import {
  agentBlocksDirectIntake,
  getAgentIdentitySnapshot,
  resolveAgentIngressSource,
} from "../agent/agent-identity.js";
import { buildAgentMainSessionKey } from "../session-keys.js";

function isCoreWrappedHookPrompt(promptText) {
  const text = String(promptText || "");
  return /^Task:\s+Hook\s+\|/.test(text)
    && text.includes("<<<")
    && text.includes(">>>");
}

function extractRawPromptText(event) {
  if (typeof event?.prompt !== "string") return "";
  return event.prompt.trim();
}

function resolveIngressMessageText(event) {
  if (isCoreWrappedHookPrompt(event?.prompt)) return "";
  return extractRawPromptText(event);
}

function tryParseScheduleTriggerCommand(message) {
  const text = normalizeCommandText(message);
  if (!text.startsWith(`/${SCHEDULE_TRIGGER_COMMAND}`)) return null;
  const rawArgs = text.slice(SCHEDULE_TRIGGER_COMMAND.length + 1).trim();
  const scheduleId = parseScheduleTriggerCommandArgs(rawArgs);
  return scheduleId || null;
}

function normalizeCommandText(message) {
  return String(message || "").trim();
}

function isInternalWakeEvent(event) {
  const envelope = event?.wakeEnvelope;
  return Boolean(
    envelope
    && typeof envelope === "object"
    && isInternalWakeSemanticType(envelope.semanticType),
  );
}

function shouldHandleDirectIntake(identity, agentId, sessionKey, event) {
  return !identity.gateway
    && !agentBlocksDirectIntake(agentId)
    && sessionKey.includes(":hook:")
    && Boolean(event?.prompt);
}
export async function handleBeforeStartIngress({
  event,
  agentId,
  sessionKey,
  api,
  logger,
}) {
  const ingressMessage = resolveIngressMessageText(event);
  const scheduleId = tryParseScheduleTriggerCommand(ingressMessage);
  if (scheduleId) {
    logger.info(`[watchdog] schedule trigger command received: ${scheduleId} (agent=${agentId})`);
    try {
      const result = await executeScheduleTrigger(scheduleId, {
        api,
        logger,
      });
      broadcast("alert", {
        type: EVENT_TYPE.SCHEDULE_TRIGGER,
        scheduleId,
        ok: result?.ok === true,
        skipped: result?.skipped === true,
        reason: result?.reason || null,
        contractId: result?.triggerResult?.contractId || null,
        ts: Date.now(),
      });
    } catch (error) {
      logger.error(`[watchdog] schedule trigger failed (${scheduleId}): ${error.message}`);
      broadcast("alert", {
        type: EVENT_TYPE.SCHEDULE_TRIGGER,
        scheduleId,
        ok: false,
        skipped: false,
        reason: "error",
        error: error.message,
        ts: Date.now(),
      });
    }
    return;
  }

  const identity = getAgentIdentitySnapshot(agentId);

  // Controller webhooks: extract user message and create contract via ingress.
  // QQ messages are now handled by the agent-as-classifier (no hard-path interception).
  // All WebUI webhook messages go through contract ingress to
  // produce inbox_dispatch events and proper contract lifecycle.
  if (identity.gateway && identity.ingressSource === "webui" && event?.prompt && sessionKey.includes(":hook:")) {
    const message = resolveIngressMessageText(event);
    if (message.length >= 2 && !isInternalWakeEvent(event)) {
      const signalRef = `webui:${sessionKey}:${Date.now()}`;
      const clearWebuiSignal = () => clearPendingSignal({
        agentId,
        sourceKind: PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_WEBUI,
        sourceRef: signalRef,
      });
      registerPendingSignal({
        agentId,
        sourceKind: PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_WEBUI,
        sourceRef: signalRef,
      });
      if (rememberRecentOperation(`hook_contract:${sessionKey}`, 60000)) {
        logger.info(`[watchdog] HOOK HARD-PATH: extracted message: "${message.slice(0, 80)}" (hook)`);
        try {
          await dispatchAcceptIngressMessage(message, {
            source: resolveAgentIngressSource(agentId, "webui"),
            replyTo: {
              agentId,
              sessionKey: buildAgentMainSessionKey(agentId),
            },
            api,
            logger,
          });
        } catch (e) {
          logger.error(`[watchdog] hook hard-path error: ${e.message}`);
        } finally {
          clearWebuiSignal();
        }
      } else {
        clearWebuiSignal();
      }
    }
  }

  if (!shouldHandleDirectIntake(identity, agentId, sessionKey, event)) return;

  const message = resolveIngressMessageText(event);
  if (message.length < 2) return;

  if (isInternalWakeEvent(event)) {
    const semantic = event?.wakeEnvelope?.semanticType || "string-match";
    logger.info(`[intake] INTERNAL WAKE for ${agentId} [${semantic}]: "${message.slice(0, 80)}"`);
    return;
  }

  logger.warn(`[intake] blocked topology-free direct message to ${agentId}: "${message.slice(0, 80)}"`);
  broadcast("alert", {
    type: EVENT_TYPE.DIRECT_INTAKE_BLOCKED,
    agentId,
    task: message.slice(0, 100),
    reason: "topology_required",
    ts: Date.now(),
  });
}
