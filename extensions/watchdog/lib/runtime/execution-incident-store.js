function normalizeString(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function normalizeAmplifiers(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((entry) => normalizeString(entry)).filter(Boolean))];
}

const ROOT_FAULT_PRIORITY = Object.freeze({
  tool_failure: 1,
  retryable_runtime_failure: 2,
  interaction_block: 3,
  llm_fault: 4,
  system_fault: 5,
  mixed_fault: 6,
});

// FIX(A6-incident-ttl): store had no TTL and no size ceiling -> unbounded growth over process lifetime.
// TTL is idle-based (measured from updatedAt) so an actively-amplified incident stays live; the LRU
// cap bounds the absolute count regardless of activity. Mirrors pending-signal-registry's TTL style.
export const INCIDENT_TTL_MS = 30 * 60 * 1000; // 30 minutes idle since last update
export const MAX_INCIDENTS = 500;

const incidents = new Map();
const contractIndex = new Map();
const epochIndex = new Map();
const sessionIndex = new Map();

let incidentSequence = 0;

function resolvePrimaryKey(query = {}) {
  const contractId = normalizeString(query.contractId);
  if (contractId && contractIndex.has(contractId)) {
    return contractIndex.get(contractId) || null;
  }
  const epochKey = normalizeString(query.epochKey);
  if (epochKey && epochIndex.has(epochKey)) {
    return epochIndex.get(epochKey) || null;
  }
  const sessionKey = normalizeString(query.sessionKey);
  if (sessionKey && sessionIndex.has(sessionKey)) {
    return sessionIndex.get(sessionKey) || null;
  }
  return null;
}

function chooseRootFault(currentFault, nextFault) {
  const currentPriority = ROOT_FAULT_PRIORITY[normalizeString(currentFault)] || 0;
  const nextPriority = ROOT_FAULT_PRIORITY[normalizeString(nextFault)] || 0;
  return nextPriority >= currentPriority
    ? normalizeString(nextFault) || normalizeString(currentFault)
    : normalizeString(currentFault);
}

function choosePrimaryKey(incident = {}) {
  return normalizeString(incident.contractId)
    || normalizeString(incident.epochKey)
    || normalizeString(incident.sessionKey)
    || `incident:${Date.now()}:${++incidentSequence}`;
}

function cloneIncident(incident) {
  return incident
    ? {
        ...incident,
        amplifiers: [...(Array.isArray(incident.amplifiers) ? incident.amplifiers : [])],
      }
    : null;
}

function registerIndexes(primaryKey, incident) {
  const contractId = normalizeString(incident?.contractId);
  const epochKey = normalizeString(incident?.epochKey);
  const sessionKey = normalizeString(incident?.sessionKey);
  if (contractId) contractIndex.set(contractId, primaryKey);
  if (epochKey) epochIndex.set(epochKey, primaryKey);
  if (sessionKey) sessionIndex.set(sessionKey, primaryKey);
}

// FIX(A6-incident-ttl): duplicated index cleanup (was inline in clearExecutionIncident) -> single
// deletion path reused by clear / TTL sweep / LRU eviction (one-path principle, single truth).
function deleteIncidentEntry(primaryKey) {
  const existing = incidents.get(primaryKey) || null;
  if (!existing) return false;
  incidents.delete(primaryKey);
  if (existing.contractId) contractIndex.delete(existing.contractId);
  if (existing.epochKey) epochIndex.delete(existing.epochKey);
  if (existing.sessionKey) sessionIndex.delete(existing.sessionKey);
  return true;
}

// FIX(A6-incident-ttl): expiry derived from updatedAt+TTL, not a redundant stored field -> single truth.
function isExpiredIncident(incident, now) {
  return Boolean(incident)
    && typeof incident.updatedAt === "number"
    && now - incident.updatedAt >= INCIDENT_TTL_MS;
}

// FIX(A6-incident-ttl): TTL sweep -> reap every entry idle past INCIDENT_TTL_MS.
function sweepExpiredIncidents(now) {
  let removed = 0;
  for (const [primaryKey, incident] of incidents.entries()) {
    if (isExpiredIncident(incident, now)) {
      deleteIncidentEntry(primaryKey);
      removed += 1;
    }
  }
  return removed;
}

// FIX(A6-incident-ttl): hard ceiling -> evict oldest-written until size <= MAX_INCIDENTS. Map
// iterates in insertion order and upsert re-seats touched keys to the tail, so head == LRU victim.
function enforceIncidentCap() {
  while (incidents.size > MAX_INCIDENTS) {
    const oldestKey = incidents.keys().next().value;
    if (oldestKey === undefined) break;
    deleteIncidentEntry(oldestKey);
  }
}

