import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_TYPES, INTENT_TYPES } from "../protocol-primitives.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { agentWorkspace } from "../state.js";
import { buildSystemActionDeliveryResult } from "./delivery-result.js";
import { inferSemanticWorkflow } from "../runtime-workflow-semantics.js";
import { normalizeString } from "../core/normalize.js";
import {
  applySystemActionDeliverySemantics,
  DELIVERY_WORKFLOWS,
  SYSTEM_ACTION_DELIVERY_IDS,
} from "./delivery-protocols.js";
import { resolvePreferredExecutorAgentId } from "../agent/agent-identity.js";
import {
  buildSystemActionDeliveryContext,
  createSystemActionDeliveryContract,
  enqueueSystemActionDeliveryContract,
  hasLegacySystemActionDeliveryRoute,
  mergeSystemActionDeliverySource,
  resolveSystemActionDeliveryRoute,
} from "./delivery-system-action-helpers.js";
import {
  hasSystemActionDeliveryTicket,
  markSystemActionDeliveryTicketResolved,
} from "./delivery-system-action-ticket.js";

function formatIssues(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return "无";
  return issues
    .slice(0, 5)
    .map((issue, index) => {
      const severity = issue?.severity ? `[${issue.severity}] ` : "";
      const line = issue?.line ? ` (${issue.line})` : "";
      return `${index + 1}. ${severity}${issue?.description || "未给出描述"}${line}`;
    })
    .join("\n");
}

function buildVerdictTask(verdict, artifactContext) {
  const defaultExecutorId = resolvePreferredExecutorAgentId();
  const reviewState = verdict?.verdict === "approve" ? "已通过" : "未通过";
  const nextAction = verdict?.verdict === "approve"
    ? "请基于审查结论整理最终回复，并说明通过点。"
    : "请先根据审查意见修正实现，再向原调用方回复。";

  return [
    `reviewer 已完成代码审查，结论：${reviewState}。`,
    nextAction,
    "",
    `feedback: ${verdict?.feedback || "无"}`,
    verdict?.rework_target || defaultExecutorId ? `rework_target: ${verdict?.rework_target || defaultExecutorId}` : null,
    `issues:`,
    formatIssues(verdict?.issues),
    "",
    artifactContext?.request?.instruction ? `原审查指令: ${artifactContext.request.instruction}` : null,
  ].filter(Boolean).join("\n");
}

export function isRequestReviewArtifactContext(trackingState) {
  return trackingState?.artifactContext?.kind === "code_review"
    && trackingState?.artifactContext?.protocol?.source === INTENT_TYPES.REQUEST_REVIEW;
}

