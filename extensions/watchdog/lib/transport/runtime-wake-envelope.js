// runtime-wake-envelope.js — typed wake envelope.
//
// The envelope is the primary runtime truth for "why is this agent being
// woken up". Natural-language wake strings are a rendered explanation only.
// Required fields per semantic type are enforced at build time; producers
// that cannot satisfy the required fields MUST NOT emit that semantic type.

import { RUNTIME_WAKE_SEMANTICS, buildRuntimeWakeReason } from "./runtime-wake-transport.js";
import { normalizeString } from "../core/normalize.js";

export const WAKE_ENVELOPE_VERSION = 1;

export const WAKE_SEMANTIC_TYPE = Object.freeze({
  EXECUTION_CONTRACT: RUNTIME_WAKE_SEMANTICS.EXECUTION_CONTRACT,
  DIRECT_REQUEST_RESUME: RUNTIME_WAKE_SEMANTICS.DIRECT_REQUEST_RESUME,
  SYSTEM_ACTION_WAKE_AGENT: RUNTIME_WAKE_SEMANTICS.SYSTEM_ACTION_WAKE_AGENT,
  ASSIGN_TASK_DISPATCH: RUNTIME_WAKE_SEMANTICS.ASSIGN_TASK_DISPATCH,
  REQUEST_REVIEW_DISPATCH: RUNTIME_WAKE_SEMANTICS.REQUEST_REVIEW_DISPATCH,
  TERMINAL_DELIVERY_READY: RUNTIME_WAKE_SEMANTICS.TERMINAL_DELIVERY_READY,
  SYSTEM_ACTION_DELIVERY_RESUME: RUNTIME_WAKE_SEMANTICS.SYSTEM_ACTION_DELIVERY_RESUME,
  HEARTBEAT_POLL: "heartbeat_poll",
  GENERIC: RUNTIME_WAKE_SEMANTICS.GENERIC,
});

// Required-fields table per semanticType (beyond the base shape). The base
// shape is always: { version, semanticType, targetAgentId, createdAt, renderText }.
const REQUIRED_FIELDS_BY_SEMANTIC = Object.freeze({
  [WAKE_SEMANTIC_TYPE.EXECUTION_CONTRACT]: Object.freeze(["contractId"]),
  [WAKE_SEMANTIC_TYPE.DIRECT_REQUEST_RESUME]: Object.freeze(["envelopeId"]),
  [WAKE_SEMANTIC_TYPE.SYSTEM_ACTION_WAKE_AGENT]: Object.freeze(["sourceAgentId", "actionType"]),
  [WAKE_SEMANTIC_TYPE.ASSIGN_TASK_DISPATCH]: Object.freeze(["sourceAgentId"]),
  [WAKE_SEMANTIC_TYPE.REQUEST_REVIEW_DISPATCH]: Object.freeze(["sourceAgentId", "deliveryTicketId"]),
  [WAKE_SEMANTIC_TYPE.TERMINAL_DELIVERY_READY]: Object.freeze(["deliveryId", "contractId"]),
  [WAKE_SEMANTIC_TYPE.SYSTEM_ACTION_DELIVERY_RESUME]: Object.freeze(["deliveryTicketId"]),
  [WAKE_SEMANTIC_TYPE.HEARTBEAT_POLL]: Object.freeze([]),
  [WAKE_SEMANTIC_TYPE.GENERIC]: Object.freeze([]),
});

function normalizeField(value) {
  return normalizeString(value) || null;
}

export function listRequiredFieldsForSemantic(semanticType) {
  return [...(REQUIRED_FIELDS_BY_SEMANTIC[semanticType] || [])];
}

export function isKnownWakeSemanticType(value) {
  return Boolean(REQUIRED_FIELDS_BY_SEMANTIC[value]);
}

