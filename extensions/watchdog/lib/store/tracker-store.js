import { tracker } from "../state-collections.js";
import { getTaskHistorySnapshot } from "./task-history-store.js";
import {
  TRACKING_STATUS,
  isRunningTrackingStatus,
  isTerminalContractStatus,
} from "../core/runtime-status.js";
import { resolveTrackingWorkItem } from "../tracking-work-item.js";
import { normalizeContractIdentity } from "../core/normalize.js";

const pendingTrackerRemovalTimers = new Map();
const pendingTrackingContractWaiters = new Map();
const TERMINAL_SESSION_HISTORY_WINDOW_MS = 5 * 60 * 1000;

const TERMINAL_TRACKING_SESSION_REASON = Object.freeze({
  TRACKER_TERMINAL: "tracker_terminal",
  RECENT_TERMINAL_TRACK_END: "recent_terminal_track_end",
});

function normalizeSessionKey(sessionKey) {
  return typeof sessionKey === "string" && sessionKey.trim()
    ? sessionKey.trim().toLowerCase()
    : null;
}

function normalizeAgentId(agentId) {
  return typeof agentId === "string" && agentId.trim() ? agentId.trim() : null;
}

function normalizeContractId(contractId) {
  return normalizeContractIdentity(contractId);
}

function getTrackedContractId(trackingState) {
  return normalizeContractId(trackingState?.contract?.id);
}

function clearPendingTrackerRemoval(sessionKey) {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) return false;
  const existing = pendingTrackerRemovalTimers.get(normalized);
  if (!existing) return false;
  clearTimeout(existing);
  pendingTrackerRemovalTimers.delete(normalized);
  return true;
}

function getTrackingContractWaiters(sessionKey, createIfMissing = false) {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) return null;
  let waiters = pendingTrackingContractWaiters.get(normalized) || null;
  if (!waiters && createIfMissing) {
    waiters = new Set();
    pendingTrackingContractWaiters.set(normalized, waiters);
  }
  return waiters;
}

function settleTrackingContractWaiters(sessionKey, contractId, result) {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  const normalizedContractId = normalizeContractId(contractId);
  if (!normalizedSessionKey) return 0;

  const waiters = getTrackingContractWaiters(normalizedSessionKey);
  if (!waiters || waiters.size === 0) return 0;

  let resolvedCount = 0;
  for (const waiter of [...waiters]) {
    if (waiter.contractId && normalizedContractId && waiter.contractId !== normalizedContractId) {
      continue;
    }
    if (waiter.contractId && !normalizedContractId) {
      continue;
    }
    waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(result);
    resolvedCount += 1;
  }

  if (waiters.size === 0) {
    pendingTrackingContractWaiters.delete(normalizedSessionKey);
  }
  return resolvedCount;
}

function clearTrackingContractWaiters(sessionKey, reason = "session_closed") {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedSessionKey) return 0;
  const waiters = getTrackingContractWaiters(normalizedSessionKey);
  if (!waiters || waiters.size === 0) return 0;

  let cleared = 0;
  for (const waiter of [...waiters]) {
    waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve({
      claimed: false,
      contractId: waiter.contractId,
      reason,
    });
    cleared += 1;
  }
  pendingTrackingContractWaiters.delete(normalizedSessionKey);
  return cleared;
}

export function hasTrackingSession(sessionKey) {
  const normalized = normalizeSessionKey(sessionKey);
  return normalized ? tracker.has(normalized) : false;
}

export function getTrackingState(sessionKey) {
  const normalized = normalizeSessionKey(sessionKey);
  return normalized ? tracker.get(normalized) || null : null;
}

export function getTerminalTrackingSessionReason(sessionKey, now = Date.now()) {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedSessionKey) {
    return null;
  }

  const existing = getTrackingState(normalizedSessionKey);
  if (existing?.lateCompletionLease?.active) {
    return null;
  }
  if (existing?.followUpLease?.active) {
    return null;
  }
  if (existing) {
    if (isRunningTrackingStatus(existing.status)) {
      return null;
    }
    if (
      isTerminalContractStatus(existing.status)
      || isTerminalContractStatus(existing.contract?.status)
    ) {
      return TERMINAL_TRACKING_SESSION_REASON.TRACKER_TERMINAL;
    }
    return null;
  }

  const history = getTaskHistorySnapshot();
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry?.sessionKey !== normalizedSessionKey) continue;
    if (!isTerminalContractStatus(entry?.status)) return null;
    const endMs = Number.isFinite(entry?.endMs) ? entry.endMs : entry?.ts;
    if (!Number.isFinite(endMs) || (now - endMs) <= TERMINAL_SESSION_HISTORY_WINDOW_MS) {
      return TERMINAL_TRACKING_SESSION_REASON.RECENT_TERMINAL_TRACK_END;
    }
    return null;
  }

  return null;
}

