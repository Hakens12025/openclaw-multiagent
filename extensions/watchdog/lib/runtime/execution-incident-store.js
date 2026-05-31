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

export function resolveExecutionIncidentKey(query = {}) {
  return resolvePrimaryKey(query)
    || normalizeString(query.contractId)
    || normalizeString(query.epochKey)
    || normalizeString(query.sessionKey)
    || null;
}

export function getExecutionIncident(query = {}) {
  const primaryKey = resolvePrimaryKey(query);
  return primaryKey ? cloneIncident(incidents.get(primaryKey) || null) : null;
}

export function listExecutionIncidents() {
  return [...incidents.values()].map((incident) => cloneIncident(incident));
}

export function upsertExecutionIncident(input = {}) {
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
  const current = incidents.get(primaryKey) || null;
  const mergedAmplifiers = normalizeAmplifiers([
    ...(Array.isArray(current?.amplifiers) ? current.amplifiers : []),
    ...normalized.amplifiers,
  ]);
  const now = Date.now();

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

  incidents.set(primaryKey, next);
  registerIndexes(primaryKey, next);
  return cloneIncident(next);
}

export function clearExecutionIncident(query = {}) {
  const primaryKey = resolvePrimaryKey(query);
  if (!primaryKey) {
    return false;
  }
  const existing = incidents.get(primaryKey) || null;
  incidents.delete(primaryKey);
  if (existing?.contractId) contractIndex.delete(existing.contractId);
  if (existing?.epochKey) epochIndex.delete(existing.epochKey);
  if (existing?.sessionKey) sessionIndex.delete(existing.sessionKey);
  return true;
}

export function clearAllExecutionIncidents() {
  const count = incidents.size;
  incidents.clear();
  contractIndex.clear();
  epochIndex.clear();
  sessionIndex.clear();
  return count;
}
