// lib/contract-lifecycle-view.js — Lifecycle snapshot assembly & decoration

import { listTrackingStates } from "./store/tracker-store.js";
import { getEnvelopeType } from "./protocol-primitives.js";
import { listSharedContractEntries } from "./store/contract-store.js";
import { getSystemActionDeliveryTicket } from "./routing/delivery-system-action-ticket.js";
import {
  attachRouteMetadataDiagnostics,
  normalizeRouteMetadata,
} from "./route-metadata.js";
import {
  CONTRACT_STATUS,
  isCompletedContractStatus,
  isActiveContractStatus,
  isTerminalContractStatus,
} from "./core/runtime-status.js";
import {
  deriveCompatibilityPhases,
  deriveCompatibilityTotal,
} from "./task-stage-plan.js";
import { buildLifecycleStageTruth } from "./lifecycle-stage-truth.js";
import { CONTRACTS_DIR } from "./state.js";
import { getTaskHistorySnapshot } from "./store/task-history-store.js";
import { mkdir } from "node:fs/promises";
import {
  resolveProgressWorkItem,
  resolveTrackingWorkItem,
} from "./tracking-work-item.js";

function hasLifecycleValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function mergeLifecycleSnapshot(existing, patch) {
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

function normalizeLifecycleWorkItemId(candidate) {
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  return null;
}

function normalizeLifecycleString(candidate) {
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  return null;
}

function normalizeLifecycleReplyAgent(replyTarget) {
  if (!replyTarget) return null;
  if (typeof replyTarget === "string") {
    return normalizeLifecycleString(replyTarget);
  }
  if (typeof replyTarget === "object") {
    return normalizeLifecycleString(replyTarget.agentId);
  }
  return null;
}

function isCanonicalLifecycleWorkItem(snapshot) {
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

function resolveLifecycleSystemActionDeliveryTicketId(snapshot) {
  return normalizeLifecycleString(snapshot?.systemActionDeliveryTicket?.id)
    || normalizeLifecycleString(snapshot?.followUp?.deliveryTicketId)
    || normalizeLifecycleString(snapshot?.systemActionDelivery?.deliveryTicketId)
    || normalizeLifecycleString(snapshot?.runtimeDiagnostics?.deliveryTicketId)
    || null;
}

function resolveLifecycleSystemActionDeliveryTicketStatus(snapshot, resolvedTicket) {
  return normalizeLifecycleString(resolvedTicket?.status)
    || normalizeLifecycleString(snapshot?.systemActionDeliveryTicket?.status)
    || (resolveLifecycleSystemActionDeliveryTicketId(snapshot) && snapshot?.systemActionDelivery?.deliveryTicketId ? "resolved" : null)
    || (
      resolveLifecycleSystemActionDeliveryTicketId(snapshot)
      && snapshot?.followUp?.mode === "delivery"
        ? "active"
        : null
    )
    || null;
}

function resolveLifecycleSystemActionDeliveryTicketLane(snapshot, resolvedTicket) {
  return normalizeLifecycleString(resolvedTicket?.lane)
    || normalizeLifecycleString(snapshot?.systemActionDeliveryTicket?.lane)
    || normalizeLifecycleString(snapshot?.followUp?.type)
    || normalizeLifecycleString(snapshot?.systemActionDelivery?.originIntentType)
    || normalizeLifecycleString(snapshot?.systemActionDelivery?.workflow)
    || null;
}

function resolveLifecycleSystemActionDeliveryTicketTargetAgent(snapshot, resolvedTicket) {
  return normalizeLifecycleString(resolvedTicket?.route?.targetAgent)
    || normalizeLifecycleString(resolvedTicket?.metadata?.targetAgent)
    || normalizeLifecycleString(snapshot?.returnContext?.sourceAgentId)
    || normalizeLifecycleReplyAgent(snapshot?.upstreamReplyTo)
    || normalizeLifecycleReplyAgent(snapshot?.replyTo)
    || normalizeLifecycleString(snapshot?.systemActionDelivery?.originSourceAgentId)
    || null;
}

async function decorateLifecycleSystemActionDeliveryTicket(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return snapshot;
  }

  const systemActionDeliveryTicketRef = resolveLifecycleSystemActionDeliveryTicketId(snapshot);
  const resolvedTicket = systemActionDeliveryTicketRef
    ? await getSystemActionDeliveryTicket({ id: systemActionDeliveryTicketRef })
    : null;

  return {
    ...snapshot,
    systemActionDeliveryTicket: resolvedTicket
      ? {
          ...(snapshot.systemActionDeliveryTicket && typeof snapshot.systemActionDeliveryTicket === "object"
            ? snapshot.systemActionDeliveryTicket
            : {}),
          ...resolvedTicket,
        }
      : snapshot.systemActionDeliveryTicket || null,
    systemActionDeliveryTicketRef,
    systemActionDeliveryTicketStatus: resolveLifecycleSystemActionDeliveryTicketStatus(snapshot, resolvedTicket),
    systemActionDeliveryTicketLane: resolveLifecycleSystemActionDeliveryTicketLane(snapshot, resolvedTicket),
    systemActionDeliveryTicketTargetAgent: resolveLifecycleSystemActionDeliveryTicketTargetAgent(snapshot, resolvedTicket),
  };
}

function decorateLifecycleRouteMetadataSummary(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return snapshot;
  }

  const droppedFields = (Array.isArray(snapshot?.runtimeDiagnostics?.routeMetadata?.droppedFields)
    ? snapshot.runtimeDiagnostics.routeMetadata.droppedFields
    : [])
    .map((entry) => normalizeLifecycleString(entry?.field))
    .filter(Boolean);

  return {
    ...snapshot,
    replyTargetAgent: normalizeLifecycleReplyAgent(snapshot.replyTo),
    upstreamReplyTargetAgent: normalizeLifecycleReplyAgent(snapshot.upstreamReplyTo),
    returnSourceAgent: normalizeLifecycleString(snapshot?.returnContext?.sourceAgentId) || null,
    returnSourceSessionKey: normalizeLifecycleString(snapshot?.returnContext?.sourceSessionKey)
      || normalizeLifecycleString(snapshot?.serviceSession?.entrySessionKey)
      || null,
    routeDiagnosticsDroppedCount: droppedFields.length,
    routeDiagnosticsDroppedFields: droppedFields.length > 0 ? droppedFields : null,
  };
}

