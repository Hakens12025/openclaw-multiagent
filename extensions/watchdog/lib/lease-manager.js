// ---------------------------------------------------------------------------
// Generic lease operations, parameterized by leaseType
//
// leaseType is a string key on trackingState:
//   "followUpLease" — follow-up wait period (唯一的租约类型;
//   lateCompletionLease 已整体退役,arm 侧 v136、读侧 2026-08-26)
// ---------------------------------------------------------------------------

function getLease(trackingState, leaseType) {
  const lease = trackingState?.[leaseType];
  return lease && typeof lease === "object" ? lease : null;
}

export function consumeLease(trackingState, leaseType, {
  now = Date.now(),
  applyTrackingSideEffects = null,
} = {}) {
  const lease = getLease(trackingState, leaseType);
  if (!lease?.active) return null;

  const consumed = {
    ...lease,
    active: false,
    resumedAt: now,
  };

  trackingState[leaseType] = null;

  if (typeof applyTrackingSideEffects === "function") {
    applyTrackingSideEffects(trackingState, consumed);
  }

  return consumed;
}
