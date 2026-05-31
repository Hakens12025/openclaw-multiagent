// ---------------------------------------------------------------------------
// Harness run status constants and validator sets — leaf module (no deps)
// ---------------------------------------------------------------------------

export const HARNESS_RUN_STATUS = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  ABANDONED: "abandoned",
  CANCELLED: "cancelled",
  AWAITING_INPUT: "awaiting_input",
});

export const HARNESS_MODULE_STATUS = Object.freeze({
  PENDING: "pending",
  PASSED: "passed",
  FAILED: "failed",
  SKIPPED: "skipped",
});

export const HARNESS_GATE_VERDICT = Object.freeze({
  NONE: "none",
  PENDING: "pending",
  PASSED: "passed",
  FAILED: "failed",
  SKIPPED: "skipped",
});

export const VALID_HARNESS_RUN_STATUSES = new Set(Object.values(HARNESS_RUN_STATUS));
export const VALID_HARNESS_MODULE_RUN_STATUSES = new Set(Object.values(HARNESS_MODULE_STATUS));
export const VALID_HARNESS_GATE_VERDICTS = new Set(Object.values(HARNESS_GATE_VERDICT));