function normalizeLifecycleRouteSnapshot(snapshot, source) {
  if (!snapshot || typeof snapshot !== "object") {
    return snapshot;
  }

  const routeMetadata = normalizeRouteMetadata({
    replyTo: snapshot.replyTo,
    upstreamReplyTo: snapshot.upstreamReplyTo,
    returnContext: snapshot.returnContext,
    serviceSession: snapshot.serviceSession,
    operatorContext: snapshot.operatorContext,
  }, {
    source,
  });

  const normalizedSnapshot = {
    ...snapshot,
    replyTo: routeMetadata.replyTo,
    upstreamReplyTo: routeMetadata.upstreamReplyTo,
    returnContext: routeMetadata.returnContext,
    serviceSession: routeMetadata.serviceSession,
    operatorContext: routeMetadata.operatorContext,
  };
  attachRouteMetadataDiagnostics(normalizedSnapshot, routeMetadata.routeMetadataDiagnostics);
  return normalizedSnapshot;
}

function withLifecycleStageTruth(snapshot) {
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
    phases: stageTruth.phases || deriveCompatibilityPhases(stagePlan),
    total: stageTruth.total || deriveCompatibilityTotal(stagePlan),
  };
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

function buildLifecycleSnapshotFromWorkItem({
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
    lastLabel,
    recentToolEvents: Array.isArray(recentToolEvents)
      ? recentToolEvents.map((entry) => ({ ...entry }))
      : undefined,
    activityCursor,
    runtimeObservation,
    artifactKind: workItem?.artifactKind || null,
    artifactDomain: workItem?.artifactDomain || null,
    artifactSource: workItem?.artifactSource || null,
    artifactRequest: workItem?.artifactRequest || null,
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

function trackingStateToLifecycleSnapshot(trackingState) {
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
    pct: trackingState?.pct,
    elapsedMs: Number.isFinite(trackingState?.startMs) ? Math.max(0, Date.now() - trackingState.startMs) : undefined,
    createdAt: contract?.createdAt || workItem?.createdAt || trackingState?.startMs || null,
    updatedAt: contract?.updatedAt || workItem?.updatedAt || Date.now(),
    source: "tracker",
  });

  if (stagePlan) {
    snapshot.phases = stageTruth.phases || deriveCompatibilityPhases(stagePlan);
    snapshot.total = stageTruth.total || deriveCompatibilityTotal(stagePlan);
    snapshot.deliveryTargets = contract?.deliveryTargets || null;
  }

  return snapshot;
}

