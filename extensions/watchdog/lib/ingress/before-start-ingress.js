// lib/before-start-ingress.js — before_agent_start envelope handling

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  rememberRecentOperation, agentWorkspace,
} from "../state.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { cacheContractSnapshot } from "../store/contract-store.js";
import { dispatchAcceptIngressMessage } from "./dispatch-entry.js";
import { createDirectRequestEnvelope } from "../protocol-primitives.js";
import { ensureRuntimeDirectEnvelopeInbox } from "../runtime-direct-envelope-queue.js";
import { buildDirectServiceSession } from "../service-session.js";
import {
  executeScheduleTrigger,
  parseScheduleTriggerCommandArgs,
  SCHEDULE_TRIGGER_COMMAND,
} from "../schedule/schedule-trigger.js";
import {
  AGENT_ROLE,
  getAgentIdentitySnapshot,
  hasExecutionPolicy,
  resolveAgentIngressSource,
} from "../agent/agent-identity.js";
import { buildAgentMainSessionKey } from "../session-keys.js";

function extractExternalMessage(promptText) {
  const text = String(promptText);
  // WebUI webhook format: <<<EXTERNAL_UNTRUSTED_CONTENT>>>...<<<END_EXTERNAL_UNTRUSTED_CONTENT
  const extMatch = text.match(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>\s*(?:Source:\s*\w+\s*---\s*)?([\s\S]*?)<<<END_EXTERNAL_UNTRUSTED_CONTENT/);
  if (extMatch) return extMatch[1].trim();
  // QQ qqbot format: metadata blocks followed by the actual message at the end
  const qqMatch = text.match(/^Conversation info \(untrusted metadata\):[\s\S]*?```\s*\n([\s\S]+)$/);
  if (qqMatch) {
    // Strip any remaining metadata blocks, the user message is the last non-block part
    const afterMeta = qqMatch[1].replace(/^Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/m, "").trim();
    if (afterMeta) return afterMeta;
  }
  return "";
}

function extractRawPromptText(event) {
  if (typeof event?.prompt !== "string") return "";
  return event.prompt.trim();
}

function resolveIngressMessageText(event) {
  const extracted = extractExternalMessage(event?.prompt);
  if (extracted) return extracted;
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

function isInternalWakeMessage(message) {
  const text = String(message).trim();
  return [
    /^执行合约\s+TC-[A-Za-z0-9-]+/i,
    /^规划合约\s+TC-[A-Za-z0-9-]+/i,
    /^研究循环唤醒/i,
    /^唤醒[:：]/i,
    /^queue dispatch\b/i,
    /^dispatch retry\b/i,
    /^resume after:/i,
    /^system_action wakeup\b/i,
    /^delivery ready:\s*DL-/i,
    /^inactivity\b/i,
  ].some((pattern) => pattern.test(text));
}

function shouldHandleDirectIntake(identity, agentId, sessionKey, event) {
  return !identity.gateway
    && identity.role !== AGENT_ROLE.RESEARCHER
    && !hasExecutionPolicy(agentId, "noDirectIntake")
    && sessionKey.includes(":hook:")
    && Boolean(event?.prompt);
}

async function hasActiveDirectInboxEnvelope(inboxDir, {
  agentId,
  logger,
}) {
  const readyState = await ensureRuntimeDirectEnvelopeInbox({ inboxDir, agentId, logger });
  return readyState?.active === true;
}

export async function handleBeforeStartIngress({
  event,
  agentId,
  sessionKey,
  api,
  enqueue,
  wakePlanner,
  logger,
}) {
  const ingressMessage = resolveIngressMessageText(event);
  const scheduleId = tryParseScheduleTriggerCommand(ingressMessage);
  if (scheduleId) {
    logger.info(`[watchdog] schedule trigger command received: ${scheduleId} (agent=${agentId})`);
    try {
      const result = await executeScheduleTrigger(scheduleId, {
        api,
        enqueue,
        wakePlanner,
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
  // All WebUI webhook messages (simple + complex) go through hard-path ingress to
  // produce inbox_dispatch events and proper contract lifecycle.
  if (identity.gateway && identity.ingressSource === "webui" && event?.prompt && sessionKey.includes(":hook:")) {
    const message = resolveIngressMessageText(event);
    if (message.length >= 2 && !isInternalWakeMessage(message)) {
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
            enqueue,
            wakePlanner,
            logger,
          });
        } catch (e) {
          logger.error(`[watchdog] hook hard-path error: ${e.message}`);
        }
      }
    }
  }

  if (!shouldHandleDirectIntake(identity, agentId, sessionKey, event)) return;

  const message = resolveIngressMessageText(event);
  if (message.length < 2) return;

  if (isInternalWakeMessage(message)) {
    logger.info(`[intake] INTERNAL WAKE for ${agentId}: "${message.slice(0, 80)}"`);
    return;
  }

  logger.info(`[intake] DIRECT MESSAGE to ${agentId}: "${message.slice(0, 80)}"`);

  const ws = agentWorkspace(agentId);
  const inboxDir = join(ws, "inbox");
  await mkdir(inboxDir, { recursive: true });

  if (await hasActiveDirectInboxEnvelope(inboxDir, { agentId, logger })) {
    logger.info(`[intake] preserved existing direct_request for ${agentId}; skip prompt rewrap`);
    return;
  }

  const contract = createDirectRequestEnvelope({
    agentId,
    sessionKey,
    defaultReplyToSelf: false,
    serviceSession: buildDirectServiceSession({
      agentId,
      sessionKey,
    }),
    message,
    outputDir: join(agentWorkspace(agentId), "output"),
  });

  const contractPath = join(inboxDir, "contract.json");
  await writeFile(contractPath, JSON.stringify(contract, null, 2));
  cacheContractSnapshot(contractPath, contract);
  broadcast("alert", { type: EVENT_TYPE.DIRECT_SESSION, agentId, task: message.slice(0, 100), ts: Date.now() });
}