export function listTrackingEntries() {
  return [...tracker.entries()];
}

export function listTrackingStates() {
  return [...tracker.values()];
}

export function hasConcurrentTrackingSessionForAgent(agentId, sessionKey) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedAgentId) return false;

  for (const [trackedSessionKey, trackedState] of tracker.entries()) {
    if (normalizedSessionKey && trackedSessionKey === normalizedSessionKey) continue;
    if (trackedState?.agentId === normalizedAgentId) {
      return true;
    }
  }
  return false;
}

export function hasRunningTrackingSessionForAgent(agentId) {
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!normalizedAgentId) return false;

  for (const trackedState of tracker.values()) {
    if (trackedState?.agentId === normalizedAgentId && isRunningTrackingStatus(trackedState?.status)) {
      return true;
    }
  }
  return false;
}

export function hasOtherRunningTrackingSessionForAgent(agentId, sessionKey) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedAgentId) return false;

  for (const [trackedSessionKey, trackedState] of tracker.entries()) {
    if (normalizedSessionKey && trackedSessionKey === normalizedSessionKey) continue;
    if (trackedState?.agentId === normalizedAgentId && isRunningTrackingStatus(trackedState?.status)) {
      return true;
    }
  }
  return false;
}

export function snapshotTrackingSessions(now = Date.now()) {
  return Object.fromEntries(
    [...tracker].map(([sessionKey, trackingState]) => [
      sessionKey,
      (() => {
        const workItem = resolveTrackingWorkItem(trackingState);
        return {
          agentId: trackingState?.agentId || null,
          status: trackingState?.status || null,
          toolCallCount: trackingState?.toolCallTotal || 0,
          lastLabel: trackingState?.lastLabel || null,
          recentToolEvents: Array.isArray(trackingState?.recentToolEvents)
            ? trackingState.recentToolEvents.map((entry) => ({ ...entry }))
            : [],
          hasContract: !!trackingState?.contract,
          workItemId: workItem?.id || null,
          workItemKind: workItem?.kind || null,
          task: workItem?.task || null,
          taskType: workItem?.taskType || null,
          protocolEnvelope: workItem?.protocolEnvelope || null,
          activityCursor: trackingState?.activityCursor || null,
          runtimeObservation: trackingState?.runtimeObservation || null,
          cursor: trackingState?.cursor || null,
          pct: Number.isFinite(trackingState?.pct) ? trackingState.pct : null,
          elapsedMs: Number.isFinite(trackingState?.startMs) ? Math.max(0, now - trackingState.startMs) : 0,
        };
      })(),
    ]),
  );
}

export function snapshotResumableTrackingSessions(now = Date.now()) {
  const sessions = {};
  for (const [sessionKey, trackingState] of tracker.entries()) {
    const followUpLease = trackingState?.followUpLease;
    if (!followUpLease?.active) continue;

    const expiresAt = Number.isFinite(followUpLease.expiresAt)
      ? followUpLease.expiresAt
      : null;
    if (expiresAt && expiresAt <= now) continue;

    sessions[sessionKey] = {
      sessionKey,
      agentId: trackingState?.agentId || null,
      parentSession: trackingState?.parentSession || null,
      startMs: Number.isFinite(trackingState?.startMs) ? trackingState.startMs : now,
      lastLabel: trackingState?.lastLabel || `等待 ${followUpLease.workflow || "system_action delivery"}`,
      followUpLease,
    };
  }
  return sessions;
}

