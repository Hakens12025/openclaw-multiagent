import { FLOW_VISUAL_ID, PROTOCOL_ID } from "./protocol-registry.js";

const SYSTEM_ACTION_DELIVERY_ALERT_PROTOCOL = Object.freeze({
  system_action_contract_result_delivered: PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_CONTRACT_RESULT,
  system_action_assign_task_result_delivered: PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_ASSIGN_TASK_RESULT,
  system_action_review_verdict_delivered: PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_REVIEW_VERDICT,
});

export function normalizeFlowToken(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveFlowProtocolId(kind, data = null) {
  if (kind === "reply") return PROTOCOL_ID.DELIVERY.TERMINAL;
  if (kind === "graph_dispatch") return PROTOCOL_ID.DISPATCH.EXECUTION_CONTRACT;
  if (kind === "pipeline") {
    return data?.type === "loop_started"
      ? PROTOCOL_ID.SYSTEM_ACTION.START_LOOP
      : PROTOCOL_ID.SYSTEM_ACTION.ADVANCE_LOOP;
  }

  if (kind === "dispatch_alert" || kind === "activity") {
    const envelope = normalizeFlowToken(data?.protocolEnvelope);
    return envelope === "direct_request"
      ? PROTOCOL_ID.DISPATCH.DIRECT_REQUEST
      : PROTOCOL_ID.DISPATCH.EXECUTION_CONTRACT;
  }

  const alertType = normalizeFlowToken(data?.type);
  return SYSTEM_ACTION_DELIVERY_ALERT_PROTOCOL[alertType] || PROTOCOL_ID.DISPATCH.EXECUTION_CONTRACT;
}

export function resolveFlowVisualType(kind, data = null) {
  const protocolId = resolveFlowProtocolId(kind, data);
  switch (protocolId) {
    case PROTOCOL_ID.DISPATCH.DIRECT_REQUEST:
      return FLOW_VISUAL_ID.DISPATCH_DIRECT;
    case PROTOCOL_ID.DELIVERY.TERMINAL:
      return FLOW_VISUAL_ID.DELIVERY_TERMINAL;
    case PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_CONTRACT_RESULT:
    case PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_ASSIGN_TASK_RESULT:
    case PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_REVIEW_VERDICT:
      return FLOW_VISUAL_ID.DELIVERY_RETURN;
    case PROTOCOL_ID.SYSTEM_ACTION.START_LOOP:
    case PROTOCOL_ID.SYSTEM_ACTION.ADVANCE_LOOP:
      return FLOW_VISUAL_ID.WORKFLOW_PROGRESS;
    default:
      return data?.fastTrack === true
        ? `${FLOW_VISUAL_ID.DISPATCH_GRAPH}:fast`
        : FLOW_VISUAL_ID.DISPATCH_GRAPH;
  }
}

export function resolveFlowVisualLabel(kind, data = null) {
  const visualType = resolveFlowVisualType(kind, data);
  if (visualType === FLOW_VISUAL_ID.DISPATCH_DIRECT) return "DIRECT";
  if (visualType === FLOW_VISUAL_ID.DELIVERY_TERMINAL) return "DELIVERY";
  if (visualType === FLOW_VISUAL_ID.DELIVERY_RETURN) return "RETURN";
  if (visualType === FLOW_VISUAL_ID.WORKFLOW_PROGRESS) return "PIPELINE";
  return "ROUTE";
}

export function resolveFlowVisualClasses(visualType) {
  switch (visualType) {
    case `${FLOW_VISUAL_ID.DISPATCH_GRAPH}:fast`:
      return " flow-graph-route flow-graph-route-fast";
    case FLOW_VISUAL_ID.DISPATCH_GRAPH:
      return " flow-graph-route";
    case FLOW_VISUAL_ID.DISPATCH_DIRECT:
      return " flow-direct-dispatch";
    case FLOW_VISUAL_ID.WORKFLOW_PROGRESS:
      return " flow-pipeline-progress";
    case FLOW_VISUAL_ID.DELIVERY_TERMINAL:
      return " flow-terminal-delivery";
    case FLOW_VISUAL_ID.DELIVERY_RETURN:
      return " flow-system-action-delivery";
    default:
      return " flow-graph-route";
  }
}

export function resolveSystemActionDeliveryAlertFlow(data) {
  const alertType = normalizeFlowToken(data?.type);
  const protocolId = SYSTEM_ACTION_DELIVERY_ALERT_PROTOCOL[alertType];
  if (!protocolId) {
    return null;
  }

  const source = normalizeFlowToken(data?.source);
  const target = normalizeFlowToken(data?.targetAgent);
  if (!source || !target || source === target) {
    return null;
  }

  return {
    from: source,
    to: target,
    label: resolveFlowVisualLabel("system_action_delivery", data),
    protocolId,
    type: resolveFlowVisualType("system_action_delivery", data),
  };
}
