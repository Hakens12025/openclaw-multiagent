// pending-signal-registry.js — runtime-owned pending-signal registry.
//
// The registry replaces "gateway agents are always actionable" with explicit,
// source-owned signals. Each signal is keyed by (agentId, sourceKind, sourceRef)
// so repeat registrations from the same source are idempotent. Clearing is
// source-owned: the ingress / envelope / ticket that created the signal also
// clears it on resolve.
//
// Canonical signal kinds:
//   channel_ingress:webui
//   channel_ingress:qq
//   channel_ingress:test_inject
//   runtime_direct_envelope
//   system_action_delivery
//   automation_due
//   schedule_due

import { normalizeString } from "../core/normalize.js";
import { canAutoWakeForTaskRuntime } from "../agent/agent-activation-policy.js";
import { getAgentIdentitySnapshot } from "../agent/agent-identity.js";

export const PENDING_SIGNAL_KINDS = Object.freeze({
  CHANNEL_INGRESS_WEBUI: "channel_ingress:webui",
  CHANNEL_INGRESS_QQ: "channel_ingress:qq",
  CHANNEL_INGRESS_TEST_INJECT: "channel_ingress:test_inject",
  RUNTIME_DIRECT_ENVELOPE: "runtime_direct_envelope",
  SYSTEM_ACTION_DELIVERY: "system_action_delivery",
  AUTOMATION_DUE: "automation_due",
  SCHEDULE_DUE: "schedule_due",
});

const CHANNEL_INGRESS_KINDS = new Set([
  PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_WEBUI,
  PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_QQ,
  PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_TEST_INJECT,
]);

const DEFAULT_CHANNEL_INGRESS_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Map<agentId, Map<key, entry>> — simple in-memory registry.
const signalsByAgent = new Map();

function normalizeAgentId(agentId) {
  return normalizeString(agentId) || "";
}

function buildKey(sourceKind, sourceRef) {
  return `${normalizeString(sourceKind) || ""}::${normalizeString(sourceRef) || ""}`;
}

function ensureAgentBucket(agentId) {
  let bucket = signalsByAgent.get(agentId);
  if (!bucket) {
    bucket = new Map();
    signalsByAgent.set(agentId, bucket);
  }
  return bucket;
}

export function registerPendingSignal({
  agentId,
  sourceKind,
  sourceRef,
  envelopeId = null,
  envelope = null,
  ttlMs = null,
  now = Date.now(),
} = {}) {
  const aid = normalizeAgentId(agentId);
  const kind = normalizeString(sourceKind);
  const ref = normalizeString(sourceRef) || envelopeId || "";
  if (!aid || !kind) return null;
  if (!canAutoWakeForTaskRuntime(getAgentIdentitySnapshot(aid))) {
    return null;
  }
  const bucket = ensureAgentBucket(aid);
  const key = buildKey(kind, ref);
  const effectiveTtl = ttlMs
    ?? (CHANNEL_INGRESS_KINDS.has(kind) ? DEFAULT_CHANNEL_INGRESS_TTL_MS : null);
  const entry = {
    agentId: aid,
    sourceKind: kind,
    sourceRef: ref,
    envelopeId: normalizeString(envelopeId) || null,
    envelope: envelope || null,
    registeredAt: now,
    expiresAt: Number.isFinite(effectiveTtl) && effectiveTtl > 0 ? now + effectiveTtl : null,
  };
  bucket.set(key, entry);
  return entry;
}

export function clearPendingSignal({
  agentId,
  sourceKind,
  sourceRef,
  envelopeId = null,
} = {}) {
  const aid = normalizeAgentId(agentId);
  const kind = normalizeString(sourceKind);
  const ref = normalizeString(sourceRef) || envelopeId || "";
  if (!aid || !kind) return false;
  const bucket = signalsByAgent.get(aid);
  if (!bucket) return false;
  const key = buildKey(kind, ref);
  const removed = bucket.delete(key);
  if (bucket.size === 0) signalsByAgent.delete(aid);
  return removed;
}

function isActiveEntry(entry, now = Date.now()) {
  if (!entry) return false;
  if (entry.expiresAt != null && entry.expiresAt <= now) return false;
  return true;
}

export function hasPendingSignal(agentId, { now = Date.now() } = {}) {
  const aid = normalizeAgentId(agentId);
  if (!aid) return false;
  const bucket = signalsByAgent.get(aid);
  if (!bucket) return false;
  for (const entry of bucket.values()) {
    if (isActiveEntry(entry, now)) return true;
  }
  return false;
}

export function listPendingSignals(agentId, { now = Date.now() } = {}) {
  const aid = normalizeAgentId(agentId);
  if (!aid) return [];
  const bucket = signalsByAgent.get(aid);
  if (!bucket) return [];
  return [...bucket.values()].filter((entry) => isActiveEntry(entry, now));
}

export function summarizePendingSignalRegistry({ now = Date.now() } = {}) {
  const summary = {
    activeSignals: 0,
    staleSignals: 0,
    sourceCoverage: {},
    byAgent: {},
  };
  for (const [agentId, bucket] of signalsByAgent.entries()) {
    const active = [];
    const stale = [];
    for (const entry of bucket.values()) {
      if (isActiveEntry(entry, now)) {
        active.push(entry);
        summary.sourceCoverage[entry.sourceKind] = (summary.sourceCoverage[entry.sourceKind] || 0) + 1;
      } else {
        stale.push(entry);
      }
    }
    summary.activeSignals += active.length;
    summary.staleSignals += stale.length;
    summary.byAgent[agentId] = { active: active.length, stale: stale.length };
  }
  return summary;
}

export function prunePendingSignals({ now = Date.now() } = {}) {
  let removed = 0;
  for (const [agentId, bucket] of signalsByAgent.entries()) {
    for (const [key, entry] of bucket.entries()) {
      if (!isActiveEntry(entry, now)) {
        bucket.delete(key);
        removed += 1;
      }
    }
    if (bucket.size === 0) signalsByAgent.delete(agentId);
  }
  return removed;
}

export function clearAllPendingSignals() {
  const count = signalsByAgent.size;
  signalsByAgent.clear();
  return count;
}
