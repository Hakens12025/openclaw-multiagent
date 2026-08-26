import { SYSTEM_ACTION_STATUS } from "../core/runtime-status.js";

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getWakeError(wake) {
  const source = asObject(wake);
  return asString(source.error)
    || asString(source.heartbeatError)
    || asString(source.hookError)
    || null;
}

export function normalizeWakeDiagnostic(wake, {
  lane = "runtime_wake",
  targetAgent = null,
  queued = null,
  promoted = null,
} = {}) {
  const source = typeof wake === "boolean"
    ? {
        ok: wake,
        requested: true,
        mode: wake ? "callback" : null,
        fallbackUsed: false,
        error: wake ? null : "wake callback returned false",
      }
    : asObject(wake);

  const inferredQueued = queued ?? (
    source.queued === true
    || source.skipped === true
    || source.reason === "queued_not_promoted"
  );
  const inferredRequested = source.requested === true;
  const normalizedError = getWakeError(source);

  return {
    lane,
    ok: source.ok === true || (inferredQueued === true && inferredRequested === false),
    requested: inferredRequested,
    queued: inferredQueued === true,
    promoted: promoted === true || source.promoted === true,
    targetAgent: asString(targetAgent) || asString(source.targetAgent),
    mode: asString(source.mode),
    fallbackUsed: source.fallbackUsed === true,
    runId: asString(source.runId),
    hookError: asString(source.hookError),
    heartbeatError: asString(source.heartbeatError),
    error: normalizedError,
    reason: asString(source.reason),
  };
}

export function buildQueuedWakeDiagnostic({
  lane = "runtime_wake",
  targetAgent = null,
  reason = "queued_not_promoted",
} = {}) {
  return normalizeWakeDiagnostic(
    {
      requested: false,
      skipped: true,
      reason,
    },
    {
      lane,
      targetAgent,
      queued: true,
      promoted: false,
    },
  );
}

export function deriveDispatchStatusFromWake(wake, {
  dispatchedStatus = SYSTEM_ACTION_STATUS.DISPATCHED,
  queuedStatus = SYSTEM_ACTION_STATUS.QUEUED,
  wakeFailedStatus = SYSTEM_ACTION_STATUS.WAKE_FAILED,
} = {}) {
  const normalized = normalizeWakeDiagnostic(wake);
  if (normalized.queued) return queuedStatus;
  if (normalized.ok) return dispatchedStatus;
  return wakeFailedStatus;
}

export function normalizeDeliveryDiagnostic(result, { lane = "delivery" } = {}) {
  const source = asObject(result);
  const normalized = {
    ...source,
    lane,
    ok: source.ok === true,
    channel: asString(source.channel) || "none",
    stage: asString(source.stage),
    persisted: source.persisted === true,
    notified: source.notified === true,
    partial: source.partial === true,
    deliveryId: asString(source.deliveryId),
    targetAgent: asString(source.replyToAgentId) || asString(source.target),
    error: asString(source.error),
  };

  if ("fallback" in source) {
    normalized.fallback = source.fallback
      ? normalizeDeliveryDiagnostic(source.fallback, { lane: `${lane}.fallback` })
      : null;
  }

  return normalized;
}

export function normalizeSystemActionDeliveryDiagnostic(result, { lane = "system_action_delivery" } = {}) {
  const source = asObject(result);
  const deliveryId = asString(source.deliveryId);
  const deliveryType = asString(source.deliveryType);
  const workflow = asString(source.workflow);
  const artifactType = asString(source.artifactType);
  const semanticArtifactType = asString(source.semanticArtifactType);
  const semanticWorkflow = asString(source.semanticWorkflow);
  const handled = source.handled === true;
  const error = asString(source.error);
  const targetAgent = asString(source.targetAgent);
  const contractId = asString(source.contractId);
  const status = asString(source.status);
  const verdict = asString(source.verdict);
  const reason = asString(source.reason);
  const deliveryTicketId = asString(source.deliveryTicketId);
  const hasNestedDelivery = Boolean(source.nestedDelivery && typeof source.nestedDelivery === "object");

  if (!deliveryId && !deliveryType && !workflow && !artifactType && !semanticArtifactType && !semanticWorkflow && !handled && !error && !targetAgent && !contractId && !status && !verdict && !reason && !deliveryTicketId && !hasNestedDelivery) {
    return null;
  }

  const normalized = {
    lane,
    deliveryId,
    deliveryType,
    workflow,
    artifactType,
    semanticArtifactType,
    semanticWorkflow,
    handled,
    targetAgent,
    contractId,
    status,
    verdict,
    reason,
    deliveryTicketId,
    error,
  };

  if ("duplicate" in source) {
    normalized.duplicate = source.duplicate === true;
  }
  if ("skipped" in source) {
    normalized.skipped = source.skipped === true;
  }
  if ("suppressCompletionEgress" in source) {
    normalized.suppressCompletionEgress = source.suppressCompletionEgress === true;
  }
  if ("conclusionReason" in source) {
    normalized.conclusionReason = asString(source.conclusionReason);
  }
  if ("conclusionArtifact" in source) {
    normalized.conclusionArtifact = source.conclusionArtifact || null;
  }
  if ("wake" in source) {
    normalized.wake = source.wake
      ? normalizeWakeDiagnostic(source.wake, {
          lane: `${lane}.wake`,
          targetAgent,
        })
      : null;
  }
  if (hasNestedDelivery) {
    normalized.nestedDelivery = normalizeSystemActionDeliveryDiagnostic(source.nestedDelivery, {
      lane: `${lane}.nested`,
    });
  }

  return normalized;
}
