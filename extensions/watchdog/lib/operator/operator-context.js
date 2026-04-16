import { normalizeRecord, normalizeString } from "../core/normalize.js";

export function normalizeOperatorContext(value) {
  const record = normalizeRecord(value, null);
  if (!record) return null;

  const normalized = {
    originDraftId: normalizeString(record.originDraftId),
    originExecutionId: normalizeString(record.originExecutionId),
    originSurfaceId: normalizeString(record.originSurfaceId),
  };

  if (!normalized.originDraftId && !normalized.originExecutionId && !normalized.originSurfaceId) {
    return null;
  }
  return normalized;
}

export function attachOperatorContext(target, operatorContext) {
  if (!target || typeof target !== "object") {
    return target;
  }

  const normalized = normalizeOperatorContext(operatorContext);
  if (!normalized) {
    return target;
  }

  target.operatorContext = normalized;
  return target;
}

export function buildOperatorContextMetadata(operatorContext, extra = null) {
  const normalized = normalizeOperatorContext(operatorContext);
  const metadata = extra && typeof extra === "object"
    ? { ...extra }
    : {};

  if (normalized) {
    Object.assign(metadata, normalized);
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}
