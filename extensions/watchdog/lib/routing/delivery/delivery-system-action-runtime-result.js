// Unified system_action runtime-result delivery handlers
//
// Merges execution and assign_task result delivery into one parameterized flow.
// Both follow the same pattern:
// candidate check -> route -> context -> content -> contract -> enqueue -> ticket -> broadcast -> log -> result

import { getAgentRole } from "../../agent/agent-identity.js";
import { isAgentReplyTarget } from "../coordination-primitives.js";
import {
  ARTIFACT_TYPES,
  INTENT_TYPES,
  isDirectRequestEnvelope,
} from "../../protocol/protocol-primitives.js";
import { broadcast } from "../../transport/sse.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import {
  buildRuntimeDeliveryResultSource,
  buildSystemActionDeliveryResult,
  buildRuntimeResultDeliveryTask,
  readRuntimeResultContent,
  resolveRuntimeResultOutputPath,
  summarizeDeliveryResultPayload,
} from "./delivery-result.js";
import { normalizeTerminalOutcome } from "../../contract/terminal-outcome.js";
import { inheritLineage } from "../../contract/contract-lineage.js";
import { inferSemanticWorkflow } from "../runtime-workflow-semantics.js";
import {
  applySystemActionDeliverySemantics,
  DELIVERY_WORKFLOWS,
  SYSTEM_ACTION_DELIVERY_IDS,
} from "./delivery-protocols.js";
import {
  buildSystemActionDeliveryContext,
  createSystemActionDeliveryContract,
  enqueueSystemActionDeliveryContract,
  hasSystemActionDeliverySourceTicket,
  mergeSystemActionDeliverySource,
  resolveSystemActionDeliveryRoute,
} from "./delivery-system-action-helpers.js";
import {
  markSystemActionDeliveryTicketResolved,
} from "./delivery-system-action-ticket.js";

// ── Shared helpers ───────────────────────────────────────────────────────────

export function canReceiveSystemActionDelivery(agentId) {
  return getAgentRole(agentId) !== "bridge";
}

function resolveRouteSource(contractData, variant) {
  if (variant === "assign_task") {
    const extra = contractData?.assignmentContext && typeof contractData.assignmentContext === "object"
      ? contractData.assignmentContext
      : null;
    return mergeSystemActionDeliverySource(contractData, extra);
  }
  return mergeSystemActionDeliverySource(contractData);
}

// ── Candidate checks ─────────────────────────────────────────────────────────

export function isExecutionRuntimeResultDeliveryCandidate(contractData) {
  const routeSource = resolveRouteSource(contractData, "execution");
  return !isDirectRequestEnvelope(contractData)
    && isAgentReplyTarget(routeSource.replyTo)
    && canReceiveSystemActionDelivery(routeSource.replyTo?.agentId)
    && hasSystemActionDeliverySourceTicket(routeSource);
}

export function isAssignTaskResultDeliveryCandidate(contractData) {
  const routeSource = resolveRouteSource(contractData, "assign_task");
  return isDirectRequestEnvelope(contractData)
    && contractData?.protocol?.source === INTENT_TYPES.ASSIGN_TASK
    && isAgentReplyTarget(routeSource.replyTo)
    && hasSystemActionDeliverySourceTicket(routeSource);
}

// ── Variant configs ──────────────────────────────────────────────────────────