export function restoreResumableTrackingSessions(savedSessions, logger = null, now = Date.now()) {
  if (!savedSessions || typeof savedSessions !== "object") {
    return 0;
  }

  let restored = 0;
  for (const [sessionKey, snapshot] of Object.entries(savedSessions)) {
    if (!snapshot || typeof snapshot !== "object" || tracker.has(sessionKey)) {
      continue;
    }

    const followUpLease = snapshot.followUpLease;
    if (!followUpLease?.active) continue;

    const expiresAt = Number.isFinite(followUpLease.expiresAt)
      ? followUpLease.expiresAt
      : null;
    if (expiresAt && expiresAt <= now) continue;

    rememberTrackingState(sessionKey, {
      sessionKey,
      agentId: snapshot.agentId || null,
      parentSession: snapshot.parentSession || null,
      startMs: Number.isFinite(snapshot.startMs) ? snapshot.startMs : now,
      toolCalls: [],
      recentToolEvents: [],
      toolCallTotal: 0,
      lastLabel: snapshot.lastLabel || `等待 ${followUpLease.workflow || "system_action delivery"}`,
      status: TRACKING_STATUS.WAITING_FOLLOWUP,
      contract: null,
      artifactContext: null,
      stageProjection: null,
      cursor: null,
      pct: null,
      estimatedPhase: "",
      followUpLease,
    });
    restored += 1;
  }

  if (restored > 0) {
    logger?.info?.(`[watchdog] restored ${restored} resumable tracking session(s) from disk`);
  }
  return restored;
}

export function rememberTrackingState(sessionKey, trackingState) {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized || !trackingState || typeof trackingState !== "object") {
    return false;
  }
  clearPendingTrackerRemoval(normalized);
  tracker.set(normalized, trackingState);
  const trackedContractId = getTrackedContractId(trackingState);
  if (trackedContractId) {
    settleTrackingContractWaiters(normalized, trackedContractId, {
      claimed: true,
      contractId: trackedContractId,
      source: "tracker_state",
    });
  }
  return true;
}

export function markTrackingSessionRunning(sessionKey) {
  const existing = getTrackingState(sessionKey);
  if (!existing) return null;
  clearPendingTrackerRemoval(sessionKey);
  existing.status = TRACKING_STATUS.RUNNING;
  return existing;
}

export function deleteTrackingSession(sessionKey) {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) return false;
  clearPendingTrackerRemoval(normalized);
  clearTrackingContractWaiters(normalized, "session_deleted");
  return tracker.delete(normalized);
}

export function clearTrackingStore() {
  for (const [, handle] of pendingTrackerRemovalTimers.entries()) {
    clearTimeout(handle);
  }
  pendingTrackerRemovalTimers.clear();
  for (const sessionKey of pendingTrackingContractWaiters.keys()) {
    clearTrackingContractWaiters(sessionKey, "tracking_store_cleared");
  }
  const count = tracker.size;
  tracker.clear();
  return count;
}

export function getTrackingSessionCount() {
  return tracker.size;
}

export function notifyTrackingContractClaim(sessionKey, contractId) {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  const normalizedContractId = normalizeContractId(contractId);
  if (!normalizedSessionKey || !normalizedContractId) {
    return false;
  }
  settleTrackingContractWaiters(normalizedSessionKey, normalizedContractId, {
    claimed: true,
    contractId: normalizedContractId,
    source: "contract_claim",
  });
  return true;
}

export function waitForTrackingContractClaim(sessionKey, contractId, timeoutMs = 1500) {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  const normalizedContractId = normalizeContractId(contractId);
  if (!normalizedSessionKey || !normalizedContractId) {
    return Promise.resolve({
      claimed: false,
      contractId: normalizedContractId,
      reason: "invalid_wait_target",
    });
  }

  const existing = getTrackingState(normalizedSessionKey);
  if (getTrackedContractId(existing) === normalizedContractId) {
    return Promise.resolve({
      claimed: true,
      contractId: normalizedContractId,
      source: "state_snapshot",
    });
  }

  return new Promise((resolve) => {
    const waiters = getTrackingContractWaiters(normalizedSessionKey, true);
    const waiter = {
      contractId: normalizedContractId,
      resolve,
      timer: null,
    };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      if (waiters.size === 0) {
        pendingTrackingContractWaiters.delete(normalizedSessionKey);
      }
      resolve({
        claimed: false,
        contractId: normalizedContractId,
        reason: "timeout",
      });
    }, Math.max(0, Number(timeoutMs) || 0));
    waiter.timer?.unref?.();
    waiters.add(waiter);
  });
}
