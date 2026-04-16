import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runtimeWakeAgentDetailed } from "../transport/runtime-wake-transport.js";
import {
  buildCoordinationSnapshot,
} from "../coordination-primitives.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { agentWorkspace, atomicWriteFile } from "../state.js";
import { hasRunningTrackingSessionForAgent } from "../store/tracker-store.js";
import {
  deriveDispatchStatusFromWake,
  getWakeError,
  normalizeWakeDiagnostic,
} from "../lifecycle/runtime-diagnostics.js";
import {
  INTENT_TYPES,
  PROTOCOL_VERSION,
} from "../protocol-primitives.js";
import {
  attachSystemActionDeliveryTicket,
} from "../routing/delivery-system-action-ticket.js";
import {
  attachOperatorContext,
} from "../operator/operator-context.js";
import { SYSTEM_ACTION_STATUS } from "../core/runtime-status.js";
import {
  AGENT_ROLE,
  getAgentRole,
  listAgentIdsByRole,
} from "../agent/agent-identity.js";
import { loadGraph, getTransitionsForNode } from "../agent/agent-graph.js";
import { buildReviewContext } from "../review-context-builder.js";
import { getAutomationRuntimeState } from "../automation/automation-runtime.js";
import {
  planCollaborationSystemActionDelivery,
  prepareCollaborationTarget,
} from "../collaboration-policy.js";
import { normalizeString } from "../core/normalize.js";
import { getArtifactLaneDefinition } from "../artifact-lane-registry.js";

const REVIEW_ARTIFACT_LANE = getArtifactLaneDefinition("code_review");
if (!REVIEW_ARTIFACT_LANE) {
  throw new Error("missing artifact lane definition: code_review");
}

function normalizeArtifactEntry(entry, fallbackLabel = "artifact") {
  if (!entry) return null;
  if (typeof entry === "string" && entry.trim()) {
    return { path: entry.trim(), label: fallbackLabel };
  }
  if (typeof entry === "object" && typeof entry.path === "string" && entry.path.trim()) {
    return {
      path: entry.path.trim(),
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : fallbackLabel,
      description: typeof entry.description === "string" ? entry.description : "",
    };
  }
  return null;
}

