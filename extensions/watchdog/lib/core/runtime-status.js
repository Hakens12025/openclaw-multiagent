export const CONTRACT_STATUS = Object.freeze({
  DRAFT: "draft",
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  ABANDONED: "abandoned",
  CANCELLED: "cancelled",
  AWAITING_INPUT: "awaiting_input",
});

export const SYSTEM_ACTION_STATUS = Object.freeze({
  NO_ACTION: "no_action",
  DISPATCHED: "dispatched",
  QUEUED: "queued",
  WAKE_FAILED: "wake_failed",
  BUSY: "busy",
  INVALID_PARAMS: "invalid_params",
  INVALID_STATE: "invalid_state",
  NOT_IMPLEMENTED: "not_implemented",
  UNKNOWN_ACTION: "unknown_action",
  READ_ERROR: "read_error",
  INVALID_JSON: "invalid_json",
  DISPATCH_ERROR: "dispatch_error",
  GATE_REJECTED: "gate_rejected",
});

export const SYSTEM_ACTION_READ_STATUS = Object.freeze({
  READY: "ready",
  ...SYSTEM_ACTION_STATUS,
});

export const TRACKING_STATUS = Object.freeze({
  RUNNING: CONTRACT_STATUS.RUNNING,
  COMPLETED: CONTRACT_STATUS.COMPLETED,
  FAILED: CONTRACT_STATUS.FAILED,
  WAITING_FOLLOWUP: "waiting_followup",
  WAITING_RETRY: "waiting_retry",
});

const ACTIVE_CONTRACT_STATUSES = Object.freeze([
  CONTRACT_STATUS.PENDING,
  CONTRACT_STATUS.RUNNING,
]);

export const TERMINAL_CONTRACT_STATUSES = Object.freeze([
  CONTRACT_STATUS.COMPLETED,
  CONTRACT_STATUS.FAILED,
  CONTRACT_STATUS.ABANDONED,
  CONTRACT_STATUS.CANCELLED,
  CONTRACT_STATUS.AWAITING_INPUT,
]);

const DEFERRED_SYSTEM_ACTION_ACCEPTED_STATUSES = Object.freeze([
  SYSTEM_ACTION_STATUS.DISPATCHED,
  SYSTEM_ACTION_STATUS.QUEUED,
  SYSTEM_ACTION_STATUS.WAKE_FAILED,
]);

const ACTIVE_CONTRACT_STATUS_SET = new Set(ACTIVE_CONTRACT_STATUSES);
const TERMINAL_CONTRACT_STATUS_SET = new Set(TERMINAL_CONTRACT_STATUSES);
const DEFERRED_SYSTEM_ACTION_ACCEPTED_STATUS_SET = new Set(DEFERRED_SYSTEM_ACTION_ACCEPTED_STATUSES);

export function isActiveContractStatus(status) {
  return ACTIVE_CONTRACT_STATUS_SET.has(status);
}

export function isTerminalContractStatus(status) {
  return TERMINAL_CONTRACT_STATUS_SET.has(status);
}

export function isCompletedContractStatus(status) {
  return status === CONTRACT_STATUS.COMPLETED;
}

export function isDeferredSystemActionAcceptedStatus(status) {
  return DEFERRED_SYSTEM_ACTION_ACCEPTED_STATUS_SET.has(status);
}

export function isRunningTrackingStatus(status) {
  return status === TRACKING_STATUS.RUNNING;
}
