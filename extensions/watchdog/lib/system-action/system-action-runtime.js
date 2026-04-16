import { join } from "node:path";
import { dispatchAcceptIngressMessage } from "../ingress/dispatch-entry.js";
import { runtimeWakeAgentDetailed } from "../transport/runtime-wake-transport.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { agentWorkspace } from "../state.js";
import {
  hasDistinctUpstreamReply,
} from "../coordination-primitives.js";
import { deliveryEnqueueSystemActionReturn } from "../routing/delivery-system-action-transport.js";
import {
  deriveDispatchStatusFromWake,
  getWakeError,
  normalizeWakeDiagnostic,
} from "../lifecycle/runtime-diagnostics.js";
import {
  INTENT_TYPES,
  createDirectRequestEnvelope,
} from "../protocol-primitives.js";
import {
  attachOperatorContext,
} from "../operator/operator-context.js";
import {
  attachSystemActionDeliveryTicket,
} from "../routing/delivery-system-action-ticket.js";
import { systemActionRunRequestReview } from "./system-action-request-review.js";
import { resolveAgentIngressSource } from "../agent/agent-identity.js";
import { SYSTEM_ACTION_STATUS } from "../core/runtime-status.js";
import {
  planCollaborationSystemActionDelivery,
  prepareCollaborationTarget,
} from "../collaboration-policy.js";

async function systemActionRunWakeAgent(normalizedAction, {
  agentId,
  api,
  logger,
  contractData,
}) {
  const collaborationTarget = await prepareCollaborationTarget({
    actionType: normalizedAction.type,
    sourceAgentId: agentId,
    contractData,
    logger,
    targetAgent: normalizedAction.params?.targetAgent,
    missingTargetError: "wake_agent requires targetAgent",
    missingTargetStatus: SYSTEM_ACTION_STATUS.INVALID_PARAMS,
  });
  if (!collaborationTarget.ok) {
    return collaborationTarget.result;
  }
  const target = collaborationTarget.targetAgent;
  const wake = normalizeWakeDiagnostic(
    await runtimeWakeAgentDetailed(
      target,
      normalizedAction.params?.reason || "system_action wakeup",
      api,
      logger,
    ),
    {
      lane: "system_action.wake_agent",
      targetAgent: target,
    },
  );
  if (!wake.ok) {
    broadcast("alert", {
      type: EVENT_TYPE.RUNTIME_WAKE_FAILED,
      lane: "system_action.wake_agent",
      source: agentId,
      targetAgent: target,
      error: getWakeError(wake) || "wake failed",
      ts: Date.now(),
    });
  } else {
    logger.info(`[system_action] ${agentId} woke ${target}`);
  }
  return {
    status: wake.ok ? SYSTEM_ACTION_STATUS.DISPATCHED : SYSTEM_ACTION_STATUS.WAKE_FAILED,
    actionType: normalizedAction.type,
    targetAgent: target,
    wake,
  };
}

async function systemActionRunCreateTask(normalizedAction, {
  agentId,
  sessionKey,
  contractData,
  api,
  enqueueFn,
  wakePlanner,
  logger,
  actionReplyTo,
}) {
  const childReplyTo = normalizedAction.params?.replyTo || actionReplyTo;
  const upstreamReplyTo = normalizedAction.params?.upstreamReplyTo || contractData?.replyTo || null;
  const systemActionDelivery = await planCollaborationSystemActionDelivery({
    actionType: normalizedAction.type,
    intentType: normalizedAction.type,
    sourceAgentId: agentId,
    sourceSessionKey: sessionKey,
    contractData,
    replyTo: childReplyTo,
    upstreamReplyTo,
  });
  const ingressResult = await dispatchAcceptIngressMessage(normalizedAction.params.message, {
    source: resolveAgentIngressSource(agentId, normalizedAction.params?.source || "webui"),
    replyTo: childReplyTo,
    operatorContext: contractData?.operatorContext || null,
    upstreamReplyTo: systemActionDelivery.deferredCompletion && hasDistinctUpstreamReply(childReplyTo, upstreamReplyTo)
      ? upstreamReplyTo
      : null,
    returnContext: systemActionDelivery.returnContext,
    serviceSession: systemActionDelivery.serviceSession,
    systemActionDeliveryTicket: systemActionDelivery.deliveryTicket,
    ingressDirective: normalizedAction.params,
    api,
    enqueue: enqueueFn,
    wakePlanner,
    logger,
  });
  const wake = ingressResult && "wake" in ingressResult
    ? normalizeWakeDiagnostic(ingressResult.wake, {
        lane: "system_action.create_task",
        targetAgent: ingressResult?.targetAgent || null,
      })
    : null;
  if (wake && !wake.ok) {
    broadcast("alert", {
      type: EVENT_TYPE.RUNTIME_WAKE_FAILED,
      lane: "system_action.create_task",
      source: agentId,
      targetAgent: wake.targetAgent || ingressResult?.targetAgent || null,
      sourceContractId: contractData?.id || null,
      error: getWakeError(wake) || "wake failed",
      ts: Date.now(),
    });
  }
  logger.info(`[system_action] ${agentId} triggered create_task`);
  return {
    status: wake
      ? deriveDispatchStatusFromWake(wake)
      : ingressResult?.fastTrack === true
        ? SYSTEM_ACTION_STATUS.QUEUED
        : SYSTEM_ACTION_STATUS.DISPATCHED,
    actionType: normalizedAction.type,
    contractId: ingressResult?.contractId || null,
    deferredCompletion: systemActionDelivery.deferredCompletion,
    deliveryTicketId: systemActionDelivery.deliveryTicket?.id || null,
    targetAgent: wake?.targetAgent || ingressResult?.targetAgent || null,
    wake,
    error: wake && !wake.ok ? (getWakeError(wake) || "wake failed") : null,
  };
}

