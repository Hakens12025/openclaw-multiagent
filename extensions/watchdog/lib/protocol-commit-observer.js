import { stat } from "node:fs/promises";
import { join } from "node:path";

import { agentWorkspace } from "./state.js";

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

export async function observeCanonicalStageResultCommit({
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

  const stageResultPath = join(agentWorkspace(agentId.trim()), "outbox", "stage_result.json");
  const stageResultStats = await statFile(stageResultPath);
  if (!stageResultStats?.isFile?.()) {
    return null;
  }

  const nextObservation = buildFileObservation(stageResultPath, stageResultStats, observedAt);
  const currentRuntimeObservation = normalizeObservationRecord(trackingState.runtimeObservation) || {};
  const currentStageResultObservation = normalizeObservationRecord(currentRuntimeObservation.stageResultCommit);

  if (!hasObservationChanged(currentStageResultObservation, nextObservation)) {
    return null;
  }

  trackingState.runtimeObservation = {
    ...currentRuntimeObservation,
    stageResultCommit: nextObservation,
  };

  return {
    type: "stage_result",
    fileName: "stage_result.json",
    commitPath: stageResultPath,
  };
}
