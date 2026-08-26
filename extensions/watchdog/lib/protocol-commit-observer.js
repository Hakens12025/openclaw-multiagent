import { stat } from "node:fs/promises";
import { join } from "node:path";

import { agentWorkspace } from "./state.js";
import { RUNTIME_RESULT_FILE } from "./protocol/protocol-primitives.js";

function normalizeObservationRecord(value) {
  return value && typeof value === "object" ? value : null;
}

async function statFile(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

function buildFileObservation(path, stats, observedAt) {
  return {
    path,
    mtimeMs: Number.isFinite(stats?.mtimeMs) ? stats.mtimeMs : null,
    size: Number.isFinite(stats?.size) ? stats.size : null,
    observedAt,
  };
}

function hasObservationChanged(previousObservation, nextObservation) {
  const previous = normalizeObservationRecord(previousObservation);
  if (!previous) return true;
  return previous.path !== nextObservation.path
    || previous.mtimeMs !== nextObservation.mtimeMs
    || previous.size !== nextObservation.size;
}

export async function observeCanonicalRuntimeResultCommit({
  trackingState,
  agentId,
  observedAt = Date.now(),
} = {}) {
  if (!trackingState || typeof trackingState !== "object") {
    return null;
  }
  if (typeof agentId !== "string" || !agentId.trim()) {
    return null;
  }

  const runtimeResultPath = join(agentWorkspace(agentId.trim()), "outbox", RUNTIME_RESULT_FILE);
  const runtimeResultStats = await statFile(runtimeResultPath);
  if (!runtimeResultStats?.isFile?.()) {
    return null;
  }

  const nextObservation = buildFileObservation(runtimeResultPath, runtimeResultStats, observedAt);
  const currentRuntimeObservation = normalizeObservationRecord(trackingState.runtimeObservation) || {};
  const currentRuntimeResultObservation = normalizeObservationRecord(currentRuntimeObservation.runtimeResultCommit);

  if (!hasObservationChanged(currentRuntimeResultObservation, nextObservation)) {
    return null;
  }

  trackingState.runtimeObservation = {
    ...currentRuntimeObservation,
    runtimeResultCommit: nextObservation,
  };

  return {
    type: "runtime_result",
    fileName: RUNTIME_RESULT_FILE,
    commitPath: runtimeResultPath,
  };
}