const VARIANTS = {
  execution: {
    deliveryId: SYSTEM_ACTION_DELIVERY_IDS.RUNTIME_RESULT,
    lane: SYSTEM_ACTION_DELIVERY_IDS.RUNTIME_RESULT,
    alertType: "system_action_runtime_result_delivered",
    logPrefix: "[system_action_runtime_delivery]",
    isCandidate: isExecutionRuntimeResultDeliveryCandidate,
    getRouteSource: (cd) => resolveRouteSource(cd, "execution"),
    buildReturnContextOpts: () => ({}),
    describeSource: (ctx) => {
      if (ctx.returnContext?.intentType === INTENT_TYPES.CREATE_TASK) return "create_task 子流程";
      return "runtime 子流程";
    },
    messageConfig: (desc) => ({
      header: `runtime 已收到你发起的 ${desc} 结果。`,
      successInstruction: "请基于子流程结果继续处理，并向上游调用方回复。",
      awaitingInputInstruction: "子流程需要补充信息。请先处理缺失输入，再决定如何向上游回复。",
      failureInstruction: "子流程失败。请基于失败原因整理回复或决定是否重新派发。",
      taskLabel: "子流程任务",
    }),
    buildSystemActionDelivery: ({ route, returnContext, contractData, trackingState }) => ({
      workflow: DELIVERY_WORKFLOWS.SYSTEM_ACTION_RUNTIME_RESULT,
      semanticWorkflow: inferSemanticWorkflow(DELIVERY_WORKFLOWS.SYSTEM_ACTION_RUNTIME_RESULT),
      artifactType: ARTIFACT_TYPES.RUNTIME_RESULT,
      originIntentType: returnContext?.intentType || null,
      originSourceAgentId: returnContext?.sourceAgentId || null,
      originSourceContractId: returnContext?.sourceContractId || null,
      childContractId: contractData?.id || null,
      deliveryTicketId: route.ticketId || null,
    }),
    buildAlert: ({ trackingState, contractData, route, contract, terminalStatus }) => ({
      type: EVENT_TYPE.SYSTEM_ACTION_RUNTIME_RESULT_DELIVERED,
      source: trackingState?.agentId || contractData?.assignee || "unknown",
      targetAgent: route.targetAgent,
      contractId: contract.id,
      childContractId: contractData?.id || null,
      status: terminalStatus,
      ts: Date.now(),
    }),
    buildFailureAlert: ({ trackingState, contractData }) => ({
      source: trackingState?.agentId || contractData?.assignee || "unknown",
      childContractId: contractData?.id || null,
    }),
  },
  assign_task: {
    deliveryId: SYSTEM_ACTION_DELIVERY_IDS.ASSIGN_TASK_RESULT,
    lane: SYSTEM_ACTION_DELIVERY_IDS.ASSIGN_TASK_RESULT,
    alertType: "system_action_assign_task_result_delivered",
    logPrefix: "[system_action_assign_task_delivery]",
    isCandidate: isAssignTaskResultDeliveryCandidate,
    getRouteSource: (cd) => resolveRouteSource(cd, "assign_task"),
    buildReturnContextOpts: () => ({ defaultIntentType: INTENT_TYPES.ASSIGN_TASK }),
    describeSource: (ctx) => "assign_task 子任务",
    messageConfig: (desc, agentId) => ({
      header: `受托 agent ${agentId} 已完成 ${desc}。`,
      successInstruction: "请基于子任务结果整理并继续回复上游调用方。",
      awaitingInputInstruction: "子任务需要补充信息。请先处理缺失输入，再向上游回复。",
      failureInstruction: "子任务失败。请基于失败原因整理回复或决定是否再次派发。",
      taskLabel: "子任务摘要",
    }),
    buildSystemActionDelivery: ({ route, returnContext, contractData, trackingState }) => ({
      workflow: DELIVERY_WORKFLOWS.SYSTEM_ACTION_ASSIGN_TASK_RESULT,
      semanticWorkflow: inferSemanticWorkflow(DELIVERY_WORKFLOWS.SYSTEM_ACTION_ASSIGN_TASK_RESULT),
      artifactType: ARTIFACT_TYPES.RUNTIME_RESULT,
      originIntentType: INTENT_TYPES.ASSIGN_TASK,
      originSourceAgentId: returnContext?.sourceAgentId || null,
      originSourceContractId: returnContext?.sourceContractId || null,
      delegatedAgentId: trackingState?.agentId || contractData?.assignee || null,
      delegatedContractId: contractData?.id || null,
      deliveryTicketId: route.ticketId || null,
    }),
    buildAlert: ({ trackingState, contractData, route, contract, terminalStatus }) => ({
      type: EVENT_TYPE.SYSTEM_ACTION_ASSIGN_TASK_RESULT_DELIVERED,
      source: trackingState?.agentId || contractData?.assignee || "unknown",
      targetAgent: route.targetAgent,
      delegatedContractId: contractData?.id || null,
      contractId: contract.id,
      status: terminalStatus,
      ts: Date.now(),
    }),
    buildFailureAlert: ({ trackingState, contractData }) => ({
      source: trackingState?.agentId || contractData?.assignee || "unknown",
      delegatedContractId: contractData?.id || null,
    }),
  },
};

// ── Unified handler ──────────────────────────────────────────────────────────

