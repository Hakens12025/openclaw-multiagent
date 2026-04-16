// lib/session-bootstrap.js — before_agent_start tracker/bootstrap helpers

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getContractPath, scanPendingContracts, updateContractStatus } from "./contracts.js";
import { agentWorkspace } from "./state.js";
import { readCachedContractSnapshotById, readContractSnapshotByPath } from "./store/contract-store.js";
import { isDirectRequestEnvelope } from "./protocol-primitives.js";
import { buildLifecycleStageTruth } from "./lifecycle-stage-truth.js";
import {
  attachRouteMetadataDiagnostics,
  normalizeRouteMetadata,
} from "./route-metadata.js";
import { ensureRuntimeDirectEnvelopeInbox } from "./runtime-direct-envelope-queue.js";
import { CONTRACT_STATUS, isActiveContractStatus } from "./core/runtime-status.js";
import { normalizeContractIdentity } from "./core/normalize.js";
import { notifyTrackingContractClaim } from "./store/tracker-store.js";
import {
  claimDispatchTargetContract,
  getDispatchTargetCurrentContract,
} from "./routing/dispatch-runtime-state.js";
import {
  deriveCompatibilityPhases,
  deriveCompatibilityTotal,
} from "./task-stage-plan.js";
import { AGENT_ROLE, getAgentIdentitySnapshot } from "./agent/agent-identity.js";
import { listArtifactLaneBindingsForRole } from "./artifact-lane-registry.js";
import { getQQTarget, qqNotify, qqTypingStart } from "./qq.js";

function toTrackingContract(contract, path) {
  const stageTruth = buildLifecycleStageTruth(contract);
  const stagePlan = stageTruth.stagePlan || null;
  const stageRuntime = stageTruth.stageRuntime || null;
  const compatibilityPhases = stagePlan
    ? deriveCompatibilityPhases(stagePlan)
    : (contract.phases || []);
  const compatibilityTotal = stagePlan
    ? deriveCompatibilityTotal(stagePlan)
    : (contract.total || 0);
  const routeMetadata = normalizeRouteMetadata({
    replyTo: contract.replyTo,
    upstreamReplyTo: contract.upstreamReplyTo,
    returnContext: contract.returnContext,
    serviceSession: contract.serviceSession,
    operatorContext: contract.operatorContext,
  }, {
    source: "session_bootstrap.tracking_contract",
  });
  const trackingContract = {
    id: contract.id,
    task: contract.task,
    taskType: contract.taskType || null,
    assignee: contract.assignee || null,
    replyTo: routeMetadata.replyTo,
    upstreamReplyTo: routeMetadata.upstreamReplyTo,
    returnContext: routeMetadata.returnContext,
    coordination: contract.coordination || null,
    conversationId: contract.conversationId || null,
    stagePlan,
    stageRuntime,
    phases: compatibilityPhases,
    total: compatibilityTotal,
    output: contract.output || "",
    completionCriteria: contract.completionCriteria || null,
    codingSpec: contract.codingSpec || null,
    _hardPathResult: contract._hardPathResult || null,
    status: contract.status || null,
    createdAt: contract.createdAt || null,
    updatedAt: contract.updatedAt || null,
    protocol: contract.protocol || null,
    followUp: contract.followUp || null,
    systemActionDelivery: contract.systemActionDelivery || null,
    deliveryTargets: contract.deliveryTargets || null,
    pipelineStage: contract.pipelineStage && typeof contract.pipelineStage === "object"
      ? { ...contract.pipelineStage }
      : null,
    serviceSession: routeMetadata.serviceSession,
    systemActionDeliveryTicket: contract.systemActionDeliveryTicket || null,
    operatorContext: routeMetadata.operatorContext,
    terminalOutcome: contract.terminalOutcome || null,
    executionObservation: contract.executionObservation || null,
    systemAction: contract.systemAction || null,
    runtimeDiagnostics: contract.runtimeDiagnostics || null,
    path,
  };
  attachRouteMetadataDiagnostics(trackingContract, routeMetadata.routeMetadataDiagnostics);
  return trackingContract;
}

export function createTrackingState({ sessionKey, agentId, parentSession }) {
  return {
    sessionKey,
    agentId,
    parentSession,
    startMs: Date.now(),
    toolCalls: [],
    recentToolEvents: [],
    toolCallTotal: 0,
    lastLabel: "启动中",
    status: CONTRACT_STATUS.RUNNING,
    contract: null,
    artifactContext: null,
    activityCursor: null,
    runtimeObservation: null,
    stageProjection: null,
    cursor: "0/0",
    pct: 0,
    estimatedPhase: "",
  };
}

async function ensureDirectRequestInboxEnvelope(agentId, logger) {
  const ws = agentWorkspace(agentId);
  if (!ws) return { active: false };
  return ensureRuntimeDirectEnvelopeInbox({
    inboxDir: join(ws, "inbox"),
    agentId,
    logger,
  });
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

  void qqNotify(qqTarget, `🔧 ${agentId} 开始处理你的任务`);
  qqTypingStart(contract.id, qqTarget);
}

