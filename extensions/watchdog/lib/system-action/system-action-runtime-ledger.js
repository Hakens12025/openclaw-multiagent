import {
  ARTIFACT_TYPES,
  INTENT_TYPES,
} from "../protocol-primitives.js";
import {
  CONTRACT_STATUS,
  SYSTEM_ACTION_STATUS,
  isDeferredSystemActionAcceptedStatus,
} from "../core/runtime-status.js";
import { inferSemanticWorkflow } from "../runtime-workflow-semantics.js";
import { DELIVERY_WORKFLOWS } from "../routing/delivery-protocols.js";
import {
  hasExecutionObservationPayload,
} from "../execution-observation.js";
import { normalizeTerminalOutcome } from "../terminal-outcome.js";

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

export function isDeferredSystemActionAccepted(systemActionResult) {
  if (
    systemActionResult?.deferredCompletion === true
    && isDeferredSystemActionAcceptedStatus(systemActionResult.status)
  ) {
    return true;
  }

  return systemActionResult?.actionType === INTENT_TYPES.START_LOOP
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

  if (systemActionResult.actionType === INTENT_TYPES.RESUME_FINALIZATION) {
    return {
      ...baseFollowUp,
      workflow: "research_analysis_resume",
      semanticWorkflow: inferSemanticWorkflow("research_analysis_resume"),
      finalizationTaskType: systemActionResult.finalizationTaskType || "research_analysis",
      resumedFromContractId: systemActionResult.resumedFromContractId || null,
      resumeAttempt: Number(systemActionResult.resumeAttempt || 0) || null,
      previousTerminalStatus: systemActionResult.previousTerminalStatus || null,
      resumeInstruction: systemActionResult.resumeInstruction || null,
      returnArtifactType: ARTIFACT_TYPES.RESEARCH_CONCLUSION,
      semanticReturnArtifactType: ARTIFACT_TYPES.WORKFLOW_CONCLUSION,
    };
  }

  if (systemActionResult.actionType === INTENT_TYPES.CREATE_TASK) {
    return {
      ...baseFollowUp,
      workflow: DELIVERY_WORKFLOWS.SYSTEM_ACTION_CONTRACT_RESULT,
      semanticWorkflow: inferSemanticWorkflow(DELIVERY_WORKFLOWS.SYSTEM_ACTION_CONTRACT_RESULT),
      childContractId: systemActionResult.contractId || null,
      returnArtifactType: ARTIFACT_TYPES.CONTRACT_RESULT,
    };
  }

  if (systemActionResult.actionType === INTENT_TYPES.ASSIGN_TASK) {
    return {
      ...baseFollowUp,
      workflow: DELIVERY_WORKFLOWS.SYSTEM_ACTION_ASSIGN_TASK_RESULT,
      semanticWorkflow: inferSemanticWorkflow(DELIVERY_WORKFLOWS.SYSTEM_ACTION_ASSIGN_TASK_RESULT),
      delegatedAgentId: systemActionResult.targetAgent || null,
      delegatedContractId: systemActionResult.contractId || null,
      returnArtifactType: ARTIFACT_TYPES.CONTRACT_RESULT,
    };
  }

  if (systemActionResult.actionType === INTENT_TYPES.REQUEST_REVIEW) {
    return {
      ...baseFollowUp,
      workflow: DELIVERY_WORKFLOWS.SYSTEM_ACTION_REVIEW_VERDICT,
      semanticWorkflow: inferSemanticWorkflow(DELIVERY_WORKFLOWS.SYSTEM_ACTION_REVIEW_VERDICT),
      reviewerAgentId: systemActionResult.targetAgent || null,
      reviewMode: systemActionResult.reviewMode || "code_review",
      reviewDomain: systemActionResult.reviewDomain || null,
      reviewArtifactCount: Number(systemActionResult.reviewArtifactCount || 0) || null,
      returnArtifactType: ARTIFACT_TYPES.EVALUATION_VERDICT,
    };
  }

  return baseFollowUp;
}

export function deriveSystemActionTerminalOutcome(systemActionResult, executionObservation) {
  if (!systemActionResult || systemActionResult.status === SYSTEM_ACTION_STATUS.NO_ACTION || isDeferredSystemActionAccepted(systemActionResult)) {
    return null;
  }

  if (hasExecutionObservationPayload(executionObservation)) {
    return null;
  }

  const reason = buildSystemActionFailureReason(systemActionResult);
  if (systemActionResult.status === SYSTEM_ACTION_STATUS.BUSY) {
    const terminalOutcome = normalizeTerminalOutcome({
      status: CONTRACT_STATUS.AWAITING_INPUT,
      reason,
      clarification: `runtime 当前忙碌，可稍后重试: ${reason}`,
      source: "system_action",
      actionType: systemActionResult.actionType || null,
      retryable: true,
    }, {
      terminalStatus: CONTRACT_STATUS.AWAITING_INPUT,
    });
    return {
      terminalOutcome,
      terminalStatus: terminalOutcome.status,
    };
  }

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
