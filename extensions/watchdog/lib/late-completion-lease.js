import { TRACKING_STATUS } from "./core/runtime-status.js";
import {
  armLease,
  getLease,
  hasActiveLease,
  isLeaseExpired,
  consumeLease,
} from "./lease-manager.js";

import { LATE_COMPLETION_LEASE_MS } from "./state-constants.js";

const TYPE = "lateCompletionLease";

export function getLateCompletionLeaseMs() {
  return LATE_COMPLETION_LEASE_MS;
}

export function getLateCompletionLease(trackingState) {
  return getLease(trackingState, TYPE);
}

export function hasActiveLateCompletionLease(trackingState, now = Date.now()) {
  return hasActiveLease(trackingState, TYPE, now);
}

export function isLateCompletionLeaseExpired(trackingState, now = Date.now()) {
  return isLeaseExpired(trackingState, TYPE, now);
}

export function armLateCompletionLease(trackingState, {
  now = Date.now(),
  leaseMs = LATE_COMPLETION_LEASE_MS,
  reason = "tracker_timeout",
  diagnostic = null,
  loopStage = null,
} = {}) {
  const effectiveLoopStage = loopStage && typeof loopStage === "object"
    ? loopStage
    : trackingState?.contract?.pipelineStage;
  if (!trackingState || !effectiveLoopStage?.stage) {
    return null;
  }

  return armLease(trackingState, TYPE, {
    now,
    leaseMs,
    leaseFields: {
      reason,
      stage: effectiveLoopStage.stage,
      pipelineId: effectiveLoopStage.pipelineId || null,
      loopId: effectiveLoopStage.loopId || null,
      loopSessionId: effectiveLoopStage.loopSessionId || null,
      round: Number.isFinite(effectiveLoopStage.round) ? effectiveLoopStage.round : null,
      contractId: trackingState.contract?.id || null,
      diagnostic: diagnostic && typeof diagnostic === "object" ? diagnostic : null,
    },
    applyTrackingSideEffects(ts, lease) {
      ts.status = TRACKING_STATUS.WAITING_FOLLOWUP;
      ts.lastLabel = `等待迟到收口: ${effectiveLoopStage.stage}`;
      ts.estimatedPhase = "等待迟到收口";
    },
  });
}

export function consumeLateCompletionLease(trackingState, now = Date.now()) {
  return consumeLease(trackingState, TYPE, {
    now,
    applyTrackingSideEffects(ts, consumed) {
      if (ts.status === TRACKING_STATUS.WAITING_FOLLOWUP) {
        ts.status = TRACKING_STATUS.RUNNING;
      }
      if (
        typeof ts.lastLabel !== "string"
        || ts.lastLabel.startsWith("等待迟到收口")
      ) {
        ts.lastLabel = `恢复迟到收口: ${consumed.stage || ts.agentId || "unknown"}`;
      }
      if (ts.estimatedPhase === "等待迟到收口") {
        ts.estimatedPhase = "";
      }
    },
  });
}
