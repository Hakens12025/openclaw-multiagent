// lib/retry-manager.js — Generic retry scheduler
//
// Replaces duplicate retry patterns from the removed pool layer and planner-service.js.
// Both follow the same shape: wait confirmMs, then retry with backoff,
// and call exhaustedFn when max retries exceeded.

/**
 * Schedule a retry loop with backoff.
 *
 * @param {object} opts
 * @param {string}   opts.key          - Human-readable identifier for log messages
 * @param {number}   opts.confirmMs    - Initial timeout before first retry attempt
 * @param {number}   opts.maxRetries   - Maximum number of retry attempts
 * @param {number[]} opts.delays       - Array of delays between retries (last entry repeats)
 * @param {(retryCount: number) => Promise<void>} opts.attemptFn  - Called on each retry
 * @param {() => Promise<void>}                   opts.exhaustedFn - Called when retries exhausted
 * @param {object}   [opts.logger]     - Logger instance (info/warn/error)
 * @returns {{ cancel: () => boolean }}  Handle to cancel the retry loop
 */
export function scheduleRetry({
  key,
  confirmMs,
  maxRetries,
  delays,
  attemptFn,
  exhaustedFn,
  logger,
}) {
  let retryCount = 0;
  let timer = null;
  let canceled = false;

  const attempt = async () => {
    if (canceled) return;

    retryCount++;
    if (retryCount > maxRetries) {
      logger?.error?.(`[retry] ${key}: exhausted after ${maxRetries} retries`);
      try {
        await exhaustedFn();
      } catch (e) {
        logger?.error?.(`[retry] ${key}: exhaustedFn error: ${e.message}`);
      }
      return;
    }

    logger?.warn?.(`[retry] ${key}: attempt #${retryCount}`);
    try {
      await attemptFn(retryCount);
    } catch (e) {
      logger?.error?.(`[retry] ${key}: attemptFn error: ${e.message}`);
    }

    if (canceled) return;
    const baseDelay = delays[Math.min(retryCount - 1, delays.length - 1)];
    const delay = Math.round(baseDelay * (0.75 + Math.random() * 0.5));
    timer = setTimeout(attempt, delay);
  };

  // First attempt fires after confirmMs
  timer = setTimeout(attempt, confirmMs);

  return {
    /** @returns {boolean} true if a pending timer was cleared */
    cancel() {
      if (canceled) return false;
      canceled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        return true;
      }
      return false;
    },

    /** Expose retryCount for external inspection (e.g. snapshot diagnostics) */
    get retryCount() {
      return retryCount;
    },
  };
}
