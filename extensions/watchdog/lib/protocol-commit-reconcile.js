import { access, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  getTrackingState,
} from "./store/tracker-store.js";
import {
  isRunningTrackingStatus,
  isTerminalContractStatus,
} from "./core/runtime-status.js";
import { runAgentEndLifecycle } from "./lifecycle/agent-end-lifecycle.js";
import { agentWorkspace } from "./state.js";
import { RUNTIME_RESULT_FILE } from "./protocol-primitives.js";
import {
  hasDispatchTarget,
  isDispatchTargetBusy,
  releaseDispatchTargetContract,
} from "./routing/dispatch-runtime-state.js";
import { onAgentDone as dispatchGraphPolicyOnAgentDone } from "./routing/dispatch-graph-policy.js";

// agent_end 权威：真 agent_end(LLM 会话结束)先提交+路由, reconcile 只作长窗兜底——
// 仅当 agent 写了 runtime_result 却长时间(>30s)既无后续工具调用、也没 fire agent_end(卡住)
// 才由 reconcile 收尾。短窗(原 400ms)会卡进 LLM 写 runtime_result→写交付物的思考间隙、
// 抢在 agent 真结束前提交, 导致后写的交付物被归档丢失(researcher 'session archived' 根因之一)。
let PROTOCOL_COMMIT_RECONCILE_GRACE_MS = 30000;
const PROTOCOL_COMMIT_DEFERRED_RELEASE_MS = 4000;

// 测试缝：把 30s 兜底窗调小，避免时序测试真等 30s（生产恒为默认 30000，从不调用此函数）。
export function __setProtocolCommitReconcileGraceMsForTest(ms) {
  const next = Number(ms);
  PROTOCOL_COMMIT_RECONCILE_GRACE_MS = Number.isFinite(next) && next > 0 ? next : 30000;
}

const pendingProtocolCommitTimers = new Map();
const pendingProtocolCommitDeferredReleases = new Map();

