import { hasDirectedEdge, loadGraph } from "./agent/agent-graph.js";
import {
  hasDistinctUpstreamReply,
  hasResumableSourceSession,
  normalizeReplyTarget,
  shouldUseSystemActionDelivery,
} from "./coordination-primitives.js";
import { canReceiveSystemActionDelivery } from "./routing/delivery-system-action-contract-result.js";
import { normalizeString } from "./core/normalize.js";
import { buildOperatorContextMetadata } from "./operator/operator-context.js";
import { registerSystemActionDeliveryTicket } from "./routing/delivery-system-action-ticket.js";
import { resolveResumableServiceSession } from "./service-session.js";
import { broadcast } from "./transport/sse.js";
import { EVENT_TYPE } from "./core/event-types.js";
import { SYSTEM_ACTION_STATUS } from "./core/runtime-status.js";

function buildSystemActionLane(actionType) {
  const normalizedActionType = normalizeString(actionType) || "unknown";
  return `system_action.${normalizedActionType}`;
}

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

function emitGraphCollaborationBlocked({
  sourceAgentId,
  targetAgent,
  actionType,
  contractData,
  error,
}) {
  broadcast("alert", {
    type: EVENT_TYPE.GRAPH_COLLABORATION_BLOCKED,
    lane: buildSystemActionLane(actionType),
    actionType: normalizeString(actionType) || null,
    source: normalizeString(sourceAgentId) || null,
    targetAgent: normalizeString(targetAgent) || null,
    sourceContractId: normalizeString(contractData?.id) || null,
    error: normalizeString(error) || "graph collaboration blocked",
    ts: Date.now(),
  });
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

  const graph = await loadGraph();
  if (!hasDirectedEdge(graph, sourceAgentId, resolvedTargetAgent)) {
    const error = `graph disallows ${normalizeString(actionType) || "collaboration"}: `
      + `no directed edge ${normalizeString(sourceAgentId) || "unknown"} -> ${resolvedTargetAgent}`;
    logger?.warn?.(`[system_action] ${error}`);
    emitGraphCollaborationBlocked({
      sourceAgentId,
      targetAgent: resolvedTargetAgent,
      actionType,
      contractData,
      error,
    });
    return {
      ok: false,
      targetAgent: resolvedTargetAgent,
      graph,
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
      graph,
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
        graph,
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
    graph,
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