async function systemActionRunAssignTask(normalizedAction, {
  agentId,
  sessionKey,
  contractData,
  api,
  logger,
  actionReplyTo,
}) {
  const targetAgent = typeof normalizedAction.params?.targetAgent === "string"
    ? normalizedAction.params.targetAgent.trim()
    : "";
  const message = typeof normalizedAction.params?.message === "string" && normalizedAction.params.message.trim()
    ? normalizedAction.params.message.trim()
    : typeof normalizedAction.params?.instruction === "string" && normalizedAction.params.instruction.trim()
      ? normalizedAction.params.instruction.trim()
      : "";

  if (!targetAgent || !message) {
    logger.warn(`[system_action] ${agentId} assign_task missing targetAgent/message`);
    return {
      status: SYSTEM_ACTION_STATUS.INVALID_PARAMS,
      actionType: normalizedAction.type,
      error: "assign_task requires targetAgent and message/instruction",
    };
  }

  const collaborationTarget = await prepareCollaborationTarget({
    actionType: normalizedAction.type,
    sourceAgentId: agentId,
    contractData,
    logger,
    targetAgent,
  });
  if (!collaborationTarget.ok) {
    return collaborationTarget.result;
  }
  const resolvedTargetAgent = collaborationTarget.targetAgent;

  const replyTo = normalizedAction.params?.replyTo || actionReplyTo;
  const upstreamReplyTo = hasDistinctUpstreamReply(
    replyTo,
    normalizedAction.params?.upstreamReplyTo || contractData?.replyTo || null,
  )
    ? (normalizedAction.params?.upstreamReplyTo || contractData?.replyTo || null)
    : null;
  const systemActionDelivery = await planCollaborationSystemActionDelivery({
    actionType: normalizedAction.type,
    intentType: INTENT_TYPES.ASSIGN_TASK,
    sourceAgentId: agentId,
    sourceSessionKey: sessionKey,
    contractData,
    replyTo,
    upstreamReplyTo,
  });

  const contract = createDirectRequestEnvelope({
    agentId: resolvedTargetAgent,
    sessionKey,
    replyTo,
    upstreamReplyTo,
    returnContext: systemActionDelivery.returnContext,
    serviceSession: systemActionDelivery.serviceSession,
    message,
    outputDir: join(agentWorkspace(resolvedTargetAgent), "output"),
    source: INTENT_TYPES.ASSIGN_TASK,
  });
  attachOperatorContext(contract, contractData?.operatorContext);
  attachSystemActionDeliveryTicket(contract, systemActionDelivery.deliveryTicket);
  contract.assignmentContext = {
    sourceAgentId: agentId,
    sourceContractId: contractData?.id || null,
    sourceSessionKey: sessionKey || null,
    sourceReplyTo: replyTo || null,
    upstreamReplyTo: upstreamReplyTo || null,
    serviceSession: systemActionDelivery.serviceSession || null,
    systemActionDeliveryTicket: systemActionDelivery.deliveryTicket || null,
  };

  const { wake } = await deliveryEnqueueSystemActionReturn({
    lane: "system_action.assign_task",
    targetAgent: resolvedTargetAgent,
    contract,
    api,
    logger,
    wake: {
      reason: normalizedAction.params?.reason || `assign_task from ${agentId}`,
      failureAlert: {
        source: agentId,
      },
    },
    queuedLogMessage: `[system_action] ${agentId} queued assign_task for ${targetAgent}; active inbox contract remains in place`,
  });

  broadcast("alert", {
    type: EVENT_TYPE.AGENT_TASK_ASSIGNED,
    source: agentId,
    targetAgent: resolvedTargetAgent,
    contractId: contract.id,
    task: message.slice(0, 100),
    protocolEnvelope: contract.protocol?.envelope || null,
    ts: Date.now(),
  });
  logger.info(`[system_action] ${agentId} assigned task to ${resolvedTargetAgent}`);
  return {
    status: deriveDispatchStatusFromWake(wake),
    actionType: normalizedAction.type,
    targetAgent: resolvedTargetAgent,
    contractId: contract.id,
    deferredCompletion: systemActionDelivery.deferredCompletion,
    deliveryTicketId: systemActionDelivery.deliveryTicket?.id || null,
    wake,
  };
}

async function systemActionRunAdvanceLoop(normalizedAction, {
  agentId,
  logger,
}) {
  return {
    status: SYSTEM_ACTION_STATUS.INVALID_STATE,
    actionType: normalizedAction.type,
    error: `advance loop is graph-router-owned; ${agentId} should emit outbox stage_result instead`,
  };
}

const RUNTIME_SYSTEM_ACTION_HANDLERS = {
  [INTENT_TYPES.WAKE_AGENT]: systemActionRunWakeAgent,
  [INTENT_TYPES.CREATE_TASK]: systemActionRunCreateTask,
  [INTENT_TYPES.ASSIGN_TASK]: systemActionRunAssignTask,
  [INTENT_TYPES.REQUEST_REVIEW]: systemActionRunRequestReview,
  [INTENT_TYPES.ADVANCE_LOOP]: systemActionRunAdvanceLoop,
};

export async function systemActionDispatch(normalizedAction, context) {
  const handler = RUNTIME_SYSTEM_ACTION_HANDLERS[normalizedAction?.type];
  if (!handler) return undefined;
  return handler(normalizedAction, context);
}
