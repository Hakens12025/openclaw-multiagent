import {
  deliveryRunSystemActionAssignTaskResult,
  isAssignTaskResultDeliveryCandidate,
  deliveryRunSystemActionContractResult,
  isExecutionContractResultDeliveryCandidate,
} from "./delivery-system-action-contract-result.js";
import { normalizeSystemActionDeliveryDiagnostic } from "../lifecycle/runtime-diagnostics.js";
import { buildSystemActionDeliveryResult } from "../routing/delivery-result.js";
import {
  deliveryRunSystemActionReviewVerdict,
  isRequestReviewArtifactContext,
} from "./delivery-system-action-review-verdict.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { SYSTEM_ACTION_DELIVERY_IDS } from "./delivery-protocols.js";

function defineSystemActionDelivery(definition) {
  return Object.freeze(definition);
}

function shouldRunSystemActionDelivery(handler, context) {
  if (typeof handler.match !== "function") return true;
  return handler.match(context) === true;
}

const SYSTEM_ACTION_DELIVERY_HANDLERS = Object.freeze([
  defineSystemActionDelivery({
    id: SYSTEM_ACTION_DELIVERY_IDS.REVIEW_VERDICT,
    match({ trackingState, executionObservation }) {
      return isRequestReviewArtifactContext(trackingState) && Boolean(executionObservation?.reviewVerdict);
    },
    run: deliveryRunSystemActionReviewVerdict,
  }),
  defineSystemActionDelivery({
    id: SYSTEM_ACTION_DELIVERY_IDS.ASSIGN_TASK_RESULT,
    match({ contractData }) {
      return isAssignTaskResultDeliveryCandidate(contractData);
    },
    run: deliveryRunSystemActionAssignTaskResult,
    suppressCompletionEgress(result) {
      return result?.handled === true;
    },
    suppressReason: "system_action_assign_task_delivery",
  }),
  defineSystemActionDelivery({
    id: SYSTEM_ACTION_DELIVERY_IDS.CONTRACT_RESULT,
    match({ contractData }) {
      return isExecutionContractResultDeliveryCandidate(contractData);
    },
    run: deliveryRunSystemActionContractResult,
    suppressCompletionEgress(result) {
      return result?.handled === true;
    },
    suppressReason: "system_action_contract_delivery",
  }),
]);

export async function deliveryRunSystemActionChain(context) {
  const diagnostics = {};
  const results = {};
  let suppressCompletionEgress = false;
  let suppressCompletionEgressBy = null;

  for (const handler of SYSTEM_ACTION_DELIVERY_HANDLERS) {
    try {
      if (!shouldRunSystemActionDelivery(handler, context)) {
        results[handler.id] = buildSystemActionDeliveryResult({ deliveryId: handler.id });
        continue;
      }
      const result = await handler.run(context);
      const normalizedResult = result || buildSystemActionDeliveryResult({ deliveryId: handler.id });
      results[handler.id] = normalizedResult;
      const diagnostic = normalizeSystemActionDeliveryDiagnostic(normalizedResult, { lane: handler.id });
      if (diagnostic) {
        diagnostics[handler.id] = diagnostic;
      }
      if (!suppressCompletionEgress && handler.suppressCompletionEgress?.(normalizedResult) === true) {
        suppressCompletionEgress = true;
        suppressCompletionEgressBy = handler.suppressReason || handler.id;
      }
    } catch (error) {
      context.logger.warn(`[watchdog] ${handler.id} failed: ${error.message}`);
      broadcast("alert", {
        type: EVENT_TYPE.SYSTEM_ACTION_DELIVERY_FAILED,
        deliveryId: handler.id,
        agentId: context.agentId,
        contractId: context.trackingState?.contract?.id || context.contractData?.id || null,
        error: error.message,
        ts: Date.now(),
      });
      const failedResult = buildSystemActionDeliveryResult({
        deliveryId: handler.id,
        error: error.message,
      });
      diagnostics[handler.id] = normalizeSystemActionDeliveryDiagnostic(failedResult, {
        lane: handler.id,
      });
      results[handler.id] = failedResult;
    }
  }

  return {
    diagnostics,
    results,
    suppressCompletionEgress,
    suppressCompletionEgressBy,
  };
}
