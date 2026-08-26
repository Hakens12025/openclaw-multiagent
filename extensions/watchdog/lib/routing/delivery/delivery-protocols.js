import { PROTOCOL_ID } from "../../protocol/protocol-registry.js";

export const DELIVERY_TYPES = Object.freeze({
  TERMINAL: "terminal",
  SYSTEM_ACTION: "system_action",
});

export const DELIVERY_WORKFLOWS = Object.freeze({
  TERMINAL: PROTOCOL_ID.DELIVERY.TERMINAL,
  SYSTEM_ACTION_RUNTIME_RESULT: PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_RUNTIME_RESULT,
  SYSTEM_ACTION_ASSIGN_TASK_RESULT: PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_ASSIGN_TASK_RESULT,
});

export const SYSTEM_ACTION_DELIVERY_IDS = Object.freeze({
  RUNTIME_RESULT: PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_RUNTIME_RESULT,
  ASSIGN_TASK_RESULT: PROTOCOL_ID.DELIVERY.SYSTEM_ACTION_ASSIGN_TASK_RESULT,
});

export function applyTerminalDeliverySemantics(result = {}) {
  return {
    ...result,
    deliveryType: DELIVERY_TYPES.TERMINAL,
    workflow: DELIVERY_WORKFLOWS.TERMINAL,
  };
}

export function applySystemActionDeliverySemantics(result = {}, {
  workflow = null,
  deliveryId = null,
} = {}) {
  return {
    ...result,
    deliveryType: DELIVERY_TYPES.SYSTEM_ACTION,
    workflow,
    ...(deliveryId ? { deliveryId: deliveryId } : {}),
  };
}
