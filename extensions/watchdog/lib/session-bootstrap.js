// lib/session-bootstrap.js — before_agent_start tracker/bootstrap helpers
// Implementation split into:
//   session-tracking-state.js  (createTrackingState, refreshTrackingInputIoObservation, toTrackingContract)
//   session-contract-binding.js (bindPendingWorkerContract, bindDirectInboxEnvelope, bindInboxContractEnvelope)

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachRouteMetadataDiagnostics,
  normalizeRouteMetadata,
} from "./route-metadata.js";
import { agentWorkspace } from "./state.js";
import { AGENT_ROLE, getAgentIdentitySnapshot } from "./agent/agent-identity.js";
import { listArtifactLaneBindingsForRole } from "./artifact-lane-registry.js";
import { getQQTarget, qqNotify, qqTypingStart, hasQQPassiveReplyTarget } from "./channel-notify.js";

export {
  createTrackingState,
  refreshTrackingInputIoObservation,
  toTrackingContract,
} from "./session-tracking-state.js";

export {
  bindPendingWorkerContract,
  bindDirectInboxEnvelope,
  bindInboxContractEnvelope,
} from "./session-contract-binding.js";

function trimSingleLine(value, limit = 72) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

export function buildDispatchTargetClaimMessage(agentId, contract) {
  const normalizedAgentId = trimSingleLine(agentId, 40) || "agent";
  const contractId = trimSingleLine(contract?.id, 64) || "unknown contract";
  const title = trimSingleLine(contract?.task || contract?.title || contract?.objective, 72);
  return [
    `🔧 ${normalizedAgentId} 开始处理 ${contractId}`,
    title ? `标题：${title}` : null,
  ].filter(Boolean).join("\n");
}

function notifyDispatchTargetClaim(agentId, contract) {
  const identity = getAgentIdentitySnapshot(agentId);
  if (identity.role !== AGENT_ROLE.EXECUTOR) {
    return;
  }

  const qqTarget = getQQTarget(contract);
  if (!qqTarget) {
    return;
  }
  if (hasQQPassiveReplyTarget(qqTarget)) {
    return;
  }

  void qqNotify(qqTarget, buildDispatchTargetClaimMessage(agentId, contract));
  qqTypingStart(contract.id, qqTarget);
}

function normalizeArtifactContext(kind, path, payload) {
  const routeMetadata = normalizeRouteMetadata({
    replyTo: payload?.replyTo,
    upstreamReplyTo: payload?.upstreamReplyTo,
    returnContext: payload?.returnContext,
    serviceSession: payload?.serviceSession,
    operatorContext: payload?.operatorContext,
  }, {
    source: `session_bootstrap.artifact_context:${kind}`,
  });
  const artifactContext = {
    kind,
    path,
    protocol: payload?.protocol && typeof payload.protocol === "object" ? payload.protocol : null,
    replyTo: routeMetadata.replyTo,
    upstreamReplyTo: routeMetadata.upstreamReplyTo,
    coordination: payload?.coordination && typeof payload.coordination === "object"
      ? payload.coordination
      : null,
    source: payload?.source && typeof payload.source === "object" ? payload.source : null,
    request: payload?.request && typeof payload.request === "object" ? payload.request : null,
    serviceSession: routeMetadata.serviceSession,
    returnContext: routeMetadata.returnContext,
    systemActionDeliveryTicket: payload?.systemActionDeliveryTicket && typeof payload.systemActionDeliveryTicket === "object"
      ? payload.systemActionDeliveryTicket
      : null,
    operatorContext: routeMetadata.operatorContext,
    domain: typeof payload?.domain === "string" ? payload.domain : null,
    runtimeDiagnostics: null,
  };
  attachRouteMetadataDiagnostics(artifactContext, routeMetadata.routeMetadataDiagnostics);
  return artifactContext;
}

export async function bindInboxArtifactContext({
  agentId,
  trackingState,
  logger,
}) {
  if (!trackingState || trackingState.artifactContext) return null;
  const identity = getAgentIdentitySnapshot(agentId);
  const artifactBindings = listArtifactLaneBindingsForRole(identity.role);
  if (artifactBindings.length === 0) {
    return null;
  }
  const ws = agentWorkspace(agentId);
  if (!ws) return null;

  const inboxDir = join(ws, "inbox");

  for (const binding of artifactBindings) {
    const artifactPath = join(inboxDir, binding.fileName);
    try {
      const raw = await readFile(artifactPath, "utf8");
      const payload = JSON.parse(raw);
      const artifactContext = normalizeArtifactContext(binding.kind, artifactPath, payload);
      trackingState.artifactContext = artifactContext;
      logger.info(
        `[watchdog] bound artifact inbox ${binding.fileName} to ${trackingState.sessionKey}`,
      );
      return artifactContext;
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      logger.warn?.(
        `[watchdog] failed to bind artifact inbox ${binding.fileName} for ${agentId}: ${error.message}`,
      );
      return null;
    }
  }

  return null;
}

