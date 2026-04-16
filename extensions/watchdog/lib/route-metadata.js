import {
  normalizeReplyTarget,
  normalizeReturnContext,
} from "./coordination-primitives.js";
import { normalizeRecord } from "./core/normalize.js";
import {
  normalizeOperatorContext,
} from "./operator/operator-context.js";
import { normalizeServiceSession } from "./service-session.js";

function describeRawValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function normalizeRouteField(rawValue, normalizer, field, reason, droppedFields) {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }

  const normalized = normalizer(rawValue);
  if (normalized == null) {
    droppedFields.push({
      field,
      reason,
      rawType: describeRawValueType(rawValue),
    });
  }
  return normalized;
}

export function normalizeRouteMetadata({
  replyTo = undefined,
  upstreamReplyTo = undefined,
  returnContext = undefined,
  serviceSession = undefined,
  operatorContext = undefined,
} = {}, {
  source = null,
} = {}) {
  const droppedFields = [];

  const normalized = {
    replyTo: normalizeRouteField(
      replyTo,
      normalizeReplyTarget,
      "replyTo",
      "invalid_reply_target",
      droppedFields,
    ),
    upstreamReplyTo: normalizeRouteField(
      upstreamReplyTo,
      normalizeReplyTarget,
      "upstreamReplyTo",
      "invalid_reply_target",
      droppedFields,
    ),
    returnContext: normalizeRouteField(
      returnContext,
      normalizeReturnContext,
      "returnContext",
      "invalid_return_context",
      droppedFields,
    ),
    serviceSession: normalizeRouteField(
      serviceSession,
      normalizeServiceSession,
      "serviceSession",
      "invalid_service_session",
      droppedFields,
    ),
    operatorContext: normalizeRouteField(
      operatorContext,
      normalizeOperatorContext,
      "operatorContext",
      "invalid_operator_context",
      droppedFields,
    ),
  };

  return {
    ...normalized,
    routeMetadataDiagnostics: droppedFields.length > 0
      ? {
          ...(typeof source === "string" && source.trim() ? { source: source.trim() } : {}),
          droppedFields,
        }
      : null,
  };
}

export function mergeRouteMetadataDiagnostics(...diagnostics) {
  const mergedDroppedFields = [];
  const sources = [];

  for (const entry of diagnostics) {
    const value = normalizeRecord(entry, null);
    if (!value) continue;
    if (typeof value.source === "string" && value.source.trim()) {
      sources.push(value.source.trim());
    }
    for (const droppedField of Array.isArray(value.droppedFields) ? value.droppedFields : []) {
      const normalizedDroppedField = normalizeRecord(droppedField, null);
      if (!normalizedDroppedField?.field || !normalizedDroppedField?.reason) continue;
      mergedDroppedFields.push({
        field: normalizedDroppedField.field,
        reason: normalizedDroppedField.reason,
        ...(typeof normalizedDroppedField.rawType === "string" && normalizedDroppedField.rawType.trim()
          ? { rawType: normalizedDroppedField.rawType.trim() }
          : {}),
      });
    }
  }

  if (mergedDroppedFields.length === 0) {
    return null;
  }

  const uniqueSources = [...new Set(sources)];
  return {
    ...(uniqueSources.length === 1
      ? { source: uniqueSources[0] }
      : uniqueSources.length > 1
        ? { sources: uniqueSources }
        : {}),
    droppedFields: mergedDroppedFields,
  };
}

export function attachRouteMetadataDiagnostics(target, diagnostics) {
  if (!target || typeof target !== "object") {
    return target;
  }

  const merged = mergeRouteMetadataDiagnostics(
    target.runtimeDiagnostics?.routeMetadata,
    diagnostics,
  );
  if (!merged) {
    return target;
  }

  const runtimeDiagnostics = target.runtimeDiagnostics && typeof target.runtimeDiagnostics === "object"
    ? target.runtimeDiagnostics
    : {};
  target.runtimeDiagnostics = {
    ...runtimeDiagnostics,
    routeMetadata: merged,
  };
  return target;
}
