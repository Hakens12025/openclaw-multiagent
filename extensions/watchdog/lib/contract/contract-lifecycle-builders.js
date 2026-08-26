// lib/contract/contract-lifecycle-builders.js — Snapshot construction helpers for lifecycle assembly

import { getEnvelopeType } from "../protocol/protocol-primitives.js";
import {
  isTerminalContractStatus,
  isActiveContractStatus,
} from "../core/runtime-status.js";
import {
  deriveDisplayPhases,
  deriveDisplayTotal,
} from "../stage/task-stage-plan.js";
import { buildLifecycleStageTruth } from "../stage/lifecycle-stage-truth.js";
import { resolveTrackingWorkItem } from "./tracking-work-item.js";

export function hasLifecycleValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function mergeLifecycleSnapshot(existing, patch) {
  const next = { ...(existing || {}) };
  const existingUpdatedAt = Number.isFinite(existing?.updatedAt) ? existing.updatedAt : null;
  const patchUpdatedAt = Number.isFinite(patch?.updatedAt) ? patch.updatedAt : null;
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    if (
      key === "status"
      && isTerminalContractStatus(next.status)
      && isActiveContractStatus(value)
      && existingUpdatedAt != null
      && patchUpdatedAt != null
      && existingUpdatedAt >= patchUpdatedAt
    ) {
      continue;
    }
    if (["task", "assignee", "taskType", "protocolEnvelope"].includes(key) && !hasLifecycleValue(value)) {
      continue;
    }
    if (["replyTo", "upstreamReplyTo", "followUp", "systemActionDelivery", "systemActionDeliveryTicket", "terminalOutcome", "executionObservation", "systemAction", "runtimeDiagnostics", "coordination", "returnContext", "serviceSession", "protocol", "operatorContext", "deliveryTargets", "stageRuntime"].includes(key)
      && value === null
      && hasLifecycleValue(next[key])) {
      continue;
    }
    if ((key === "createdAt" || key === "updatedAt" || key === "elapsedMs" || key === "pct" || key === "total")
      && !Number.isFinite(value)
      && Number.isFinite(next[key])) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function normalizeLifecycleWorkItemId(candidate) {
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  return null;
}

export function normalizeLifecycleString(candidate) {
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  return null;
}

export function normalizeLifecycleReplyAgent(replyTarget) {
  if (!replyTarget) return null;
  if (typeof replyTarget === "string") {
    return normalizeLifecycleString(replyTarget);
  }
  if (typeof replyTarget === "object") {
    return normalizeLifecycleString(replyTarget.agentId);
  }
  return null;
}

export function isCanonicalLifecycleWorkItem(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }
  if (snapshot.hasContract === true) {
    return true;
  }
  if (normalizeLifecycleString(snapshot.workItemKind)) {
    return true;
  }
  if (normalizeLifecycleString(snapshot.task)) {
    return true;
  }
  return normalizeLifecycleString(snapshot.id)?.startsWith("TC-") === true;
}

function deriveProjectionPhases(stageProjection) {
  const labels = Array.isArray(stageProjection?.stagePlan)
    ? stageProjection.stagePlan.filter((label) => typeof label === "string" && label.trim())
    : [];
  return labels.length > 0 ? labels : undefined;
}

function deriveProjectionTotal(stageProjection, phases) {
  if (Number.isFinite(stageProjection?.total)) {
    return stageProjection.total;
  }
  if (Array.isArray(phases) && phases.length > 0) {
    return phases.length;
  }
  return undefined;
}

