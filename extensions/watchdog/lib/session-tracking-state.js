// Tracking state creation and contract-shape normalization for session bootstrap.
// Exports: createTrackingState, refreshTrackingInputIoObservation, toTrackingContract

import { randomBytes } from "node:crypto";
import {
  attachRouteMetadataDiagnostics,
  normalizeRouteMetadata,
} from "./route-metadata.js";
import { CONTRACT_STATUS } from "./core/runtime-status.js";
import { buildLifecycleStageTruth } from "./lifecycle-stage-truth.js";
import {
  deriveDisplayPhases,
  deriveDisplayTotal,
} from "./task-stage-plan.js";
import { buildInputIoObservation, mergeIoObservation } from "./io-observation.js";

export function toTrackingContract(contract, path) {
  const stageTruth = buildLifecycleStageTruth(contract);
  const stagePlan = stageTruth.stagePlan || null;
  const stageRuntime = stageTruth.stageRuntime || null;
  const displayPhases = stagePlan
    ? deriveDisplayPhases(stagePlan)
    : (contract.phases || []);
  const displayTotal = stagePlan
    ? deriveDisplayTotal(stagePlan)
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
    phases: displayPhases,
    total: displayTotal,
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

export function createTrackingState({ sessionKey, agentId, parentSession, runId = null, executionPolicy = null }) {
  return {
    sessionKey,
    agentId,
    parentSession,
    runId: runId || randomBytes(6).toString("hex"),
    executionPolicy,
    startMs: Date.now(),
    toolCalls: [],
    recentToolEvents: [],
    toolCallTotal: 0,
    outputBytesTotal: 0, // FIX(A4-output-length-stop): cumulative tool-output byte counter for the output-budget hard-stop
    lastLabel: "启动中",
    status: CONTRACT_STATUS.RUNNING,
    contract: null,
    artifactContext: null,
    activityCursor: null,
    runtimeObservation: null,
    ioObservation: null,
    stageProjection: null,
    cursor: "0/0",
    pct: 0,
    estimatedPhase: "",
  };
}

export function refreshTrackingInputIoObservation(trackingState, agentId, observedAt = Date.now()) {
  if (!trackingState || typeof trackingState !== "object") {
    return null;
  }
  const inputObservation = buildInputIoObservation({
    trackingState,
    agentId,
    observedAt,
  });
  if (!inputObservation) {
    return trackingState.ioObservation || null;
  }
  trackingState.ioObservation = mergeIoObservation(trackingState.ioObservation, inputObservation);
  return trackingState.ioObservation;
}