async function handleRuntimeResultDelivery(variant, context) {
  const { trackingState, contractData, terminalStatus, outcome, api, logger } = context;
  const cfg = VARIANTS[variant];
  if (!cfg.isCandidate(contractData)) {
    return buildSystemActionDeliveryResult({ deliveryId: cfg.deliveryId });
  }

  const routeSource = cfg.getRouteSource(contractData);
  const route = await resolveSystemActionDeliveryRoute(routeSource);
  if (route.ok !== true) {
    return buildSystemActionDeliveryResult({
      deliveryId: cfg.deliveryId,
      error: route.error || "missing_delivery_ticket",
      reason: route.resolvedBy || "missing_ticket",
      deliveryTicketId: route.ticketId || null,
    });
  }
  const returnContext = buildSystemActionDeliveryContext(routeSource, {
    targetSessionKey: route.targetSessionKey,
    ...cfg.buildReturnContextOpts(),
  });
  const resultSource = buildRuntimeDeliveryResultSource({
    trackingState,
    contractData,
  });
  const resultContent = await readRuntimeResultContent(resultSource);
  const resultSummary = summarizeDeliveryResultPayload({
    resultContent,
    outcome,
    source: resultSource,
    limit: 400,
  });
  const sourceAgent = trackingState?.agentId || contractData?.assignee || "unknown";
  const desc = cfg.describeSource({ returnContext });
  const msgConfig = cfg.messageConfig(desc, sourceAgent);

  const contract = createSystemActionDeliveryContract({
    targetAgent: route.targetAgent,
    replyTo: route.replyTo || routeSource.replyTo,
    upstreamReplyTo: route.upstreamReplyTo || routeSource.upstreamReplyTo,
    serviceSession: route.serviceSession,
    targetSessionKey: route.targetSessionKey,
    returnContext,
    operatorContext: routeSource.operatorContext,
    // 派生点(批①):回投信封继承完工子约谱系(同 run 传染);子约无谱系 → null。
    lineage: inheritLineage(contractData),
    message: buildRuntimeResultDeliveryTask({
      ...msgConfig,
      taskSummary: contractData?.task,
      terminalStatus,
      outcome,
      resultContent,
    }),
    source: variant === "assign_task"
      ? INTENT_TYPES.ASSIGN_TASK
      : (returnContext?.intentType || INTENT_TYPES.CREATE_TASK),
  });

  contract.executionObservation = resultSource.executionObservation || null;
  contract.terminalOutcome = normalizeTerminalOutcome({
    ...outcome,
    summary: outcome?.summary || resultSummary || null,
    artifact: outcome?.artifact
      || resolveRuntimeResultOutputPath(resultSource)
      || null,
  }, {
    terminalStatus,
  });
  contract.systemActionDelivery = cfg.buildSystemActionDelivery({ route, returnContext, contractData, trackingState });

  const { wake } = await enqueueSystemActionDeliveryContract({
    lane: cfg.lane,
    targetAgent: route.targetAgent,
    contract,
    api,
    logger,
    wakeReason: `${desc} result ready`,
    targetSessionKey: route.targetSessionKey,
    deliveryTicketId: route.ticketId || null,
    failureAlert: cfg.buildFailureAlert({ trackingState, contractData }),
    queuedLogMessage: `${cfg.logPrefix} queued result for ${route.targetAgent}; active inbox contract remains in place`,
  });
  await markSystemActionDeliveryTicketResolved(routeSource.systemActionDeliveryTicket, {
    resolvedByAgentId: route.targetAgent,
    resolvedByContractId: contract.id,
  });

  broadcast("alert", cfg.buildAlert({ trackingState, contractData, route, contract, terminalStatus }));
  logger.info(`${cfg.logPrefix} result routed back to ${route.targetAgent}`);

  return applySystemActionDeliverySemantics(buildSystemActionDeliveryResult({
    deliveryId: cfg.deliveryId,
    handled: true,
    targetAgent: route.targetAgent,
    contractId: contract.id,
    workflow: contract.systemActionDelivery?.workflow || null,
    status: terminalStatus,
    artifactType: ARTIFACT_TYPES.RUNTIME_RESULT,
    semanticWorkflow: inferSemanticWorkflow(contract.systemActionDelivery?.workflow || cfg.lane),
    reason: route.resolvedBy,
    deliveryTicketId: route.ticketId || null,
    wake,
  }), {
    workflow: contract.systemActionDelivery?.workflow || null,
    deliveryId: cfg.deliveryId,
  });
}

// ── Public API (drop-in replacements) ────────────────────────────────────────

export async function deliveryRunSystemActionRuntimeResult(context) {
  return handleRuntimeResultDelivery("execution", context);
}

export async function deliveryRunSystemActionAssignTaskResult(context) {
  return handleRuntimeResultDelivery("assign_task", context);
}