export function resolveExecutionIncidentKey(query = {}) {
  return resolvePrimaryKey(query)
    || normalizeString(query.contractId)
    || normalizeString(query.epochKey)
    || normalizeString(query.sessionKey)
    || null;
}

export function getExecutionIncident(query = {}, { now = Date.now() } = {}) { // FIX(A6-incident-ttl): optional clock seam (defaults to Date.now, callers unchanged)
  const primaryKey = resolvePrimaryKey(query);
  if (!primaryKey) return null;
  const incident = incidents.get(primaryKey) || null;
  if (isExpiredIncident(incident, now)) return null; // FIX(A6-incident-ttl): hide expired reads (mirrors pending-signal isActiveEntry)
  return cloneIncident(incident);
}

export function listExecutionIncidents({ now = Date.now() } = {}) { // FIX(A6-incident-ttl): optional clock seam; existing no-arg callers unchanged
  return [...incidents.values()]
    .filter((incident) => !isExpiredIncident(incident, now)) // FIX(A6-incident-ttl): exclude expired-but-not-yet-swept entries
    .map((incident) => cloneIncident(incident));
}

export function upsertExecutionIncident(input = {}, { now = Date.now() } = {}) { // FIX(A6-incident-ttl): clock seam via 2nd optional arg; single-arg callers unchanged
  const normalized = {
    contractId: normalizeString(input.contractId),
    epochKey: normalizeString(input.epochKey),
    sessionKey: normalizeString(input.sessionKey),
    agentId: normalizeString(input.agentId),
    rootFault: normalizeString(input.rootFault),
    firstFaultCode: normalizeString(input.firstFaultCode),
    amplifiers: normalizeAmplifiers(input.amplifiers),
    status: normalizeString(input.status),
    terminationMode: normalizeString(input.terminationMode),
    terminationReason: normalizeString(input.terminationReason),
  };

  const primaryKey = resolvePrimaryKey(normalized) || choosePrimaryKey(normalized);
  // FIX(A6-incident-ttl/review): the read paths (get/list) hide expired incidents, so the
  // merge path must too — otherwise a new fault reusing the same key silently RESURRECTS a
  // dead incident's stale createdAt / firstFaultCode / pinned rootFault / amplifiers.
  const existing = incidents.get(primaryKey) || null;
  const current = isExpiredIncident(existing, now) ? null : existing;
  const mergedAmplifiers = normalizeAmplifiers([
    ...(Array.isArray(current?.amplifiers) ? current.amplifiers : []),
    ...normalized.amplifiers,
  ]);
  // FIX(A6-incident-ttl): `now` now supplied by the param above (was `const now = Date.now();`)

  const next = {
    key: primaryKey,
    contractId: normalized.contractId || current?.contractId || null,
    epochKey: normalized.epochKey || current?.epochKey || null,
    sessionKey: normalized.sessionKey || current?.sessionKey || null,
    agentId: normalized.agentId || current?.agentId || null,
    rootFault: chooseRootFault(current?.rootFault, normalized.rootFault),
    firstFaultCode: current?.firstFaultCode || normalized.firstFaultCode || null,
    amplifiers: mergedAmplifiers,
    status: normalized.status || current?.status || "open",
    terminationMode: normalized.terminationMode || current?.terminationMode || null,
    terminationReason: normalized.terminationReason || current?.terminationReason || null,
    createdAt: current?.createdAt || now,
    updatedAt: now,
  };

  incidents.delete(primaryKey);   // FIX(A6-incident-ttl): re-seat touched key to Map tail -> insertion order == write recency (LRU)
  incidents.set(primaryKey, next);
  registerIndexes(primaryKey, next);
  sweepExpiredIncidents(now);      // FIX(A6-incident-ttl): reap idle entries on every write -> self-bounding, no external pruner needed
  enforceIncidentCap();            // FIX(A6-incident-ttl): enforce MAX_INCIDENTS LRU ceiling
  return cloneIncident(next);
}

// FIX(A6-incident-ttl): explicit TTL sweep for admin/tests, mirroring prunePendingSignals.
export function pruneExecutionIncidents({ now = Date.now() } = {}) {
  return sweepExpiredIncidents(now);
}

export function clearExecutionIncident(query = {}) {
  const primaryKey = resolvePrimaryKey(query);
  if (!primaryKey) return false;
  return deleteIncidentEntry(primaryKey); // FIX(A6-incident-ttl): reuse single deletion path instead of inline index cleanup
}

export function clearAllExecutionIncidents() {
  const count = incidents.size;
  incidents.clear();
  contractIndex.clear();
  epochIndex.clear();
  sessionIndex.clear();
  return count;
}