// Internal semantic types are runtime-produced wakes that should never be
// treated as user-facing direct input. GENERIC is intentionally excluded —
// it's used for free-form operator/manual wakes that may or may not be a
// direct user message.
const INTERNAL_WAKE_SEMANTIC_TYPES = new Set([
  WAKE_SEMANTIC_TYPE.EXECUTION_CONTRACT,
  WAKE_SEMANTIC_TYPE.DIRECT_REQUEST_RESUME,
  WAKE_SEMANTIC_TYPE.SYSTEM_ACTION_WAKE_AGENT,
  WAKE_SEMANTIC_TYPE.ASSIGN_TASK_DISPATCH,
  WAKE_SEMANTIC_TYPE.REQUEST_REVIEW_DISPATCH,
  WAKE_SEMANTIC_TYPE.TERMINAL_DELIVERY_READY,
  WAKE_SEMANTIC_TYPE.SYSTEM_ACTION_DELIVERY_RESUME,
  WAKE_SEMANTIC_TYPE.HEARTBEAT_POLL,
]);

export function isInternalWakeSemanticType(semanticType) {
  return INTERNAL_WAKE_SEMANTIC_TYPES.has(semanticType);
}

export function validateWakeEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { ok: false, error: "envelope must be an object" };
  }
  if (envelope.version !== WAKE_ENVELOPE_VERSION) {
    return { ok: false, error: `unsupported envelope version: ${envelope.version}` };
  }
  if (!isKnownWakeSemanticType(envelope.semanticType)) {
    return { ok: false, error: `unknown semanticType: ${envelope.semanticType}` };
  }
  if (!normalizeField(envelope.targetAgentId)) {
    return { ok: false, error: "missing targetAgentId" };
  }
  if (!Number.isFinite(envelope.createdAt)) {
    return { ok: false, error: "missing or invalid createdAt" };
  }
  const missing = listRequiredFieldsForSemantic(envelope.semanticType)
    .filter((field) => !normalizeField(envelope[field]));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `missing required fields for ${envelope.semanticType}: ${missing.join(", ")}`,
      missingFields: missing,
    };
  }
  return { ok: true };
}

export function normalizeWakeEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  const semanticType = envelope.semanticType;
  const base = {
    version: WAKE_ENVELOPE_VERSION,
    semanticType,
    targetAgentId: normalizeField(envelope.targetAgentId),
    createdAt: Number.isFinite(envelope.createdAt) ? Number(envelope.createdAt) : Date.now(),
    renderText: typeof envelope.renderText === "string" ? envelope.renderText : "",
  };
  const required = REQUIRED_FIELDS_BY_SEMANTIC[semanticType] || [];
  const optionalPassThrough = [
    "contractId",
    "envelopeId",
    "sourceAgentId",
    "actionType",
    "deliveryTicketId",
    "deliveryId",
    "sourceContractId",
    "sessionKeyHint",
    "reason",
  ];
  const extras = {};
  for (const field of [...required, ...optionalPassThrough]) {
    const value = normalizeField(envelope[field]);
    if (value) extras[field] = value;
  }
  return { ...base, ...extras };
}

export function renderWakeEnvelopeToText(envelope) {
  if (!envelope) return "";
  if (typeof envelope.renderText === "string" && envelope.renderText) {
    return envelope.renderText;
  }
  return buildRuntimeWakeReason(null, {
    wakeSemantic: envelope.semanticType,
    contractId: envelope.contractId,
    envelopeId: envelope.envelopeId,
    sourceAgentId: envelope.sourceAgentId,
    deliveryId: envelope.deliveryId,
  });
}

export function buildRuntimeWakeEnvelope({
  semanticType,
  targetAgentId,
  contractId = null,
  envelopeId = null,
  sourceAgentId = null,
  actionType = null,
  deliveryTicketId = null,
  deliveryId = null,
  sourceContractId = null,
  sessionKeyHint = null,
  reason = null,
  renderText = null,
  now = Date.now(),
} = {}) {
  const draft = {
    version: WAKE_ENVELOPE_VERSION,
    semanticType,
    targetAgentId,
    createdAt: now,
    renderText: normalizeString(renderText) || null,
    contractId,
    envelopeId,
    sourceAgentId,
    actionType,
    deliveryTicketId,
    deliveryId,
    sourceContractId,
    sessionKeyHint,
    reason,
  };
  const normalized = normalizeWakeEnvelope(draft);
  const validation = validateWakeEnvelope(normalized);
  if (!validation.ok) {
    const err = new Error(`invalid wake envelope: ${validation.error}`);
    err.validation = validation;
    throw err;
  }
  if (!normalized.renderText) {
    normalized.renderText = renderWakeEnvelopeToText(normalized);
  }
  return normalized;
}
