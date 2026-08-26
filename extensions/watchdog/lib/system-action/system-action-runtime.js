import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { dispatchAcceptIngressMessage } from "../ingress/dispatch-entry.js";
import { normalizeIngressPhases } from "../ingress/ingress-classification.js";
import {
  buildRuntimeWakeReason,
  RUNTIME_WAKE_SEMANTICS,
  runtimeWakeAgentDetailed,
} from "../transport/runtime-wake-transport.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { agentWorkspace } from "../state.js";
import {
  hasDistinctUpstreamReply,
} from "../routing/coordination-primitives.js";
import { deliveryEnqueueSystemActionReturn } from "../routing/delivery/delivery-system-action-transport.js";
import {
  deriveDispatchStatusFromWake,
  getWakeError,
  normalizeWakeDiagnostic,
} from "../routing/runtime-diagnostics.js";
import {
  INTENT_TYPES,
  createDirectRequestEnvelope,
} from "../protocol/protocol-primitives.js";
import {
  attachOperatorContext,
} from "../operator/operator-context.js";
import {
  attachSystemActionDeliveryTicket,
} from "../routing/delivery/delivery-system-action-ticket.js";
import { SYSTEM_ACTION_DELIVERY_IDS } from "../routing/delivery/delivery-protocols.js";
import { DELIVERY_LEGS } from "../store/delivery-idempotency-store.js";
import { materializeExpectationPaths, normalizeContractExpectations } from "../contract/contract-expectations.js";
import { inheritLineage } from "../contract/contract-lineage.js";
import { resolveAgentIngressSource } from "../agent/agent-identity.js";
import { SYSTEM_ACTION_STATUS } from "../core/runtime-status.js";
import {
  planCollaborationSystemActionDelivery,
  prepareCollaborationTarget,
} from "./collaboration-policy.js";

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
      normalizedAction.params?.reason || null,
      api,
      logger,
      {
        wakeSemantic: RUNTIME_WAKE_SEMANTICS.SYSTEM_ACTION_WAKE_AGENT,
        sourceAgentId: agentId,
        actionType: normalizedAction.type,
        sourceContractId: contractData?.id || null,
      },
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
    // 派生点(批①):子约继承源约谱系;源约无谱系 → null 透传(过渡期合法态)。
    lineage: inheritLineage(contractData),
    ingressDirective: normalizedAction.params,
    api,
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
      : ingressResult?.queued === true
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

// 受理凭证 queuePosition(spec §5):排队分支从合约实际落入的 direct-envelope
// 落盘队列取位次(1 起算,文件名序=FIFO 序)。dispatch 传送带的内存队列是另一条
// 传输,深度对不上这里,所以按 enqueue 结果的 queuePath 就地读目录。
async function resolveDirectEnvelopeQueuePosition(enqueueResult) {
  const queuePath = typeof enqueueResult?.queuePath === "string" ? enqueueResult.queuePath : "";
  if (!queuePath) return null;
  try {
    const queuedFiles = (await readdir(dirname(queuePath)))
      .filter((file) => /^contract-.*\.json$/i.test(file))
      .sort();
    const selfIndex = queuedFiles.indexOf(basename(queuePath));
    return selfIndex >= 0 ? selfIndex + 1 : null;
  } catch {
    return null;
  }
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

  // 期望翻译唯一通道(spec 决议 6/22):派工方在参数里声明,平台建约时抄写;
  // 结构非法在受理时刻拒绝,不建约。
  const expectationsCheck = normalizeContractExpectations(normalizedAction.params?.expectations);
  if (!expectationsCheck.ok) {
    logger.warn(`[system_action] ${agentId} assign_task rejected: ${expectationsCheck.error}`);
    return {
      status: SYSTEM_ACTION_STATUS.INVALID_PARAMS,
      actionType: normalizedAction.type,
      error: `invalid expectations: ${expectationsCheck.error}`,
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
    ticketLane: SYSTEM_ACTION_DELIVERY_IDS.ASSIGN_TASK_RESULT,
  });

  const contract = createDirectRequestEnvelope({
    agentId: resolvedTargetAgent,
    sessionKey,
    replyTo,
    upstreamReplyTo,
    returnContext: systemActionDelivery.returnContext,
    serviceSession: systemActionDelivery.serviceSession,
    // 派生点(批①):assign 子约继承源约谱系(同 run 传染);源约无谱系 → null。
    lineage: inheritLineage(contractData),
    message,
    // 派工先验阶段:与 ingress 侧同一把归一(字符串/带 name 对象、去空),
    // 归一后交给建约方物化 stagePlan。
    phases: normalizeIngressPhases(normalizedAction.params?.phases),
    outputDir: join(agentWorkspace(resolvedTargetAgent), "output"),
    source: INTENT_TYPES.ASSIGN_TASK,
    // 建约抄写时物化:相对路径钉成受托方 workspace 绝对路径(判决侧零猜测)。
    expectations: materializeExpectationPaths(expectationsCheck.expectations, agentWorkspace(resolvedTargetAgent)),
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

  const { wake, enqueueResult } = await deliveryEnqueueSystemActionReturn({
    lane: SYSTEM_ACTION_DELIVERY_IDS.ASSIGN_TASK_RESULT,
    deliveryLeg: DELIVERY_LEGS.DISPATCH,
    targetAgent: resolvedTargetAgent,
    contract,
    api,
    logger,
    wake: {
      reason: normalizedAction.params?.reason || buildRuntimeWakeReason(null, {
        wakeSemantic: RUNTIME_WAKE_SEMANTICS.ASSIGN_TASK_DISPATCH,
        sourceAgentId: agentId,
      }),
      wakeSemantic: RUNTIME_WAKE_SEMANTICS.ASSIGN_TASK_DISPATCH,
      sourceAgentId: agentId,
      deliveryTicketId: systemActionDelivery.deliveryTicket?.id || null,
      sourceContractId: contractData?.id || null,
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
  const dispatchStatus = deriveDispatchStatusFromWake(wake);
  const queuePosition = dispatchStatus === SYSTEM_ACTION_STATUS.QUEUED
    ? await resolveDirectEnvelopeQueuePosition(enqueueResult)
    : null;
  return {
    status: dispatchStatus,
    actionType: normalizedAction.type,
    targetAgent: resolvedTargetAgent,
    contractId: contract.id,
    deferredCompletion: systemActionDelivery.deferredCompletion,
    deliveryTicketId: systemActionDelivery.deliveryTicket?.id || null,
    ...(queuePosition != null ? { queuePosition } : {}),
    wake,
  };
}

const RUNTIME_SYSTEM_ACTION_HANDLERS = {
  [INTENT_TYPES.WAKE_AGENT]: systemActionRunWakeAgent,
  [INTENT_TYPES.CREATE_TASK]: systemActionRunCreateTask,
  [INTENT_TYPES.ASSIGN_TASK]: systemActionRunAssignTask,
};

export async function systemActionDispatch(normalizedAction, context) {
  const handler = RUNTIME_SYSTEM_ACTION_HANDLERS[normalizedAction?.type];
  if (!handler) return undefined;
  return handler(normalizedAction, context);
}

// Consistency surface for collaboration-intent-policy (P2 acceptance:
// the three query surfaces must agree — see tests/collaboration-intent-policy.test.js).
export function listRuntimeHandledIntents() {
  return Object.keys(RUNTIME_SYSTEM_ACTION_HANDLERS);
}