export async function bindPendingWorkerContract({
  agentId,
  sessionKey,
  trackingState,
  logger,
  logContext = "session",
  requiredContractId = null,
}) {
  const directInboxState = await ensureDirectRequestInboxEnvelope(agentId, logger);
  if (directInboxState.active) {
    logger.info(`[watchdog] direct_request present for ${agentId}, skipping shared-contract bind`);
    return null;
  }

  let pending = null;
  const normalizedRequiredContractId = normalizeContractIdentity(requiredContractId);
  const preferredCurrentContractId = normalizedRequiredContractId || getDispatchTargetCurrentContract(agentId);

  if (preferredCurrentContractId) {
    const contract = await readCachedContractSnapshotById(preferredCurrentContractId, {
      contractPathHint: getContractPath(preferredCurrentContractId),
      preferCache: false,
    });
    const path = contract?.id ? getContractPath(contract.id) : getContractPath(preferredCurrentContractId);
    if (
      contract
      && isActiveContractStatus(contract.status)
      && contract.assignee === agentId
    ) {
      pending = { contract, path };
    } else {
      if (normalizedRequiredContractId) {
        logger.info(
          `[watchdog] exact contract ${normalizedRequiredContractId} not claimable for ${agentId}; `
          + `skipping shared-contract scan`,
        );
        return null;
      }
      logger.info(
        `[watchdog] dispatch owner currentContract ${preferredCurrentContractId} not claimable for `
        + `${agentId}; falling back to shared-contract scan`,
      );
    }
  }
  if (!pending) {
    pending = await scanPendingContracts(logger, agentId);
  }
  if (!pending) return null;

  const { contract, path } = pending;
  trackingState.contract = toTrackingContract(contract, path);
  notifyTrackingContractClaim(sessionKey, trackingState.contract.id);
  await updateContractStatus(path, CONTRACT_STATUS.RUNNING, logger);
  await claimDispatchTargetContract({ contractId: contract.id, agentId, logger });
  notifyDispatchTargetClaim(agentId, contract);
  logger.info(`[watchdog] bound contract ${contract.id} to ${logContext} ${sessionKey}`);

  return { contract, path, trackingContract: trackingState.contract };
}

export async function bindDirectInboxEnvelope({
  agentId,
  trackingState,
  logger,
}) {
  return bindInboxContractEnvelope({
    agentId,
    trackingState,
    logger,
    allowNonDirectRequest: false,
  });
}

async function resolveTrackingEnvelopeBinding(contract, fallbackPath) {
  if (!contract?.id || isDirectRequestEnvelope(contract)) {
    return {
      contract,
      path: fallbackPath,
    };
  }

  const sharedPath = getContractPath(contract.id);
  if (!sharedPath || sharedPath === fallbackPath) {
    return {
      contract,
      path: fallbackPath,
    };
  }

  try {
    const sharedContract = await readContractSnapshotByPath(sharedPath, { preferCache: false });
    if (sharedContract?.id === contract.id) {
      return {
        contract: sharedContract,
        path: sharedPath,
      };
    }
  } catch {}

  return {
    contract,
    path: fallbackPath,
  };
}

function isCanonicalSharedContractBinding(contractId, bindingPath) {
  const sharedPath = contractId ? getContractPath(contractId) : null;
  if (!sharedPath || !bindingPath) {
    return false;
  }
  return resolve(sharedPath) === resolve(bindingPath);
}

export async function bindInboxContractEnvelope({
  agentId,
  trackingState,
  logger,
  allowNonDirectRequest = false,
  requiredContractId = null,
}) {
  if (!trackingState || trackingState.contract) return null;

  const ws = agentWorkspace(agentId);
  if (!ws) return null;

  const contractPath = join(ws, "inbox", "contract.json");
  try {
    await ensureDirectRequestInboxEnvelope(agentId, logger);
    const contract = await readContractSnapshotByPath(contractPath, { preferCache: false });
    const normalizedRequiredContractId = normalizeContractIdentity(requiredContractId);
    const isDirectRequest = isDirectRequestEnvelope(contract);
    if (
      normalizedRequiredContractId
      && !isDirectRequest
      && normalizeContractIdentity(contract?.id) !== normalizedRequiredContractId
    ) {
      logger.info(
        `[watchdog] skipped inbox contract ${contract?.id || "unknown"} for ${trackingState.sessionKey}; `
        + `required ${normalizedRequiredContractId}`,
      );
      return null;
    }
    if (!isDirectRequest && allowNonDirectRequest !== true) {
      return null;
    }
    if (!isDirectRequest && !isActiveContractStatus(contract?.status)) {
      logger.info(
        `[watchdog] skipped non-active inbox contract ${contract?.id || "unknown"} `
        + `(${contract?.status || "unknown"}) for ${trackingState.sessionKey}`,
      );
      return null;
    }

    const binding = await resolveTrackingEnvelopeBinding(contract, contractPath);
    trackingState.contract = toTrackingContract(binding.contract, binding.path);
    if (
      !isDirectRequest
      && isCanonicalSharedContractBinding(contract?.id, binding.path)
      && trackingState.contract?.status !== CONTRACT_STATUS.RUNNING
    ) {
      await updateContractStatus(binding.path, CONTRACT_STATUS.RUNNING, logger);
      binding.contract.status = CONTRACT_STATUS.RUNNING;
      trackingState.contract.status = CONTRACT_STATUS.RUNNING;
    }
    notifyTrackingContractClaim(trackingState.sessionKey, trackingState.contract.id);
    logger.info(
      `[watchdog] bound ${isDirectRequest ? "direct inbox" : "inbox"} envelope `
      + `${contract.id} to ${trackingState.sessionKey}`,
    );
    return { contract, path: contractPath, trackingContract: trackingState.contract };
  } catch {
    return null;
  }
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
