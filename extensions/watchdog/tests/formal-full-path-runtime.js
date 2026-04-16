const ACCEPTED_SYSTEM_ACTION_STATUSES = new Set(["dispatched", "queued", "wake_failed"]);
const REJECTED_ROOT_STATUSES = new Set(["draft", "failed", "abandoned"]);
const DEFAULT_FULL_PATH_CASE_POLICY = Object.freeze({
  allowLoopElevation: false,
  requiredExecutionMode: "worker",
});

const FULL_PATH_CASE_POLICIES = Object.freeze({
  "complex-02": Object.freeze({
    allowLoopElevation: false,
    requiredExecutionMode: "worker",
  }),
});

export function getFormalFullPathCasePolicy(testCaseOrId) {
  const caseId = typeof testCaseOrId === "string"
    ? testCaseOrId.trim()
    : String(testCaseOrId?.id || "").trim();
  return FULL_PATH_CASE_POLICIES[caseId] || DEFAULT_FULL_PATH_CASE_POLICY;
}

export function getContractSystemActionType(contractRuntime) {
  return contractRuntime?.systemAction?.type
    || contractRuntime?.systemAction?.actionType
    || null;
}

export function isAcceptedSystemActionStatus(status) {
  return ACCEPTED_SYSTEM_ACTION_STATUSES.has(String(status || "").trim());
}

export function classifyFullPathExecutionMode({ contractRuntime } = {}) {
  if (!contractRuntime || typeof contractRuntime !== "object") {
    return {
      mode: "worker",
      accepted: true,
      targetAgent: null,
      reason: null,
    };
  }

  const systemActionType = getContractSystemActionType(contractRuntime);
  const systemActionStatus = contractRuntime?.systemAction?.status || null;
  const targetAgent = contractRuntime?.systemAction?.targetAgent
    || contractRuntime?.followUp?.targetAgent
    || null;
  const rootStatus = contractRuntime?.status || null;

  if (systemActionType === "start_loop") {
    if (!REJECTED_ROOT_STATUSES.has(rootStatus) && isAcceptedSystemActionStatus(systemActionStatus)) {
      return {
        mode: "loop",
        accepted: true,
        targetAgent,
        reason: null,
      };
    }

    return {
      mode: "failed",
      accepted: false,
      targetAgent,
      reason: contractRuntime?.systemAction?.error
        || (systemActionStatus ? `start_loop returned ${systemActionStatus}` : "start_loop not accepted"),
    };
  }

  return {
    mode: "worker",
    accepted: true,
    targetAgent: null,
    reason: null,
  };
}
