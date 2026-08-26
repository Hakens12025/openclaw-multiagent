export const DEFAULT_QUEUE_ALLOWANCE_MS = 60_000;
export const DEFAULT_PROGRESS_LEASE_MS = 120_000;
export const ABSOLUTE_TIMEOUT_CAP_EXTRA_MS = 180_000;

function normalizeNonNegative(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return num;
}

export function createTestTimeoutBudget({
  startMs = Date.now(),
  baseTimeoutMs,
  groupTimeoutMs = null,
  queuePosition = 0,
  queueAllowanceMs = DEFAULT_QUEUE_ALLOWANCE_MS,
  progressLeaseMs = DEFAULT_PROGRESS_LEASE_MS,
  absoluteCapExtraMs = ABSOLUTE_TIMEOUT_CAP_EXTRA_MS,
} = {}) {
  const startedAtMs = normalizeNonNegative(startMs, Date.now());
  const baseWindowMs = Math.max(
    normalizeNonNegative(baseTimeoutMs, 0),
    normalizeNonNegative(groupTimeoutMs, 0),
  );
  const queueAllowancePerSlotMs = normalizeNonNegative(queueAllowanceMs, DEFAULT_QUEUE_ALLOWANCE_MS);
  const queueSlots = Math.max(0, Math.floor(normalizeNonNegative(queuePosition, 0)));
  const totalQueueAllowanceMs = queueAllowancePerSlotMs * queueSlots;
  const progressWindowMs = normalizeNonNegative(progressLeaseMs, DEFAULT_PROGRESS_LEASE_MS);
  const hardCapExtraMs = normalizeNonNegative(absoluteCapExtraMs, ABSOLUTE_TIMEOUT_CAP_EXTRA_MS);
  const initialDeadlineMs = startedAtMs + baseWindowMs + totalQueueAllowanceMs;
  const hardDeadlineMs = initialDeadlineMs + hardCapExtraMs;

  let currentDeadlineMs = initialDeadlineMs;
  let lastProgressAtMs = startedAtMs;

  return {
    startedAtMs,
    baseWindowMs,
    groupTimeoutMs: normalizeNonNegative(groupTimeoutMs, 0),
    queuePosition: queueSlots,
    queueAllowanceMs: totalQueueAllowanceMs,
    progressLeaseMs: progressWindowMs,
    initialDeadlineMs,
    hardDeadlineMs,
    get currentDeadlineMs() {
      return currentDeadlineMs;
    },
    get lastProgressAtMs() {
      return lastProgressAtMs;
    },
    noteProgress(atMs = Date.now()) {
      const observedAtMs = normalizeNonNegative(atMs, Date.now());
      if (observedAtMs < lastProgressAtMs) {
        return currentDeadlineMs;
      }
      lastProgressAtMs = observedAtMs;
      currentDeadlineMs = Math.min(
        hardDeadlineMs,
        Math.max(currentDeadlineMs, observedAtMs + progressWindowMs),
      );
      return currentDeadlineMs;
    },
    remainingMs(nowMs = Date.now()) {
      const observedAtMs = normalizeNonNegative(nowMs, Date.now());
      return Math.max(0, currentDeadlineMs - observedAtMs);
    },
    isExpired(nowMs = Date.now()) {
      return this.remainingMs(nowMs) <= 0;
    },
  };
}
