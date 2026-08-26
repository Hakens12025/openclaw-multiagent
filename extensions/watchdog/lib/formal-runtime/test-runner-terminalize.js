import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { mutateContractById } from "../contract/contracts.js";
import { normalizeContractIdentity, normalizeString } from "../core/normalize.js";
import { clearSession as clearLoopDetectionSession } from "../runtime/execution-hard-stop-registry.js";
import { resolveSessionEpochKey } from "../runtime/session-epoch-key.js";
import { refreshTrackingProjection } from "../stage/stage-projection.js";
import { recordTaskHistory } from "../store/task-history-store.js";
import {
  deleteTrackingSession,
  listTrackingEntries,
} from "../store/tracker-store.js";
import { broadcast, buildProgressPayload } from "../transport/sse.js";
import { removeDispatchContract } from "../routing/dispatch/dispatch-runtime-state.js";
import { drainIdleDispatchTargets } from "../routing/dispatch/dispatch-graph-policy.js";
import { persistState } from "../state.js";
import { normalizeTerminalOutcome } from "../contract/terminal-outcome.js";

function normalizeTerminalizeStatus(status) {
  return status === CONTRACT_STATUS.COMPLETED
    ? CONTRACT_STATUS.COMPLETED
    : CONTRACT_STATUS.FAILED;
}

function closeTrackingSessionsForContract(contractId, {
  status,
  terminalOutcome,
  logger = null,
} = {}) {
  const normalizedContractId = normalizeContractIdentity(contractId);
  if (!normalizedContractId) {
    return {
      removed: 0,
      sessions: [],
    };
  }

  const sessions = [];
  for (const [sessionKey, trackingState] of listTrackingEntries()) {
    if (normalizeContractIdentity(trackingState?.contract?.id) !== normalizedContractId) {
      continue;
    }

    trackingState.status = status;
    trackingState.lastLabel = terminalOutcome?.summary || terminalOutcome?.reason || "test runner terminalized contract";
    if (trackingState.contract && typeof trackingState.contract === "object") {
      trackingState.contract.status = status;
      trackingState.contract.terminalOutcome = terminalOutcome;
    }
    refreshTrackingProjection(trackingState);

    const trackPayload = buildProgressPayload(trackingState);
    broadcast("track_end", trackPayload);
    recordTaskHistory(trackPayload);

    deleteTrackingSession(sessionKey);
    clearLoopDetectionSession(resolveSessionEpochKey(trackingState) || sessionKey);
    sessions.push({
      sessionKey,
      agentId: trackingState?.agentId || null,
    });
    logger?.info?.(`[test-runner] terminalized tracking session ${sessionKey} for ${contractId}`);
  }

  return {
    removed: sessions.length,
    sessions,
  };
}

export async function terminalizeContractForTestRunner({
  contractId,
  status,
  source = "test_runner",
  reason = "test_terminalize",
  summary = null,
  retryable = false,
  logger = null,
  api = null,
} = {}) {
  const normalizedContractId = normalizeString(contractId);
  if (!normalizedContractId) {
    throw new Error("missing contractId");
  }

  const terminalStatus = normalizeTerminalizeStatus(status);
  const terminalOutcome = normalizeTerminalOutcome({
    status: terminalStatus,
    source,
    reason,
    summary,
    retryable: retryable === true,
  }, {
    terminalStatus,
  });

  await mutateContractById(normalizedContractId, logger, (contract) => {
    contract.status = terminalStatus;
    contract.terminalOutcome = terminalOutcome;
  }, {
    touchUpdatedAt: true,
    logMessage: (contract) => `[watchdog] contract ${contract.id} → ${terminalStatus}`,
  });
  // 审查③(次要):测试终态化也补 closed——事件账真值不留 open 尾巴。
  try {
    const snapshot = await readContractSnapshotById(normalizedContractId);
    if (snapshot) void wireClosed({ contract: snapshot, terminalStatus, reason, logger });
  } catch { /* 快照缺失 → 无谱系可线,跳过 */ }

  const trackingCleanup = closeTrackingSessionsForContract(normalizedContractId, {
    status: terminalStatus,
    terminalOutcome,
    logger,
  });
  const dispatchRemoval = await removeDispatchContract(normalizedContractId, logger);
  await drainIdleDispatchTargets(api, logger);
  await persistState(logger);

  return {
    ok: true,
    contractId: normalizedContractId,
    status: terminalStatus,
    terminalOutcome,
    trackingCleanup,
    dispatchRemoval,
  };
}
