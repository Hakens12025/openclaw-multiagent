import {
  hasDistinctUpstreamReply,
  hasResumableSourceSession,
  normalizeReplyTarget,
  shouldUseSystemActionDelivery,
} from "../routing/coordination-primitives.js";
import { canReceiveSystemActionDelivery } from "../routing/delivery/delivery-system-action-runtime-result.js";
import { listRuntimeAgentIds } from "../agent/agent-identity.js";
import { normalizeString } from "../core/normalize.js";
import { buildOperatorContextMetadata } from "../operator/operator-context.js";
import { registerSystemActionDeliveryTicket } from "../routing/delivery/delivery-system-action-ticket.js";
import { resolveResumableServiceSession } from "../session/service-session.js";
import { SYSTEM_ACTION_STATUS } from "../core/runtime-status.js";

function buildSystemActionResult({
  status,
  actionType = null,
  targetAgent = null,
  error = null,
}) {
  return {
    status,
    actionType: normalizeString(actionType) || null,
    ...(normalizeString(targetAgent) ? { targetAgent: normalizeString(targetAgent) } : {}),
    ...(normalizeString(error) ? { error: normalizeString(error) } : {}),
  };
}

function buildCollaborationReturnContext({
  sourceAgentId,
  sourceContractId = null,
  sourceSessionKey = null,
  intentType = null,
} = {}) {
  return {
    sourceAgentId: normalizeString(sourceAgentId) || null,
    ...(normalizeString(sourceContractId) ? { sourceContractId: normalizeString(sourceContractId) } : {}),
    ...(normalizeString(sourceSessionKey) ? { sourceSessionKey: normalizeString(sourceSessionKey) } : {}),
    ...(normalizeString(intentType) ? { intentType: normalizeString(intentType) } : {}),
  };
}

function inspectSystemActionDeliveryRoute({
  sourceAgentId,
  replyTo,
  upstreamReplyTo = null,
  returnContext = null,
  canReceive = canReceiveSystemActionDelivery,
} = {}) {
  const normalizedReplyTo = normalizeReplyTarget(replyTo);
  const normalizedSourceAgentId = normalizeString(sourceAgentId);
  const hasReturnRoute = hasDistinctUpstreamReply(normalizedReplyTo, upstreamReplyTo)
    || hasResumableSourceSession(normalizedReplyTo, returnContext);
  const targetsSourceAgent = Boolean(
    normalizedSourceAgentId
    && normalizedReplyTo?.agentId
    && normalizedReplyTo.agentId === normalizedSourceAgentId
  );
  const receiverCanAccept = targetsSourceAgent
    ? (typeof canReceive === "function" ? canReceive(normalizedSourceAgentId) === true : true)
    : false;
  const deferredCompletion = shouldUseSystemActionDelivery({
    currentAgentId: normalizedSourceAgentId,
    replyTo: normalizedReplyTo,
    upstreamReplyTo,
    returnContext,
    canReceiveSystemActionDelivery: canReceive,
  });

  return {
    replyTo: normalizedReplyTo,
    hasReturnRoute,
    targetsSourceAgent,
    receiverCanAccept,
    deferredCompletion,
  };
}

