import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { getAgentRole } from "../agent/agent-identity.js";
import {
  isKnownIntentType,
  normalizeSystemIntent,
} from "../protocol/protocol-primitives.js";
import { systemActionDispatch } from "./system-action-runtime.js";
import {
  SYSTEM_ACTION_STATUS,
} from "../core/runtime-status.js";
import {
  isActionAllowedForRole,
  resolveDisallowedActionReason,
} from "./system-action-role-policy.js";
export {
  buildDeferredSystemActionFollowUp,
  deriveSystemActionTerminalOutcome,
} from "./system-action-runtime-ledger.js";

export function buildSystemActionReplyTarget({
  agentId,
  sessionKey,
  contractData,
} = {}) {
  if (
    contractData?.replyTo
    && typeof contractData.replyTo === "object"
    && contractData.replyTo.agentId === agentId
  ) {
    return { ...contractData.replyTo };
  }
  return {
    agentId,
    sessionKey,
  };
}

async function systemActionDispatchEntry(action, {
  agentId,
  sessionKey,
  contractData,
  api,
  logger,
}) {
  const normalizedAction = normalizeSystemIntent(action);
  const actionReplyTo = buildSystemActionReplyTarget({
    agentId,
    sessionKey,
    contractData,
  });
  const runtimeActionResult = await systemActionDispatch(normalizedAction, {
    agentId,
    sessionKey,
    contractData,
    api,
    logger,
    actionReplyTo,
  });
  if (runtimeActionResult !== undefined) {
    return runtimeActionResult;
  }

  // systemActionDispatch 返回 undefined = 没有 runtime handler。回路退役后词汇表里
  // 的四个 intent 全部有 handler，故这里只可能是真未知动作；仍按「既知但无处理器」
  // 与「未知」分流写日志，让日后新增词汇位时的缺口不被 warn 噪音淹没。
  if (!isKnownIntentType(normalizedAction.type)) {
    logger.warn(`[system_action] unknown action type: ${normalizedAction.type}`);
  }
  return { status: SYSTEM_ACTION_STATUS.UNKNOWN_ACTION, actionType: normalizedAction.type || null };
}

export async function systemActionConsume({
  agentId,
  sessionKey,
  contractData,
  api,
  logger,
  injectedAction = null,
}) {
  // Path 1: Injected action (from [ACTION] markers — Rule 12.2)
  if (injectedAction) {
    // Role-policy enforcement: reject disallowed (role, actionType) pairs
    // before any side effects occur. This applies uniformly to every role,
    // including bridge: a bridge that emits [ACTION] review is rejected here.
    const actionRole = (() => {
      try { return getAgentRole(agentId); } catch { return null; }
    })();
    const attemptedActionType = injectedAction?.type || null;
    if (actionRole && attemptedActionType && !isActionAllowedForRole(actionRole, attemptedActionType)) {
      const reason = resolveDisallowedActionReason(actionRole, attemptedActionType);
      logger.warn(`[system_action] ${agentId} role-policy reject: ${reason}`);
      // known-but-denied 是被规定的行为(如缓建 intent create_task roles=[]),
      // 广播出来让证据面与 live 预设可确定性观测,不再只靠日志考古。
      broadcast("alert", {
        type: EVENT_TYPE.SYSTEM_ACTION_ROLE_POLICY_REJECTED,
        source: agentId,
        actionType: attemptedActionType,
        role: actionRole,
        reason,
        // 证据定位(2026-08-27):哨兵「查看证据」深链靠这两列;缺了拒绝红点只能
        // 降级为不可跳(前端诚实禁用)。作用域现成,发端带上=证据链闭环。
        contractId: contractData?.id ?? null,
        sessionKey: sessionKey ?? null,
        ts: Date.now(),
      });
      return {
        status: SYSTEM_ACTION_STATUS.DISPATCH_ERROR,
        actionType: attemptedActionType,
        error: reason,
        rolePolicyRejected: true,
      };
    }
    try {
      return await systemActionDispatchEntry(injectedAction, {
        agentId, sessionKey, contractData, api, logger,
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
