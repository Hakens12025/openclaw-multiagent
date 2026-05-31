// delivery-system-action-ticket-route.js — route normalization for delivery tickets
//
// Pure normalization helpers. No I/O, no store access.
// Leaf module — no imports from other routing modules.

import {
  normalizeReplyTarget,
  normalizeReturnContext,
} from "../coordination-primitives.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";
import {
  normalizeServiceSession,
  resolveResumableServiceSession,
  resolveServiceSessionTargetSessionKey,
} from "../service-session.js";

export function normalizeSystemActionDeliveryTicketRef(value) {
  if (typeof value === "string" && value.trim()) {
    return { id: value.trim() };
  }

  const record = normalizeRecord(value, null);
  const id = normalizeString(record?.id);
  if (!id) {
    return null;
  }

  return {
    id,
    lane: normalizeString(record?.lane),
    createdAt: Number.isFinite(record?.createdAt) ? record.createdAt : null,
    intentType: normalizeString(record?.intentType),
    sourceAgentId: normalizeString(record?.sourceAgentId),
    sourceSessionKey: normalizeString(record?.sourceSessionKey),
    sourceContractId: normalizeString(record?.sourceContractId),
    status: normalizeString(record?.status),
  };
}

export function buildNormalizedRoute({
  replyTo,
  upstreamReplyTo = null,
  serviceSession = null,
  returnContext = null,
  sourceSessionKey = null,
} = {}) {
  const normalizedReplyTo = normalizeReplyTarget(replyTo);
  const normalizedUpstreamReplyTo = normalizeReplyTarget(upstreamReplyTo);
  const normalizedServiceSession = normalizeServiceSession(serviceSession);
  const targetAgent = normalizedReplyTo?.agentId || null;
  const resumableServiceSession = resolveResumableServiceSession(normalizedServiceSession, {
    agentId: targetAgent,
  }) || normalizedServiceSession;
  const normalizedReturnContext = normalizeReturnContext(returnContext);
  const targetSessionKey = resolveServiceSessionTargetSessionKey(
    resumableServiceSession,
    sourceSessionKey
      || normalizedReturnContext?.sourceSessionKey
      || normalizedReplyTo?.sessionKey
      || null,
  );
  const effectiveReturnContext = normalizeReturnContext({
    ...(normalizedReturnContext || {}),
    ...(targetSessionKey ? { sourceSessionKey: targetSessionKey } : {}),
  });

  return {
    replyTo: normalizedReplyTo,
    upstreamReplyTo: normalizedUpstreamReplyTo,
    serviceSession: resumableServiceSession,
    returnContext: effectiveReturnContext,
    targetAgent,
    targetSessionKey,
  };
}

export function normalizeSystemActionDeliveryTicketEntry(value) {
  const entry = normalizeRecord(value, null);
  const id = normalizeString(entry?.id);
  if (!id) {
    return null;
  }

  const source = normalizeRecord(entry.source, {});
  const route = buildNormalizedRoute({
    replyTo: entry.route?.replyTo,
    upstreamReplyTo: entry.route?.upstreamReplyTo,
    serviceSession: entry.route?.serviceSession,
    returnContext: entry.route?.returnContext,
    sourceSessionKey: source.sessionKey || null,
  });

  return {
    id,
    lane: normalizeString(entry.lane) || null,
    intentType: normalizeString(entry.intentType) || null,
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now(),
    status: normalizeString(entry.status) || "active",
    source: {
      agentId: normalizeString(source.agentId) || null,
      sessionKey: normalizeString(source.sessionKey) || route.targetSessionKey || null,
      contractId: normalizeString(source.contractId) || null,
    },
    route,
    metadata: normalizeRecord(entry.metadata, null),
    resolvedAt: Number.isFinite(entry.resolvedAt) ? entry.resolvedAt : null,
    resolvedByAgentId: normalizeString(entry.resolvedByAgentId) || null,
    resolvedByContractId: normalizeString(entry.resolvedByContractId) || null,
  };
}