export async function prepareCollaborationTarget({
  actionType,
  sourceAgentId,
  contractData = null,
  logger = null,
  targetAgent = null,
  resolveTargetAgent = null,
  missingTargetError = null,
  missingTargetStatus = SYSTEM_ACTION_STATUS.INVALID_STATE,
  busyCheck = null,
} = {}) {
  let resolvedTargetAgent = normalizeString(targetAgent);

  if (!resolvedTargetAgent && typeof resolveTargetAgent === "function") {
    resolvedTargetAgent = normalizeString(await resolveTargetAgent());
  }

  if (!resolvedTargetAgent) {
    const error = normalizeString(missingTargetError)
      || `${normalizeString(actionType) || "collaboration"} requires targetAgent`;
    if (logger?.info) {
      logger.info(`[system_action] ${normalizeString(actionType) || "unknown"} failed: ${error}`);
    }
    return {
      ok: false,
      targetAgent: null,
      result: buildSystemActionResult({
        status: missingTargetStatus,
        actionType,
        error,
      }),
    };
  }

  // 动态协作不查图边。图是固定管线的定义(手连的那条路),动态协作的选路权归发起
  // 的 agent——spec §0 红线:「固定=图/代码,动态=agent 在授权内」,而授权单源是
  // collaboration-intent-policy 的角色表(§5 一表四消费),不是图。
  //
  // 拿图当动态协作的闸会自毁:要让 FC 够得着就得把图连成网,而同一张图又驱动 ingress
  // 首跳与 agent_end 自动选路(两者都要求出边唯一),连成网就把固定管线全判成歧义。
  //
  // 受理时刻仍然拒绝无效目标——打错 agent 名当场返回结构化拒绝,而不是受理成功后
  // 在投递环节静默失败。约束的是「这个 agent 存不存在」,不是「拓扑允不允许」。
  // 协作的对象是别人。自指在两个动作上都退化:wake 唤醒正在跑的自己、assign 派给
  // 自己,都是自递归或空转。
  // 受理时刻当场返回结构化拒绝,而不是受理成功后在下游拧成一团。
  if (resolvedTargetAgent === normalizeString(sourceAgentId)) {
    const error = `collaboration targets another agent; ${resolvedTargetAgent} is the caller itself`;
    logger?.warn?.(`[system_action] ${normalizeString(actionType) || "collaboration"} rejected: ${error}`);
    return {
      ok: false,
      targetAgent: resolvedTargetAgent,
      result: buildSystemActionResult({
        status: SYSTEM_ACTION_STATUS.INVALID_PARAMS,
        actionType,
        targetAgent: resolvedTargetAgent,
        error,
      }),
    };
  }

  if (!listRuntimeAgentIds().includes(resolvedTargetAgent)) {
    const error = `unknown target agent: ${resolvedTargetAgent}`;
    logger?.warn?.(`[system_action] ${normalizeString(actionType) || "collaboration"} rejected: ${error}`);
    return {
      ok: false,
      targetAgent: resolvedTargetAgent,
      result: buildSystemActionResult({
        status: SYSTEM_ACTION_STATUS.INVALID_STATE,
        actionType,
        targetAgent: resolvedTargetAgent,
        error,
      }),
    };
  }

  if (typeof busyCheck === "function") {
    const busyState = await busyCheck({
      targetAgent: resolvedTargetAgent,
      actionType: normalizeString(actionType) || null,
      sourceAgentId: normalizeString(sourceAgentId) || null,
      contractData,
    });
    if (busyState) {
      const status = normalizeString(busyState.status) || SYSTEM_ACTION_STATUS.BUSY;
      const error = normalizeString(busyState.error) || `${resolvedTargetAgent} currently has pending runtime work`;
      if (busyState.logMessage && logger?.info) {
        logger.info(`[system_action] ${busyState.logMessage}`);
      }
      return {
        ok: false,
        targetAgent: resolvedTargetAgent,
        result: buildSystemActionResult({
          status,
          actionType,
          targetAgent: resolvedTargetAgent,
          error,
        }),
      };
    }
  }

  return {
    ok: true,
    targetAgent: resolvedTargetAgent,
  };
}

export async function planCollaborationSystemActionDelivery({
  actionType,
  intentType = null,
  sourceAgentId,
  sourceSessionKey = null,
  contractData = null,
  replyTo = null,
  upstreamReplyTo = null,
  mode = "optional",
  logger = null,
  requiredStatus = SYSTEM_ACTION_STATUS.NOT_IMPLEMENTED,
  requiredRouteError = null,
  requiredTargetError = null,
  requiredReceiverError = null,
  ticketLane = null,
  ticketMetadata = null,
} = {}) {
  const normalizedActionType = normalizeString(actionType) || normalizeString(intentType) || "collaboration";
  const normalizedIntentType = normalizeString(intentType) || normalizeString(actionType) || null;
  const serviceSession = resolveResumableServiceSession(contractData?.serviceSession, {
    agentId: sourceAgentId,
    sessionKey: sourceSessionKey,
  });
  const returnContext = buildCollaborationReturnContext({
    sourceAgentId,
    sourceContractId: contractData?.id || null,
    sourceSessionKey: serviceSession?.entrySessionKey || null,
    intentType: normalizedIntentType,
  });
  const route = inspectSystemActionDeliveryRoute({
    sourceAgentId,
    replyTo,
    upstreamReplyTo,
    returnContext,
  });

  if (mode === "required" && !route.deferredCompletion) {
    const error = !route.hasReturnRoute
      ? normalizeString(requiredRouteError)
        || `${normalizedActionType} currently requires an upstream reply target or resumable service session`
      : !route.targetsSourceAgent
        ? normalizeString(requiredTargetError)
          || `${normalizedActionType} requires replyTo to target the source agent runtime session`
        : normalizeString(requiredReceiverError)
          || `${normalizeString(sourceAgentId) || "source agent"} cannot receive system_action delivery`;
    if (logger?.info) {
      logger.info(`[system_action] ${normalizedActionType} failed: ${error}`);
    }
    return {
      ok: false,
      deferredCompletion: false,
      serviceSession,
      returnContext: null,
      deliveryTicket: null,
      route,
      result: buildSystemActionResult({
        status: requiredStatus,
        actionType: normalizedActionType,
        error,
      }),
    };
  }

  const deferredCompletion = mode === "required" ? true : route.deferredCompletion;
  const deliveryTicket = deferredCompletion
    ? await registerSystemActionDeliveryTicket({
      lane: normalizeString(ticketLane) || normalizedIntentType || normalizedActionType,
      intentType: normalizedIntentType,
      sourceAgentId,
      sourceSessionKey: serviceSession?.entrySessionKey || sourceSessionKey || null,
      sourceContractId: contractData?.id || null,
      replyTo,
      upstreamReplyTo,
      serviceSession,
      returnContext,
      metadata: buildOperatorContextMetadata(contractData?.operatorContext, ticketMetadata),
    })
    : null;

  return {
    ok: true,
    deferredCompletion,
    serviceSession,
    returnContext: deferredCompletion ? returnContext : null,
    deliveryTicket,
    route,
  };
}
