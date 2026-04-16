import { access, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  getTrackingState,
} from "./store/tracker-store.js";
import {
  isRunningTrackingStatus,
  isTerminalContractStatus,
} from "./core/runtime-status.js";
import { runAgentEndPipeline } from "./lifecycle/agent-end-pipeline.js";
import { normalizeStageRunResult } from "./stage-results.js";
import { agentWorkspace } from "./state.js";
import {
  hasDispatchTarget,
  isDispatchTargetBusy,
  releaseDispatchTargetContract,
} from "./routing/dispatch-runtime-state.js";
import { onAgentDone as dispatchGraphPolicyOnAgentDone } from "./routing/dispatch-graph-policy.js";

const PROTOCOL_COMMIT_RECONCILE_GRACE_MS = 400;
const PROTOCOL_COMMIT_DEFERRED_RELEASE_MS = 4000;
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

async function ensureCanonicalCommitArtifactsReady(commitInfo) {
  if (commitInfo?.type !== "stage_result" || !commitInfo?.commitPath) {
    return { ready: true, missingArtifacts: [] };
  }

  try {
    const raw = await readFile(commitInfo.commitPath, "utf8");
    const stageResult = normalizeStageRunResult(JSON.parse(raw));
    if (!stageResult) {
      return { ready: true, missingArtifacts: [] };
    }

    const missingArtifacts = [];
    for (const artifact of stageResult.artifacts) {
      if (artifact?.required === false || typeof artifact?.path !== "string" || !artifact.path.trim()) {
        continue;
      }

      const artifactPath = artifact.path.trim();
      const resolvedPath = artifactPath.startsWith("/")
        ? artifactPath
        : join(dirname(commitInfo.commitPath), basename(artifactPath));

      if (!await fileExists(resolvedPath)) {
        missingArtifacts.push(artifactPath);
      }
    }

    return {
      ready: missingArtifacts.length === 0,
      missingArtifacts,
    };
  } catch {
    return { ready: true, missingArtifacts: [] };
  }
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
    && basename(canonicalTargetPath) === "stage_result.json"
    && isPathInsideDir(canonicalTargetPath, canonicalOutboxDir)
  ) {
    return {
      type: "stage_result",
      fileName: "stage_result.json",
      commitPath: canonicalTargetPath,
    };
  }

  // Unified output_commit detection — any agent writing to contract.output
  // is also a natural completion signal.
  const tracking = sessionKey ? getTrackingState(sessionKey) : null;
  const contractOutput = tracking?.contract?.output;
  if (contractOutput && typeof contractOutput === "string") {
    const canonicalContractOutput = await canonicalizePath(contractOutput);
    if (canonicalTargetPath && canonicalContractOutput && canonicalTargetPath === canonicalContractOutput) {
      return {
        type: "output_commit",
        fileName: basename(canonicalContractOutput),
        commitPath: canonicalTargetPath,
      };
    }
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
  if (!await fileExists(commitInfo.commitPath)) {
    return { reconciled: false, reason: "commit_file_missing" };
  }

  const artifactReadiness = await ensureCanonicalCommitArtifactsReady(commitInfo);
  if (!artifactReadiness.ready) {
    scheduleProtocolCommitReconcile({
      sessionKey: normalizedSessionKey,
      agentId,
      api,
      logger,
      enqueueFn,
      wakePlanner,
      commitInfo,
      observedAt: Date.now(),
    });
    return {
      reconciled: false,
      reason: "commit_artifacts_pending",
      missingArtifacts: artifactReadiness.missingArtifacts,
    };
  }

  logger?.info?.(
    `[watchdog] protocol commit reconcile: ${normalizedSessionKey} `
    + `(${commitInfo.type || "unknown"} @ ${commitInfo.fileName || "unknown"})`,
  );

  await runAgentEndPipeline({
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
    reason: "agent_end_pipeline_completed",
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
