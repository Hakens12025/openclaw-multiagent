import { runtimeWakeAgentDetailed } from "../transport/runtime-wake-transport.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { QQ_OPENID } from "../state.js";
import { isQQIngressAgent } from "../agent/agent-identity.js";
import { normalizeString } from "../core/normalize.js";
import {
  INTENT_TYPES,
  isKnownIntentType,
  normalizeSystemIntent,
} from "../protocol-primitives.js";
import { systemActionDispatch } from "./system-action-runtime.js";
import {
  SYSTEM_ACTION_STATUS,
} from "../core/runtime-status.js";
import { startLoopRound } from "../loop/loop-round-runtime.js";
export {
  buildDeferredSystemActionFollowUp,
  deriveSystemActionTerminalOutcome,
} from "./system-action-runtime-ledger.js";

export function resolveStartLoopParams(normalizedAction, contractData) {
  void contractData;
  const params = normalizedAction?.params && typeof normalizedAction.params === "object"
    ? normalizedAction.params
    : {};
  const startAgent = normalizeString(params.startAgent);
  const requestedTask = normalizeString(params.requestedTask);

  return {
    ...(startAgent ? { startAgent } : {}),
    ...(requestedTask ? { requestedTask } : {}),
  };
}

async function systemActionDispatchEntry(action, {
  agentId,
  sessionKey,
  contractData,
  api,
  enqueueFn,
  wakePlanner,
  logger,
}) {
  const normalizedAction = normalizeSystemIntent(action);
  const actionReplyTo = {
    agentId,
    sessionKey,
    ...(isQQIngressAgent(agentId) ? { channel: "qqbot", target: QQ_OPENID } : {}),
  };
  const runtimeActionResult = await systemActionDispatch(normalizedAction, {
    agentId,
    sessionKey,
    contractData,
    api,
    enqueueFn,
    wakePlanner,
    logger,
    actionReplyTo,
  });
  if (runtimeActionResult !== undefined) {
    return runtimeActionResult;
  }

  switch (normalizedAction.type) {
    case INTENT_TYPES.START_LOOP: {
      const startLoopParams = resolveStartLoopParams(normalizedAction, contractData);
      const loopResult = await startLoopRound(
        startLoopParams,
        (targetAgentId, wakeOptions = {}) => runtimeWakeAgentDetailed(
          targetAgentId,
          "loop 启动: 请读取 inbox/contract.json 并执行当前合同",
          api,
          logger,
          {
            sessionKey: wakeOptions?.sessionKey || null,
          },
        ),
        (contractId) => enqueueFn?.(contractId) ?? contractId,
        actionReplyTo,
        logger,
      );

      if (loopResult.action === "busy") {
        return {
          status: SYSTEM_ACTION_STATUS.BUSY,
          actionType: normalizedAction.type,
          error: loopResult.error || "loop already active",
          loopId: loopResult.loopId || null,
        };
      }

      if (loopResult.action === "invalid_params") {
        return {
          status: SYSTEM_ACTION_STATUS.INVALID_PARAMS,
          actionType: normalizedAction.type,
          error: loopResult.error,
        };
      }

      broadcast("alert", { type: EVENT_TYPE.LOOP_STARTED, source: agentId, ts: Date.now() });
      logger.info(`[system_action] ${agentId} triggered start_loop → ${loopResult.action}`);
      return {
        status: SYSTEM_ACTION_STATUS.DISPATCHED,
        actionType: normalizedAction.type,
        loopId: loopResult.loopId || null,
        loopSessionId: loopResult.loopSessionId || null,
        currentStage: loopResult.currentStage || null,
        targetAgent: loopResult.targetAgent || null,
      };
    }
    default:
      if (!isKnownIntentType(normalizedAction.type)) {
        logger.warn(`[system_action] unknown action type: ${normalizedAction.type}`);
      }
      return { status: SYSTEM_ACTION_STATUS.UNKNOWN_ACTION, actionType: normalizedAction.type || null };
  }
}

export async function systemActionConsume({
  agentId,
  sessionKey,
  contractData,
  api,
  enqueueFn,
  wakePlanner,
  logger,
  injectedAction = null,
}) {
  // Path 1: Injected action (from [ACTION] markers — Rule 12.2)
  if (injectedAction) {
    try {
      return await systemActionDispatchEntry(injectedAction, {
        agentId, sessionKey, contractData, api, enqueueFn, wakePlanner, logger,
        actionReplyTo: { agentId, sessionKey },
      });
    } catch (error) {
      logger.warn(`[system_action] ${agentId} injected action dispatch error: ${error.message}`);
      return { status: SYSTEM_ACTION_STATUS.DISPATCH_ERROR, actionType: injectedAction.type || null, error: error.message };
    }
  }

  // No injected action and no file-based fallback — [ACTION] markers are the sole path (Rule 12.2).
  return { status: SYSTEM_ACTION_STATUS.NO_ACTION, actionType: null };
}