function historyEntryToLifecycleSnapshot(entry) {
  if (!entry || typeof entry !== "object") return null;
  const workItem = resolveProgressWorkItem(entry);
  const stageTruth = buildLifecycleStageTruth({
    id: entry.contractId || workItem?.id,
    stagePlan: entry.stagePlan,
    stageRuntime: entry.stageRuntime,
    phases: entry.phases,
  });
  const stagePlan = stageTruth.stagePlan || null;
  const stageRuntime = stageTruth.stageRuntime || null;
  const id = normalizeLifecycleWorkItemId(workItem?.id);
  if (!id) return null;

  const snapshot = buildLifecycleSnapshotFromWorkItem({
    id,
    workItem,
    status: entry.status || null,
    stageProjection: entry.stageProjection || null,
    stagePlan,
    stageRuntime,
    lastLabel: entry.lastLabel || null,
    recentToolEvents: entry.recentToolEvents,
    activityCursor: entry.activityCursor || null,
    runtimeObservation: entry.runtimeObservation || null,
    pct: Number.isFinite(entry.pct) ? entry.pct : (isCompletedContractStatus(entry.status) ? 100 : undefined),
    elapsedMs: entry.elapsedMs,
    createdAt: Number.isFinite(entry.createdAt)
      ? entry.createdAt
      : Number.isFinite(entry.ts) && Number.isFinite(entry.elapsedMs)
        ? Math.max(0, entry.ts - entry.elapsedMs)
        : null,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : entry.endMs || entry.ts || null,
    source: "history",
  });

  if (stagePlan) {
    snapshot.phases = stageTruth.phases || deriveCompatibilityPhases(stagePlan);
    snapshot.total = stageTruth.total || deriveCompatibilityTotal(stagePlan);
    snapshot.deliveryTargets = Array.isArray(entry?.deliveryTargets) ? entry.deliveryTargets : null;
  }

  return snapshot;
}

export async function listLifecycleWorkItems() {
  const merged = new Map();

  for (const entry of await listSharedContractEntries()) {
    const contract = entry?.contract;
    const id = normalizeLifecycleWorkItemId(contract?.id);
    if (!id) continue;
    merged.set(id, mergeLifecycleSnapshot(merged.get(id), normalizeLifecycleRouteSnapshot({
      ...contract,
      id,
      protocolEnvelope: getEnvelopeType(contract),
      source: "snapshot",
    }, "work_items.lifecycle.snapshot")));
  }

  for (const entry of getTaskHistorySnapshot()) {
    const snapshot = normalizeLifecycleRouteSnapshot(
      historyEntryToLifecycleSnapshot(entry),
      "work_items.lifecycle.history",
    );
    if (!snapshot) continue;
    merged.set(snapshot.id, mergeLifecycleSnapshot(merged.get(snapshot.id), snapshot));
  }

  for (const trackingState of listTrackingStates()) {
    const snapshot = normalizeLifecycleRouteSnapshot(
      trackingStateToLifecycleSnapshot(trackingState),
      "work_items.lifecycle.tracker",
    );
    if (!snapshot) continue;
    merged.set(snapshot.id, mergeLifecycleSnapshot(merged.get(snapshot.id), snapshot));
  }

  const decorated = await Promise.all(
    [...merged.values()].map((snapshot) => decorateLifecycleSystemActionDeliveryTicket(snapshot)),
  );

  return decorated
    .map((snapshot) => decorateLifecycleRouteMetadataSummary(withLifecycleStageTruth(snapshot)))
    .filter((snapshot) => isCanonicalLifecycleWorkItem(snapshot))
    .sort((left, right) =>
      (Number(right?.updatedAt) || Number(right?.createdAt) || 0) - (Number(left?.updatedAt) || Number(left?.createdAt) || 0));
}
