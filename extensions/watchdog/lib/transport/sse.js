// lib/sse.js — SSE broadcast and progress payload builders

import { sseClients } from "../state.js";
import { getEnvelopeType } from "../protocol-primitives.js";
import { buildLifecycleStageTruth } from "../lifecycle-stage-truth.js";
import { resolveTrackingWorkItem } from "../tracking-work-item.js";

export function addSseClient(response) {
  if (!response) return;
  sseClients.add(response);
}

export function removeSseClient(response) {
  if (!response) return false;
  return sseClients.delete(response);
}

export function getSseClientCount() {
  return sseClients.size;
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      if (res.finished || res.destroyed) { removeSseClient(res); continue; }
      res.write(payload);
    } catch { removeSseClient(res); }
  }
}

export function buildProgressPayload(t) {
  const workItem = resolveTrackingWorkItem(t);
  const contract = t.contract || null;
  const stageProjection = t.stageProjection || null;
  const stageTruth = buildLifecycleStageTruth(contract);
  const stagePlan = stageTruth.stagePlan || null;
  const stageRuntime = stageTruth.stageRuntime || null;
  const phases = stagePlan
    ? stageTruth.phases
    : (Array.isArray(stageProjection?.stagePlan) ? stageProjection.stagePlan : null);
  const total = stagePlan
    ? stageTruth.total
    : (Number.isFinite(stageProjection?.total) ? stageProjection.total : null);
  return {
    sessionKey: t.sessionKey,
    workItemId: workItem.id || null,
    workItemKind: workItem.kind || null,
    agentId: t.agentId,
    parentSession: t.parentSession,
    status: t.status,
    lastLabel: t.lastLabel,
    recentToolEvents: Array.isArray(t.recentToolEvents)
      ? t.recentToolEvents.map((entry) => ({ ...entry }))
      : [],
    activityCursor: t.activityCursor || null,
    runtimeObservation: t.runtimeObservation || null,
    toolCallCount: t.toolCallTotal,
    elapsedMs: Date.now() - t.startMs,
    hasContract: workItem.hasContract,
    contractId: contract?.id || null,
    task: workItem.task || null,
    taskType: workItem.taskType || null,
    assignee: workItem.assignee || t.agentId || null,
    replyTo: workItem.replyTo || null,
    upstreamReplyTo: workItem.upstreamReplyTo || null,
    createdAt: workItem.createdAt || t.startMs || null,
    updatedAt: workItem.updatedAt || null,
    protocol: workItem.protocol || null,
    protocolEnvelope: contract ? getEnvelopeType(contract) : (workItem.protocolEnvelope || null),
    coordination: workItem.coordination || null,
    returnContext: workItem.returnContext || null,
    serviceSession: workItem.serviceSession || null,
    operatorContext: workItem.operatorContext || null,
    followUp: workItem.followUp || null,
    systemActionDelivery: workItem.systemActionDelivery || null,
    systemActionDeliveryTicket: workItem.systemActionDeliveryTicket || null,
    terminalOutcome: workItem.terminalOutcome || null,
    executionObservation: workItem.executionObservation || null,
    systemAction: workItem.systemAction || null,
    runtimeDiagnostics: workItem.runtimeDiagnostics || null,
    artifactKind: workItem.artifactKind || null,
    artifactDomain: workItem.artifactDomain || null,
    artifactSource: workItem.artifactSource || null,
    artifactRequest: workItem.artifactRequest || null,
    cursor: t.cursor ?? null,
    pct: Number.isFinite(t.pct) ? t.pct : null,
    estimatedPhase: t.estimatedPhase || null,
    stageProjection,
    stagePlan,
    stageRuntime,
    phases,
    total,
    ts: Date.now(),
  };
}