function getTrackingLastActivityTs(trackingState) {
  if (!trackingState) return 0;
  const lastToolCall = Array.isArray(trackingState.toolCalls) && trackingState.toolCalls.length > 0
    ? trackingState.toolCalls[trackingState.toolCalls.length - 1]
    : null;
  return lastToolCall?.ts || trackingState.startMs || 0;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileMtimeMs(filePath) {
  try {
    const stats = await stat(filePath);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

function normalizeSessionKey(sessionKey) {
  return typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : null;
}

async function canonicalizePath(candidatePath) {
  const normalizedPath = typeof candidatePath === "string" && candidatePath.trim()
    ? resolve(candidatePath.trim())
    : null;
  if (!normalizedPath) return null;

  let currentPath = normalizedPath;
  const remainder = [];
  while (true) {
    try {
      const resolvedExistingPath = await realpath(currentPath);
      return remainder.length > 0
        ? join(resolvedExistingPath, ...remainder)
        : resolvedExistingPath;
    } catch {
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        return normalizedPath;
      }
      remainder.unshift(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

function isPathInsideDir(filePath, dirPath) {
  if (!filePath || !dirPath) return false;
  const normalizedFilePath = resolve(filePath);
  const normalizedDirPath = resolve(dirPath);
  return normalizedFilePath === normalizedDirPath
    || normalizedFilePath.startsWith(`${normalizedDirPath}${sep}`);
}

function clearPendingTimer(sessionKey) {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedSessionKey) return false;
  const pending = pendingProtocolCommitTimers.get(normalizedSessionKey);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingProtocolCommitTimers.delete(normalizedSessionKey);
  return true;
}

function clearPendingDeferredRelease(sessionKey) {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedSessionKey) return null;
  const pending = pendingProtocolCommitDeferredReleases.get(normalizedSessionKey) || null;
  if (!pending) return null;
  clearTimeout(pending.timer);
  pendingProtocolCommitDeferredReleases.delete(normalizedSessionKey);
  return pending;
}

async function performProtocolCommitDeferredRelease(entry) {
  if (!entry?.agentId) {
    return { released: false, reason: "missing_agent_id" };
  }

  if (hasDispatchTarget(entry.agentId) && isDispatchTargetBusy(entry.agentId)) {
    await releaseDispatchTargetContract({
      agentId: entry.agentId,
      logger: entry.logger,
    });
  }

  try {
    await dispatchGraphPolicyOnAgentDone(entry.agentId, entry.api, entry.logger, {
      retainBusy: false,
    });
  } catch (error) {
    entry.logger?.warn?.(
      `[watchdog] deferred protocol-commit release failed for `
      + `${entry.sessionKey}: ${error.message}`,
    );
    return { released: false, reason: "dispatch_cleanup_failed" };
  }

  entry.logger?.info?.(
    `[watchdog] deferred protocol-commit release drained ${entry.agentId} `
    + `for ${entry.sessionKey}`,
  );
  return { released: true, reason: "deferred_release_completed" };
}

function scheduleProtocolCommitDeferredRelease({
  sessionKey,
  agentId,
  api,
  logger,
} = {}) {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedSessionKey || !agentId) {
    return { armed: false, reason: "invalid_deferred_release_target" };
  }

  clearPendingDeferredRelease(normalizedSessionKey);

  const entry = {
    sessionKey: normalizedSessionKey,
    agentId,
    api,
    logger,
    timer: null,
  };
  const timer = setTimeout(() => {
    pendingProtocolCommitDeferredReleases.delete(normalizedSessionKey);
    void performProtocolCommitDeferredRelease(entry);
  }, PROTOCOL_COMMIT_DEFERRED_RELEASE_MS);
  timer?.unref?.();
  entry.timer = timer;

  pendingProtocolCommitDeferredReleases.set(normalizedSessionKey, entry);
  logger?.info?.(
    `[watchdog] deferred protocol-commit release armed for ${normalizedSessionKey} `
    + `(${PROTOCOL_COMMIT_DEFERRED_RELEASE_MS}ms)`,
  );
  return { armed: true, reason: "deferred_release_grace_started" };
}

export function clearProtocolCommitReconcile(sessionKey) {
  return clearPendingTimer(sessionKey);
}

export function clearProtocolCommitReconcileState() {
  for (const pending of pendingProtocolCommitTimers.values()) {
    clearTimeout(pending.timer);
  }
  pendingProtocolCommitTimers.clear();
  for (const pending of pendingProtocolCommitDeferredReleases.values()) {
    clearTimeout(pending.timer);
  }
  pendingProtocolCommitDeferredReleases.clear();
}

export function getProtocolCommitReconcileStateCounts() {
  return {
    pendingReconcileTimers: pendingProtocolCommitTimers.size,
    pendingDeferredReleases: pendingProtocolCommitDeferredReleases.size,
  };
}

export async function flushProtocolCommitDeferredRelease(sessionKey) {
  const pending = clearPendingDeferredRelease(sessionKey);
  if (!pending) {
    return { released: false, reason: "deferred_release_missing" };
  }
  return performProtocolCommitDeferredRelease(pending);
}

export async function classifyCanonicalProtocolCommit({ agentId, targetPath, sessionKey }) {
  const canonicalTargetPath = await canonicalizePath(targetPath);
  const canonicalOutboxDir = agentId
    ? await canonicalizePath(join(agentWorkspace(agentId), "outbox"))
    : null;
  if (
    canonicalTargetPath
    && canonicalOutboxDir
    && basename(canonicalTargetPath) === RUNTIME_RESULT_FILE
    && isPathInsideDir(canonicalTargetPath, canonicalOutboxDir)
  ) {
    return {
      type: "runtime_result",
      fileName: RUNTIME_RESULT_FILE,
      commitPath: canonicalTargetPath,
    };
  }

  return null;
}

async function runProtocolCommitReconcileNow({
  sessionKey,
  agentId,
  api,
  logger,
  enqueueFn,
  wakePlanner,
  commitInfo,
} = {}) {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedSessionKey || !commitInfo?.commitPath) {
    return { reconciled: false, reason: "invalid_reconcile_target" };
  }

  clearPendingTimer(normalizedSessionKey);

  const trackingState = getTrackingState(normalizedSessionKey);
  if (!trackingState) {
    return { reconciled: false, reason: "tracking_missing" };
  }
  if (trackingState.agentId !== agentId) {
    return { reconciled: false, reason: "agent_mismatch" };
  }
  if (!isRunningTrackingStatus(trackingState.status)) {
    return { reconciled: false, reason: "tracking_not_running" };
  }
  if (isTerminalContractStatus(trackingState.contract?.status)) {
    return { reconciled: false, reason: "contract_already_terminal" };
  }
  if (commitInfo.allowMissing !== true && !await fileExists(commitInfo.commitPath)) {
    return { reconciled: false, reason: "commit_file_missing" };
  }

  // 防陈旧产物收割：只认本合约绑定(startMs)之后写入的 runtime_result。
  // 否则上一个任务残留在 outbox 的旧 runtime_result 会被当作本轮结果提前提交+路由，
  // 在本轮 agent 真正写出产物前就推进 loop（reviewer 空审、"session archived" 根因）。
  if (commitInfo.allowMissing !== true) {
    const contractStartMs = Number(trackingState.startMs) || 0;
    if (contractStartMs > 0) {
      const commitMtimeMs = await fileMtimeMs(commitInfo.commitPath);
      if (commitMtimeMs !== null && commitMtimeMs < contractStartMs) {
        return { reconciled: false, reason: "commit_file_stale" };
      }
    }
  }

  logger?.info?.(
    `[watchdog] protocol commit reconcile: ${normalizedSessionKey} `
    + `(${commitInfo.type || "unknown"} @ ${commitInfo.fileName || "unknown"})`,
  );

  await runAgentEndLifecycle({
    event: {
      success: true,
      synthetic: true,
      protocolBoundary: "canonical_outbox_commit",
      commitType: commitInfo.type || null,
    },
    ctx: {
      sessionKey: normalizedSessionKey,
      agentId,
    },
    api,
    logger,
    enqueueFn,
    wakePlanner,
    trackingState,
  });

  scheduleProtocolCommitDeferredRelease({
    sessionKey: normalizedSessionKey,
    agentId,
    api,
    logger,
  });

  return {
    reconciled: true,
    reason: "agent_end_lifecycle_completed",
  };
}

async function reconcileWhenQuiet({
  sessionKey,
  agentId,
  api,
  logger,
  enqueueFn,
  wakePlanner,
  commitInfo,
  observedAt,
}) {
  const trackingState = getTrackingState(sessionKey);
  if (!trackingState) {
    clearPendingTimer(sessionKey);
    return { reconciled: false, reason: "tracking_missing" };
  }

  const lastActivityTs = getTrackingLastActivityTs(trackingState);
  const silenceMs = Math.max(0, Date.now() - lastActivityTs);
  if (lastActivityTs > observedAt && silenceMs < PROTOCOL_COMMIT_RECONCILE_GRACE_MS) {
    scheduleProtocolCommitReconcile({
      sessionKey,
      agentId,
      api,
      logger,
      enqueueFn,
      wakePlanner,
      commitInfo,
      observedAt: lastActivityTs,
    });
    return { reconciled: false, reason: "rearmed_after_late_activity" };
  }

  return runProtocolCommitReconcileNow({
    sessionKey,
    agentId,
    api,
    logger,
    enqueueFn,
    wakePlanner,
    commitInfo,
  });
}

export function scheduleProtocolCommitReconcile({
  sessionKey,
  agentId,
  api,
  logger,
  enqueueFn,
  wakePlanner,
  commitInfo,
  observedAt = Date.now(),
} = {}) {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  if (!normalizedSessionKey || !commitInfo?.commitPath) {
    return { armed: false, reason: "invalid_reconcile_target" };
  }

  clearPendingTimer(normalizedSessionKey);

  const timer = setTimeout(() => {
    void reconcileWhenQuiet({
      sessionKey: normalizedSessionKey,
      agentId,
      api,
      logger,
      enqueueFn,
      wakePlanner,
      commitInfo,
      observedAt,
    });
  }, PROTOCOL_COMMIT_RECONCILE_GRACE_MS);
  timer?.unref?.();

  pendingProtocolCommitTimers.set(normalizedSessionKey, {
    timer,
    observedAt,
    commitInfo,
  });

  return {
    armed: true,
    reason: "grace_timer_started",
  };
}
