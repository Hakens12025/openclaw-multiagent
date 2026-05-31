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
  mergeLifecycleSnapshot,
  normalizeLifecycleWorkItemId,
  normalizeLifecycleString,
  normalizeLifecycleReplyAgent,
  isCanonicalLifecycleWorkItem,
  historyEntryToLifecycleSnapshot,
  trackingStateToLifecycleSnapshot,
  withLifecycleStageTruth,
  getTaskHistorySnapshot,
} from "./contract-lifecycle-builders.js";

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

export async function listLifecycleWorkItems() {
  const merged = new Map();

  for (const entry of await listSharedContractEntries()) {
    const contract = entry?.contract;
    const id = normalizeLifecycleWorkItemId(contract?.id);
    if (!id) continue;
    merged.set(id, mergeLifecycleSnapshot(merged.get(id), normalizeLifecycleRouteSnapshot({
      ...contract,
      id,
      ioObservation: contract?.runtimeDiagnostics?.ioObservation || null,
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