function collectReviewArtifacts(params, sourceContract) {
  const artifacts = [];

  const addArtifact = (entry, fallbackLabel) => {
    const normalized = normalizeArtifactEntry(entry, fallbackLabel);
    if (!normalized) return;
    if (!artifacts.some((artifact) => artifact.path === normalized.path)) {
      artifacts.push(normalized);
    }
  };

  for (const [index, entry] of (Array.isArray(params?.artifactManifest) ? params.artifactManifest : []).entries()) {
    addArtifact(entry, `artifact_${index + 1}`);
  }

  addArtifact(params?.artifactPath, "primary_artifact");
  addArtifact(sourceContract?.codingSpec?.primaryOutputPath, "primary_output");

  for (const [index, entry] of (Array.isArray(sourceContract?.codingSpec?.outputFiles) ? sourceContract.codingSpec.outputFiles : []).entries()) {
    addArtifact(entry, `coding_output_${index + 1}`);
  }

  addArtifact(sourceContract?.output, "contract_output");
  return artifacts;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hasRunningAgentSession(agentId) {
  return hasRunningTrackingSessionForAgent(agentId);
}

async function reviewerHasPendingRuntimeWork(reviewerAgentId) {
  if (!reviewerAgentId) return false;
  const reviewerInbox = join(agentWorkspace(reviewerAgentId), "inbox");
  const reviewerOutbox = join(agentWorkspace(reviewerAgentId), "outbox");
  return hasRunningAgentSession(reviewerAgentId)
    || await fileExists(join(reviewerInbox, REVIEW_ARTIFACT_LANE.fileName))
    || await fileExists(join(reviewerInbox, "enriched-diagnostics.json"))
    || await fileExists(join(reviewerOutbox, "code_verdict.json"))
    || await fileExists(join(reviewerOutbox, "next_action.json"));
}

async function resolveReviewTargetAgent(sourceAgentId) {
  const normalizedSourceAgentId = normalizeString(sourceAgentId);
  if (!normalizedSourceAgentId) {
    return null;
  }

  const graph = await loadGraph();
  const graphTargets = getTransitionsForNode(graph, normalizedSourceAgentId);
  const reviewerTarget = graphTargets.find((agentId) => getAgentRole(agentId) === AGENT_ROLE.REVIEWER);
  if (reviewerTarget) {
    return reviewerTarget;
  }

  return listAgentIdsByRole(AGENT_ROLE.REVIEWER)[0] || null;
}

export async function systemActionRunRequestReview(normalizedAction, {
  agentId,
  sessionKey,
  contractData,
  api,
  logger,
  actionReplyTo,
}) {
  const upstreamReplyTo = normalizedAction.params?.upstreamReplyTo || contractData?.replyTo || null;

  const collaborationTarget = await prepareCollaborationTarget({
    actionType: normalizedAction.type,
    sourceAgentId: agentId,
    contractData,
    logger,
    resolveTargetAgent: () => resolveReviewTargetAgent(agentId),
    missingTargetError: "request_review requires a reviewer lane in the runtime graph",
    busyCheck: async ({ targetAgent }) => {
      if (!(await reviewerHasPendingRuntimeWork(targetAgent))) {
        return null;
      }
      return {
        status: SYSTEM_ACTION_STATUS.BUSY,
        error: "reviewer currently has pending runtime work",
        logMessage: "reviewer busy, request_review deferred",
      };
    },
  });
  if (!collaborationTarget.ok) {
    return collaborationTarget.result;
  }
  const reviewerAgentId = collaborationTarget.targetAgent;

  const artifactManifest = collectReviewArtifacts(normalizedAction.params, contractData);
  if (artifactManifest.length === 0) {
    logger.info(`[system_action] ${agentId} request_review missing reviewable artifacts`);
    return {
      status: SYSTEM_ACTION_STATUS.INVALID_PARAMS,
      actionType: normalizedAction.type,
      error: "request_review requires at least one artifact path",
    };
  }

  const systemActionDelivery = await planCollaborationSystemActionDelivery({
    actionType: normalizedAction.type,
    intentType: INTENT_TYPES.REQUEST_REVIEW,
    sourceAgentId: agentId,
    sourceSessionKey: sessionKey,
    contractData,
    replyTo: actionReplyTo,
    upstreamReplyTo,
    mode: "required",
    logger,
    requiredRouteError: "request_review currently requires an upstream reply target or resumable service session",
    ticketMetadata: { targetAgent: reviewerAgentId },
  });
  if (!systemActionDelivery.ok) {
    return systemActionDelivery.result;
  }

  const instruction = typeof normalizedAction.params?.instruction === "string" && normalizedAction.params.instruction.trim()
    ? normalizedAction.params.instruction.trim()
    : typeof normalizedAction.params?.message === "string" && normalizedAction.params.message.trim()
      ? normalizedAction.params.message.trim()
      : "请审查当前实现，判断是否可交付；若不通过，请给出具体修改意见。";

  const reviewerInbox = join(agentWorkspace(reviewerAgentId), "inbox");
  await mkdir(reviewerInbox, { recursive: true });

  const reviewRequest = {
    mode: "code_review",
    domain: normalizedAction.params?.domain || contractData?.taskDomain || "generic",
    protocol: {
      version: PROTOCOL_VERSION,
      transport: REVIEW_ARTIFACT_LANE.fileName,
      source: INTENT_TYPES.REQUEST_REVIEW,
      route: "system_action",
      intentType: normalizedAction.type,
    },
    source: {
      agentId,
      sessionKey,
      contractId: contractData?.id || null,
      taskType: contractData?.taskType || null,
      taskDomain: contractData?.taskDomain || null,
    },
    request: {
      instruction,
      reason: normalizedAction.params?.reason || null,
      requestedAt: Date.now(),
    },
    replyTo: actionReplyTo,
    upstreamReplyTo,
    ...(systemActionDelivery.serviceSession ? { serviceSession: systemActionDelivery.serviceSession } : {}),
    returnContext: systemActionDelivery.returnContext,
    coordination: buildCoordinationSnapshot({
      ownerAgentId: reviewerAgentId,
      replyTo: actionReplyTo,
      upstreamReplyTo,
      returnContext: systemActionDelivery.returnContext,
    }),
    validation: normalizedAction.params?.validation && typeof normalizedAction.params.validation === "object"
      ? normalizedAction.params.validation
      : null,
    artifact_manifest: artifactManifest,
  };

  const automationId = contractData?.automationContext?.automationId || null;
  const automationRuntimeState = automationId
    ? await getAutomationRuntimeState(automationId)
    : null;
  reviewRequest.reviewContext = buildReviewContext({
    automationRuntimeState,
    contractContext: contractData?.automationContext || null,
    artifacts: artifactManifest || null,
  });

  attachOperatorContext(reviewRequest, contractData?.operatorContext);
  attachSystemActionDeliveryTicket(reviewRequest, systemActionDelivery.deliveryTicket, {
    targetAgent: reviewerAgentId,
  });

  await atomicWriteFile(
    join(reviewerInbox, REVIEW_ARTIFACT_LANE.fileName),
    JSON.stringify(reviewRequest, null, 2),
  );
  const wake = normalizeWakeDiagnostic(
    await runtimeWakeAgentDetailed(
      reviewerAgentId,
      normalizedAction.params?.reason || `request_review from ${agentId}`,
      api,
      logger,
    ),
    {
      lane: "system_action.request_review",
      targetAgent: reviewerAgentId,
    },
  );
  if (!wake.ok) {
    broadcast("alert", {
      type: EVENT_TYPE.RUNTIME_WAKE_FAILED,
      lane: "system_action.request_review",
      source: agentId,
      targetAgent: reviewerAgentId,
      sourceContractId: contractData?.id || null,
      error: getWakeError(wake) || "wake failed",
      ts: Date.now(),
    });
  }

  broadcast("alert", {
    type: EVENT_TYPE.CODE_REVIEW_REQUESTED,
    source: agentId,
    targetAgent: reviewerAgentId,
    artifactCount: artifactManifest.length,
    sourceContractId: contractData?.id || null,
    ts: Date.now(),
  });
  logger.info(`[system_action] ${agentId} submitted request_review to reviewer`);
  return {
    status: deriveDispatchStatusFromWake(wake),
    actionType: normalizedAction.type,
    targetAgent: reviewerAgentId,
    deferredCompletion: true,
    deliveryTicketId: systemActionDelivery.deliveryTicket?.id || null,
    reviewMode: "code_review",
    reviewDomain: reviewRequest.domain || null,
    reviewArtifactCount: artifactManifest.length,
    wake,
  };
}