export async function deliveryRunSystemActionReviewVerdict({
  trackingState,
  executionObservation,
  api,
  logger,
}) {
  if (!isRequestReviewArtifactContext(trackingState) || !executionObservation?.reviewVerdict) {
    return buildSystemActionDeliveryResult({ deliveryId: SYSTEM_ACTION_DELIVERY_IDS.REVIEW_VERDICT });
  }

  const artifactContext = trackingState.artifactContext;
  const routeSource = mergeSystemActionDeliverySource(artifactContext);
  const route = await resolveSystemActionDeliveryRoute(routeSource);

  if (!route.replyTo?.agentId) {
    logger.warn("[system_action_review_delivery] missing source reply target for request_review verdict");
    return buildSystemActionDeliveryResult({
      deliveryId: SYSTEM_ACTION_DELIVERY_IDS.REVIEW_VERDICT,
      error: "missing_source_reply_target",
    });
  }

  if (
    !hasSystemActionDeliveryTicket(routeSource.systemActionDeliveryTicket)
    && !hasLegacySystemActionDeliveryRoute(routeSource)
  ) {
    logger.warn("[system_action_review_delivery] request_review verdict has no upstream reply target");
    return buildSystemActionDeliveryResult({
      deliveryId: SYSTEM_ACTION_DELIVERY_IDS.REVIEW_VERDICT,
      error: "missing_upstream_reply_target_or_resumable_session",
    });
  }

  const targetAgent = route.targetAgent || route.replyTo?.agentId;
  const targetSessionKey = route.targetSessionKey;
  const reviewerAgentId = normalizeString(artifactContext?.coordination?.ownerAgentId)
    || normalizeString(trackingState?.agentId)
    || null;
  if (!reviewerAgentId) {
    logger.warn("[system_action_review_delivery] missing reviewer agent for request_review verdict return");
    return buildSystemActionDeliveryResult({
      deliveryId: SYSTEM_ACTION_DELIVERY_IDS.REVIEW_VERDICT,
      error: "missing_reviewer_agent",
    });
  }
  const contract = createSystemActionDeliveryContract({
    targetAgent,
    replyTo: route.replyTo || routeSource.replyTo,
    upstreamReplyTo: route.upstreamReplyTo || routeSource.upstreamReplyTo,
    serviceSession: route.serviceSession,
    targetSessionKey,
    returnContext: buildSystemActionDeliveryContext(routeSource, {
      targetSessionKey,
      defaultIntentType: INTENT_TYPES.REQUEST_REVIEW,
    }),
    operatorContext: routeSource.operatorContext,
    message: buildVerdictTask(executionObservation.reviewVerdict, artifactContext),
    source: INTENT_TYPES.REQUEST_REVIEW,
  });

  contract.reviewVerdict = executionObservation.reviewVerdict;
  contract.reviewerResult = executionObservation.reviewerResult;
  contract.systemActionDelivery = {
    workflow: DELIVERY_WORKFLOWS.SYSTEM_ACTION_REVIEW_VERDICT,
    semanticWorkflow: inferSemanticWorkflow(DELIVERY_WORKFLOWS.SYSTEM_ACTION_REVIEW_VERDICT),
    artifactType: ARTIFACT_TYPES.EVALUATION_VERDICT,
    originIntentType: INTENT_TYPES.REQUEST_REVIEW,
    originSourceAgentId: routeSource.sourceAgentId || null,
    originSourceContractId: routeSource.sourceContractId || null,
    reviewerAgentId: reviewerAgentId,
    reviewMode: "code_review",
    reviewDomain: artifactContext.domain || null,
    deliveryTicketId: route.ticketId || null,
  };
  contract.reviewContext = {
    domain: artifactContext.domain || null,
    sourceAgentId: routeSource.sourceAgentId || null,
    sourceContractId: routeSource.sourceContractId || null,
  };

  const { wake } = await enqueueSystemActionDeliveryContract({
    lane: SYSTEM_ACTION_DELIVERY_IDS.REVIEW_VERDICT,
    targetAgent,
    contract,
    api,
    logger,
    wakeReason: "request_review verdict ready from reviewer",
    targetSessionKey,
    failureAlert: {
      source: reviewerAgentId,
    },
    queuedLogMessage: `[system_action_review_delivery] queued reviewer verdict for ${targetAgent}; active inbox contract remains in place`,
  });
  await markSystemActionDeliveryTicketResolved(routeSource.systemActionDeliveryTicket, {
    resolvedByAgentId: targetAgent,
    resolvedByContractId: contract.id,
  });
  await unlink(artifactContext.path).catch(() => {});
  await unlink(join(agentWorkspace(reviewerAgentId), "outbox", "code_verdict.json")).catch(() => {});

  broadcast("alert", {
    type: EVENT_TYPE.SYSTEM_ACTION_REVIEW_VERDICT_DELIVERED,
    source: reviewerAgentId,
    targetAgent,
    verdict: executionObservation.reviewVerdict.verdict || null,
    contractId: contract.id,
    ts: Date.now(),
  });

  logger.info(`[system_action_review_delivery] reviewer verdict routed back to ${targetAgent}`);
  return applySystemActionDeliverySemantics(buildSystemActionDeliveryResult({
    deliveryId: SYSTEM_ACTION_DELIVERY_IDS.REVIEW_VERDICT,
    handled: true,
    targetAgent,
    contractId: contract.id,
    workflow: contract.systemActionDelivery?.workflow || null,
    artifactType: ARTIFACT_TYPES.EVALUATION_VERDICT,
    semanticWorkflow: inferSemanticWorkflow(contract.systemActionDelivery?.workflow || DELIVERY_WORKFLOWS.SYSTEM_ACTION_REVIEW_VERDICT),
    verdict: executionObservation.reviewVerdict.verdict || null,
    reason: route.resolvedBy,
    deliveryTicketId: route.ticketId || null,
    wake,
  }), {
    workflow: contract.systemActionDelivery?.workflow || null,
    deliveryId: SYSTEM_ACTION_DELIVERY_IDS.REVIEW_VERDICT,
  });
}
