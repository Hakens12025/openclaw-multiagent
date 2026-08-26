// trace-event-schema.js — unified FC evidence event shape (spec §2).
// Two orthogonal tags: kind (which execution path) × channel (which
// expression inlet). Illegal combinations are rejected at build time.

export const TRACE_EVENT_KINDS = Object.freeze({
  INTERNAL: "internal",
  COLLAB: "collab",
});

export const TRACE_EVENT_CHANNELS = Object.freeze({
  FC: "fc",
  FENCE: "fence",
  TEXT: "text",
});

export const TRACE_EVENT_OUTCOMES = Object.freeze({
  OK: "ok",
  REFUSED: "refused",
  ERROR: "error",
});

export const TRACE_SENTINELS = Object.freeze({
  OPEN: "session_open",
  CLOSE: "session_close",
});

const LEGAL_CHANNELS = Object.freeze({
  [TRACE_EVENT_KINDS.INTERNAL]: Object.freeze([TRACE_EVENT_CHANNELS.FC]),
  [TRACE_EVENT_KINDS.COLLAB]: Object.freeze([
    TRACE_EVENT_CHANNELS.FC, TRACE_EVENT_CHANNELS.FENCE, TRACE_EVENT_CHANNELS.TEXT,
  ]),
});

export function isLegalKindChannel(kind, channel) {
  return (LEGAL_CHANNELS[kind] || []).includes(channel);
}

export function buildTraceEvent({
  kind, channel, name,
  argsDigest = null, resultDigest = null,
  outcome, agentId = "unknown", sessionKey,
  contractId = null, synthesized = false, ts = Date.now(),
} = {}) {
  if (!isLegalKindChannel(kind, channel)) {
    throw new TypeError(`illegal trace event kind/channel: ${kind}/${channel}`);
  }
  if (!Object.values(TRACE_EVENT_OUTCOMES).includes(outcome)) {
    throw new TypeError(`unknown trace outcome: ${outcome}`);
  }
  if (!name || !sessionKey) {
    throw new TypeError("trace event requires name and sessionKey");
  }
  return {
    kind, channel, name,
    args: argsDigest, result: resultDigest,
    outcome, agentId, sessionKey,
    ...(contractId ? { contractId } : {}),
    ...(synthesized ? { synthesized: true } : {}),
    ts,
  };
}
