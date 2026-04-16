import { normalizeRecord, normalizeString } from "./core/normalize.js";

function normalizeServiceSessionCaller(value) {
  const caller = normalizeRecord(value, null);
  if (!caller) return null;

  const output = {};
  for (const key of ["agentId", "sessionKey", "channel", "target", "kind", "runId"]) {
    const normalized = normalizeString(caller[key]);
    if (normalized) output[key] = normalized;
  }

  return Object.keys(output).length > 0 ? output : null;
}

export function normalizeServiceSession(value) {
  const session = normalizeRecord(value, null);
  if (!session) return null;

  const output = {};
  for (const key of ["mode", "serviceAgentId", "entrySessionKey", "returnPolicy"]) {
    const normalized = normalizeString(session[key]);
    if (normalized) output[key] = normalized;
  }

  const caller = normalizeServiceSessionCaller(session.caller);
  if (caller) output.caller = caller;

  return Object.keys(output).length > 0 ? output : null;
}

export function buildDirectServiceSession({
  agentId,
  sessionKey,
  caller = null,
  returnPolicy = "resume_session",
} = {}) {
  return normalizeServiceSession({
    mode: "direct_service",
    serviceAgentId: agentId,
    entrySessionKey: sessionKey,
    returnPolicy,
    caller,
  });
}

export function resolveResumableServiceSession(value, {
  agentId = null,
  sessionKey = null,
} = {}) {
  const session = normalizeServiceSession(value);
  if (!session) return null;
  if (session.mode !== "direct_service" || session.returnPolicy !== "resume_session") {
    return null;
  }

  const normalizedAgentId = normalizeString(agentId);
  if (normalizedAgentId && session.serviceAgentId !== normalizedAgentId) {
    return null;
  }

  const normalizedSessionKey = normalizeString(sessionKey);
  if (normalizedSessionKey && session.entrySessionKey !== normalizedSessionKey) {
    return null;
  }

  return session;
}

export function resolveServiceSessionTargetSessionKey(value, fallbackSessionKey = null) {
  const session = normalizeServiceSession(value);
  return session?.entrySessionKey || normalizeString(fallbackSessionKey) || null;
}
