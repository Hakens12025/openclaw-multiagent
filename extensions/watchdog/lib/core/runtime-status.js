export const CONTRACT_STATUS = Object.freeze({
  DRAFT: "draft",
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  ABANDONED: "abandoned",
  CANCELLED: "cancelled",
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
  DISPATCH_ERROR: "dispatch_error",
  GATE_REJECTED: "gate_rejected",
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
]);

const DEFERRED_SYSTEM_ACTION_ACCEPTED_STATUSES = Object.freeze([
  SYSTEM_ACTION_STATUS.DISPATCHED,
  SYSTEM_ACTION_STATUS.QUEUED,
  SYSTEM_ACTION_STATUS.WAKE_FAILED,
]);

// 受理凭证意义上的"已受理"(工具面 receipt.accepted / 考官动作核验共用):
// 比 deferred 家族少一个 WAKE_FAILED——受理凭证对唤醒失败如实报 accepted:false。
const ACCEPTED_SYSTEM_ACTION_RECEIPT_STATUSES = Object.freeze([
  SYSTEM_ACTION_STATUS.DISPATCHED,
  SYSTEM_ACTION_STATUS.QUEUED,
]);

const ACTIVE_CONTRACT_STATUS_SET = new Set(ACTIVE_CONTRACT_STATUSES);
const TERMINAL_CONTRACT_STATUS_SET = new Set(TERMINAL_CONTRACT_STATUSES);
const DEFERRED_SYSTEM_ACTION_ACCEPTED_STATUS_SET = new Set(DEFERRED_SYSTEM_ACTION_ACCEPTED_STATUSES);
const ACCEPTED_SYSTEM_ACTION_RECEIPT_STATUS_SET = new Set(ACCEPTED_SYSTEM_ACTION_RECEIPT_STATUSES);

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

export function isAcceptedSystemActionReceiptStatus(status) {
  return ACCEPTED_SYSTEM_ACTION_RECEIPT_STATUS_SET.has(status);
}

export function isRunningTrackingStatus(status) {
  return status === TRACKING_STATUS.RUNNING;
}