export function buildLifecycleSnapshotFromWorkItem({
  id,
  workItem,
  status,
  stageProjection = null,
  stagePlan = null,
  stageRuntime = null,
  lastLabel = null,
  recentToolEvents = undefined,
  activityCursor = null,
  runtimeObservation = null,
  ioObservation = null,
  pct = undefined,
  elapsedMs = undefined,
  createdAt = null,
  updatedAt = null,
  source = null,
}) {
  const allowProjectionCompatibility = workItem?.hasContract !== true;
  const projectionPhases = allowProjectionCompatibility
    ? deriveProjectionPhases(stageProjection)
    : undefined;
  const projectionTotal = allowProjectionCompatibility
    ? deriveProjectionTotal(stageProjection, projectionPhases)
    : undefined;

  return {
    id,
    hasContract: workItem?.hasContract === true,
    workItemKind: workItem?.kind || null,
    task: workItem?.task || null,
    assignee: workItem?.assignee || null,
    replyTo: workItem?.replyTo || null,
    upstreamReplyTo: workItem?.upstreamReplyTo || null,
    status: status || null,
    taskType: workItem?.taskType || null,
    protocol: workItem?.protocol || null,
    protocolEnvelope: workItem?.protocolEnvelope || null,
    coordination: workItem?.coordination || null,
    deliveryTargets: null,
    returnContext: workItem?.returnContext || null,
    serviceSession: workItem?.serviceSession || null,
    operatorContext: workItem?.operatorContext || null,
    followUp: workItem?.followUp || null,
    systemActionDelivery: workItem?.systemActionDelivery || null,
    systemActionDeliveryTicket: workItem?.systemActionDeliveryTicket || null,
    terminalOutcome: workItem?.terminalOutcome || null,
    executionObservation: workItem?.executionObservation || null,
    systemAction: workItem?.systemAction || null,
    runtimeDiagnostics: workItem?.runtimeDiagnostics || null,
    ioObservation: ioObservation || workItem?.ioObservation || null,
    lastLabel,
    recentToolEvents: Array.isArray(recentToolEvents)
      ? recentToolEvents.map((entry) => ({ ...entry }))
      : undefined,
    activityCursor,
    runtimeObservation,
    stageProjection: stageProjection || null,
    stagePlan,
    stageRuntime,
    phases: stagePlan ? undefined : projectionPhases,
    total: stagePlan ? undefined : projectionTotal,
    pct: Number.isFinite(pct) ? pct : undefined,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : undefined,
    createdAt: Number.isFinite(createdAt) ? createdAt : null,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    source,
  };
}

export function trackingStateToLifecycleSnapshot(trackingState) {
  const workItem = resolveTrackingWorkItem(trackingState);
  const contract = trackingState?.contract || null;
  const stageTruth = contract ? buildLifecycleStageTruth(contract) : {};
  const stagePlan = stageTruth.stagePlan || null;
  const stageRuntime = stageTruth.stageRuntime || null;
  const id = normalizeLifecycleWorkItemId(workItem?.id);
  if (!id) return null;

  const snapshot = buildLifecycleSnapshotFromWorkItem({
    id,
    workItem: contract
      ? {
          ...workItem,
          protocolEnvelope: getEnvelopeType(contract),
        }
      : workItem,
    status: trackingState?.status || contract?.status || null,
    stageProjection: trackingState?.stageProjection || null,
    stagePlan,
    stageRuntime,
    lastLabel: trackingState?.lastLabel || null,
    recentToolEvents: trackingState?.recentToolEvents,
    activityCursor: trackingState?.activityCursor || null,
    runtimeObservation: trackingState?.runtimeObservation || null,
    ioObservation: trackingState?.ioObservation || workItem?.ioObservation || null,
    pct: trackingState?.pct,
    elapsedMs: Number.isFinite(trackingState?.startMs) ? Math.max(0, Date.now() - trackingState.startMs) : undefined,
    createdAt: contract?.createdAt || workItem?.createdAt || trackingState?.startMs || null,
    updatedAt: contract?.updatedAt || workItem?.updatedAt || Date.now(),
    source: "tracker",
  });

  if (stagePlan) {
    snapshot.phases = stageTruth.phases || deriveDisplayPhases(stagePlan);
    snapshot.total = stageTruth.total || deriveDisplayTotal(stagePlan);
    snapshot.deliveryTargets = contract?.deliveryTargets || null;
  }

  return snapshot;
}

export function withLifecycleStageTruth(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return snapshot;
  }

  const stageTruth = buildLifecycleStageTruth({
    id: snapshot.id,
    stagePlan: snapshot.stagePlan,
    stageRuntime: snapshot.stageRuntime,
    phases: snapshot.phases,
  });
  const stagePlan = stageTruth.stagePlan;
  if (!stagePlan) {
    return snapshot;
  }

  return {
    ...snapshot,
    stagePlan,
    stageRuntime: stageTruth.stageRuntime || null,
    phases: stageTruth.phases || deriveDisplayPhases(stagePlan),
    total: stageTruth.total || deriveDisplayTotal(stagePlan),
  };
}
