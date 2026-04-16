// ---------------------------------------------------------------------------
// Generic lease operations, parameterized by leaseType
//
// leaseType is a string key on trackingState, e.g.:
//   "lateCompletionLease"  — tracker timeout grace period
//   "followUpLease"        — follow-up wait period
// ---------------------------------------------------------------------------

function normalizeLeaseRecord(lease) {
  return lease && typeof lease === "object" ? lease : null;
}

/** Read a lease record from trackingState (or null). */
export function getLease(trackingState, leaseType) {
  return normalizeLeaseRecord(trackingState?.[leaseType]);
}

/** True when the lease is active and has not yet expired. */
export function hasActiveLease(trackingState, leaseType, now = Date.now()) {
  const lease = getLease(trackingState, leaseType);
  if (!lease?.active) return false;
  const expiresAt = Number.isFinite(lease.expiresAt) ? lease.expiresAt : null;
  return !expiresAt || expiresAt > now;
}

/** True when the lease is active but its expiresAt is in the past. */
export function isLeaseExpired(trackingState, leaseType, now = Date.now()) {
  const lease = getLease(trackingState, leaseType);
  if (!lease?.active) return false;
  return Number.isFinite(lease.expiresAt) && lease.expiresAt <= now;
}

/**
 * Arm (create) a lease and attach it to trackingState.
 *
 * @param {object} trackingState
 * @param {string} leaseType      — key on trackingState
 * @param {object} options
 * @param {number} options.now
 * @param {number} options.leaseMs
 * @param {object} options.leaseFields  — the domain-specific payload stored inside the lease
 * @param {function} options.applyTrackingSideEffects — (trackingState, lease) => void
 * @returns {object|null} the newly created lease, or null if preconditions failed
 */
export function armLease(trackingState, leaseType, {
  now = Date.now(),
  leaseMs = 10 * 60 * 1000,
  leaseFields = {},
  applyTrackingSideEffects = null,
} = {}) {
  if (!trackingState) return null;

  const lease = {
    active: true,
    ...leaseFields,
    armedAt: now,
    expiresAt: now + Math.max(0, Number(leaseMs) || 0),
  };

  trackingState[leaseType] = lease;

  if (typeof applyTrackingSideEffects === "function") {
    applyTrackingSideEffects(trackingState, lease);
  }

  return lease;
}

/**
 * Consume (deactivate) a lease and return its final snapshot.
 *
 * @param {object} trackingState
 * @param {string} leaseType
 * @param {object} options
 * @param {number} options.now
 * @param {function} options.applyTrackingSideEffects — (trackingState, consumedLease) => void
 * @returns {object|null} the consumed lease snapshot, or null if no active lease
 */
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
