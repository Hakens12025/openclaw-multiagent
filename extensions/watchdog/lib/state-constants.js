// state-constants.js — Numeric / timeout / retry constants

export const RESULT_SUMMARY_MAX_CHARS = 1500;
const AVG_CALLS_PER_STEP = 4;
export const MAX_HISTORY = 50;
// Size of the trackingState.toolCalls sliding window. Unrelated to the
// executionPolicy.maxToolCalls hard-stop budget (see execution-policy-defaults).
export const TOOL_CALLS_WINDOW_SIZE = 50;
export const MAX_RECENT_TOOL_EVENTS = 20;
export const MAX_RETRY_COUNT = 3;
export const RETRY_DELAYS = [3000, 10000, 30000];

export const DISPATCH_CONFIRM_TIMEOUT = 10000;
export const DISPATCH_MAX_RETRIES = 6;
export const DISPATCH_RETRY_DELAYS = [5000, 5000, 10000, 10000, 15000, 20000];
export const PLANNER_CONFIRM_TIMEOUT = 10000;
export const PLANNER_MAX_RETRIES = 6;
export const PLANNER_RETRY_DELAYS = [5000, 5000, 10000, 10000, 15000, 20000];
export const PLANNER_AUTO_PROMOTE_DELAY_MS = 120000;
export const PLANNER_DEFERRED_RETRY_INTERVAL_MS = 10000;
export const PLANNER_DEFERRED_RETRY_MAX_ATTEMPTS = 18; // 18 * 10s = 3min max

// Tracker / runtime stage timeout thresholds
export const NON_RUNNING_TRACKER_RETENTION_MS = 60 * 60_000;         // 1hr: evict finished trackers
export const RUNNING_TRACKER_STALE_SILENCE_MS = 20 * 60_000;         // 20min: silence → inactivity wake
export const LATE_COMPLETION_LEASE_MS = 10 * 60 * 1000;              // 10min: grace window
