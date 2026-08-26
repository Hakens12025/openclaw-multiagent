import {
  ARTIFACT_TYPES,
  INTENT_TYPES,
} from "../protocol/protocol-primitives.js";
import {
  CONTRACT_STATUS,
  SYSTEM_ACTION_STATUS,
  isDeferredSystemActionAcceptedStatus,
} from "../core/runtime-status.js";
import { inferSemanticWorkflow } from "../routing/runtime-workflow-semantics.js";
import { DELIVERY_WORKFLOWS } from "../routing/delivery/delivery-protocols.js";
import {
} from "../stage/execution-observation.js";
import { normalizeTerminalOutcome } from "../contract/terminal-outcome.js";

function buildSystemActionFailureReason(systemActionResult) {
  if (typeof systemActionResult?.error === "string" && systemActionResult.error.trim()) {
    return systemActionResult.error.trim();
  }
  if (systemActionResult?.actionType && systemActionResult?.status) {
    return `${systemActionResult.actionType} returned ${systemActionResult.status}`;
  }
  if (systemActionResult?.status) {
    return `system_action returned ${systemActionResult.status}`;
  }
  return "system_action failed";
}

// 单槽→数组迁移期的归一读:旧盘合约存单对象,新写盘存数组。
export function normalizeSystemActionResults(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

// 多动作会话的主结果:终态阶梯只认一个代表。deferred 优先——回投机械依赖
// COMPLETED-deferred,其余动作的失败进账(contract.systemAction 数组可见)
// 但不翻终态;无 deferred 时取首个可判定的,否则取末位。
export function selectPrimarySystemActionResult(results) {
  const list = normalizeSystemActionResults(results);
  if (list.length === 0) return null;
  return list.find((result) => isDeferredSystemActionAccepted(result))
    || list.find((result) => result?.status && result.status !== SYSTEM_ACTION_STATUS.NO_ACTION)
    || list[list.length - 1];
}

export function isDeferredSystemActionAccepted(systemActionResult) {
  return systemActionResult?.deferredCompletion === true
    && isDeferredSystemActionAcceptedStatus(systemActionResult.status);
}

export function buildDeferredSystemActionFollowUp(systemActionResult) {
  if (!isDeferredSystemActionAccepted(systemActionResult)) {
    return null;
  }

  const baseFollowUp = {
    type: systemActionResult.actionType || null,
    targetAgent: systemActionResult.targetAgent || null,
    contractId: systemActionResult.contractId || null,
    deliveryTicketId: systemActionResult.deliveryTicketId || null,
    mode: "delivery",
    ts: Date.now(),
  };

  if (systemActionResult.actionType === INTENT_TYPES.CREATE_TASK) {
    return {
      ...baseFollowUp,
      workflow: DELIVERY_WORKFLOWS.SYSTEM_ACTION_RUNTIME_RESULT,
      semanticWorkflow: inferSemanticWorkflow(DELIVERY_WORKFLOWS.SYSTEM_ACTION_RUNTIME_RESULT),
      childContractId: systemActionResult.contractId || null,
      returnArtifactType: ARTIFACT_TYPES.RUNTIME_RESULT,
    };
  }

  if (systemActionResult.actionType === INTENT_TYPES.ASSIGN_TASK) {
    return {
      ...baseFollowUp,
      workflow: DELIVERY_WORKFLOWS.SYSTEM_ACTION_ASSIGN_TASK_RESULT,
      semanticWorkflow: inferSemanticWorkflow(DELIVERY_WORKFLOWS.SYSTEM_ACTION_ASSIGN_TASK_RESULT),
      delegatedAgentId: systemActionResult.targetAgent || null,
      delegatedContractId: systemActionResult.contractId || null,
      returnArtifactType: ARTIFACT_TYPES.RUNTIME_RESULT,
    };
  }

  return baseFollowUp;
}

export function deriveSystemActionTerminalOutcome(systemActionResult, executionObservation) {
  if (!systemActionResult || systemActionResult.status === SYSTEM_ACTION_STATUS.NO_ACTION || isDeferredSystemActionAccepted(systemActionResult)) {
    return null;
  }

  // 采集到了产物就不由 systemAction 失败代收终态——收口按事实走(terminal-outcome)。
  if (executionObservation?.collected === true) {
    return null;
  }

  const reason = buildSystemActionFailureReason(systemActionResult);
  // AWAITING_INPUT 已整体删除(2026-08-10):它是没有恢复通路的假等待态。
  // runtime 忙碌照样记失败,原因写清"忙碌可重试"——要不要重试是调用方的事。

  const terminalOutcome = normalizeTerminalOutcome({
    status: CONTRACT_STATUS.FAILED,
    reason,
    source: "system_action",
    actionType: systemActionResult.actionType || null,
  }, {
    terminalStatus: CONTRACT_STATUS.FAILED,
  });
  return {
    terminalOutcome,
    terminalStatus: terminalOutcome.status,
  };
}
