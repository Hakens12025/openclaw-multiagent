import { readFile, stat } from "node:fs/promises";

import {
  materializeTaskStagePlan,
  materializeTaskStageRuntime,
} from "./task-stage-plan.js";
import { getTaskHistorySnapshot } from "./store/task-history-store.js";

function normalizeObjectRecord(value) {
  return value && typeof value === "object" ? value : null;
}

function parseStageIndex(stageId) {
  const match = /^stage-(\d+)$/u.exec(String(stageId || ""));
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function countMarkdownHeadings(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) return 0;
  const matches = markdown.match(/^#{1,6}\s+\S+/gmu);
  return Array.isArray(matches) ? matches.length : 0;
}

function countNonEmptyParagraphs(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) return 0;
  return markdown
    .split(/\n\s*\n/u)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .length;
}

function isStageScaffoldLine(line) {
  const normalized = String(line || "").trim();
  if (!normalized) return false;
  if (/^\[STAGE(?:\s+\d+)?\]\s+/iu.test(normalized)) return true;
  return /^-\s*(目标|交付|完成标准|goal|deliverable|completion(?:\s*criteria)?|criteria)\s*[：:]/iu.test(normalized);
}

function analyzeOutputContent(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) {
    return {
      headingCount: 0,
      paragraphCount: 0,
      substantiveCharCount: 0,
      scaffoldLineCount: 0,
      isScaffoldOnly: false,
    };
  }

  const lines = markdown.split(/\r?\n/u);
  const materialLines = [];
  let scaffoldLineCount = 0;

  for (const line of lines) {
    if (isStageScaffoldLine(line)) {
      scaffoldLineCount += 1;
      continue;
    }
    materialLines.push(line);
  }

  const materialContent = materialLines.join("\n").trim();
  return {
    headingCount: countMarkdownHeadings(materialContent),
    paragraphCount: countNonEmptyParagraphs(materialContent),
    substantiveCharCount: materialContent.length,
    scaffoldLineCount,
    isScaffoldOnly: materialContent.length === 0 && scaffoldLineCount > 0,
  };
}

async function statFile(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

async function readUtf8File(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function observeOutputArtifact(outputPath, previousObservation = null, observedAt = Date.now()) {
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    return null;
  }

  const normalizedPath = outputPath.trim();
  const fileStats = await statFile(normalizedPath);
  if (!fileStats?.isFile?.()) {
    return null;
  }

  const previous = normalizeObjectRecord(previousObservation);
  const nextBaseObservation = {
    path: normalizedPath,
    size: Number.isFinite(fileStats.size) ? fileStats.size : 0,
    mtimeMs: Number.isFinite(fileStats.mtimeMs) ? fileStats.mtimeMs : null,
    observedAt,
  };

  if (
    previous
    && previous.path === nextBaseObservation.path
    && previous.size === nextBaseObservation.size
    && previous.mtimeMs === nextBaseObservation.mtimeMs
    && Number.isFinite(previous.headingCount)
    && Number.isFinite(previous.paragraphCount)
    && Number.isFinite(previous.substantiveCharCount)
    && typeof previous.isScaffoldOnly === "boolean"
  ) {
    return {
      ...previous,
      observedAt,
    };
  }

  const raw = await readUtf8File(normalizedPath);
  const contentAnalysis = analyzeOutputContent(raw);
  return {
    ...nextBaseObservation,
    headingCount: contentAnalysis.headingCount,
    paragraphCount: contentAnalysis.paragraphCount,
    substantiveCharCount: contentAnalysis.substantiveCharCount,
    scaffoldLineCount: contentAnalysis.scaffoldLineCount,
    isScaffoldOnly: contentAnalysis.isScaffoldOnly,
  };
}

function computeOutputBoost(outputArtifact, totalStages) {
  const maxBoost = Math.max(0, totalStages - 1);
  if (!outputArtifact || maxBoost === 0) {
    return 0;
  }
  if (outputArtifact.isScaffoldOnly) {
    return 0;
  }

  let boost = 0;
  const size = Number.isFinite(outputArtifact.substantiveCharCount)
    ? outputArtifact.substantiveCharCount
    : (Number.isFinite(outputArtifact.size) ? outputArtifact.size : 0);
  const headingCount = Number.isFinite(outputArtifact.headingCount) ? outputArtifact.headingCount : 0;
  const paragraphCount = Number.isFinite(outputArtifact.paragraphCount) ? outputArtifact.paragraphCount : 0;

  if (size > 0 || paragraphCount > 0) {
    boost = 1;
  }
  if (size >= 4 * 1024 || headingCount >= 2 || paragraphCount >= 6) {
    boost = 2;
  }
  if (size >= 12 * 1024 || headingCount >= 3 || paragraphCount >= 12) {
    boost = 3;
  }

  return Math.min(boost, maxBoost);
}

function countCompletedSessionBoundaries(history, contractId) {
  if (typeof contractId !== "string" || !contractId.trim()) {
    return 0;
  }

  const seenSessionBoundaries = new Set();
  for (const entry of Array.isArray(history) ? history : []) {
    if (entry?.contractId !== contractId) continue;
    const endMs = Number.isFinite(entry?.endMs) ? entry.endMs : null;
    if (!Number.isFinite(endMs)) continue;
    const sessionKey = typeof entry?.sessionKey === "string" && entry.sessionKey.trim()
      ? entry.sessionKey.trim()
      : `anonymous:${endMs}:${seenSessionBoundaries.size}`;
    seenSessionBoundaries.add(sessionKey);
  }
  return seenSessionBoundaries.size;
}

function resolveExistingRuntimeState(stageRuntime, stageCount) {
  const normalizedRuntime = normalizeObjectRecord(stageRuntime);
  const completedStageIds = Array.isArray(normalizedRuntime?.completedStageIds)
    ? normalizedRuntime.completedStageIds.filter(Boolean)
    : [];
  const parsedCurrentStageIndex = parseStageIndex(normalizedRuntime?.currentStageId);
  const completedCount = Math.min(completedStageIds.length, stageCount);
  const terminalCompleted = !normalizedRuntime?.currentStageId && completedCount >= stageCount;

  return {
    runtime: normalizedRuntime,
    completedCount,
    activeStageIndex: Math.min(
      stageCount,
      Math.max(parsedCurrentStageIndex || 1, completedCount + 1),
    ),
    terminalCompleted,
  };
}

function hasStageRuntimeChanged(previousRuntime, nextRuntime) {
  const previous = normalizeObjectRecord(previousRuntime);
  const next = normalizeObjectRecord(nextRuntime);
  if (!previous || !next) return previous !== next;

  const previousCompleted = Array.isArray(previous.completedStageIds) ? previous.completedStageIds : [];
  const nextCompleted = Array.isArray(next.completedStageIds) ? next.completedStageIds : [];
  if (previous.currentStageId !== next.currentStageId) return true;
  if (previousCompleted.length !== nextCompleted.length) return true;
  for (let index = 0; index < previousCompleted.length; index += 1) {
    if (previousCompleted[index] !== nextCompleted[index]) return true;
  }
  return false;
}

function buildAdvancedStageRuntime(stagePlan, previousRuntime, activeStageIndex) {
  const stages = Array.isArray(stagePlan?.stages) ? stagePlan.stages : [];
  if (stages.length === 0) {
    return null;
  }

  const clampedActiveStageIndex = Math.min(
    stages.length,
    Math.max(1, Math.trunc(activeStageIndex || 1)),
  );
  const completedStageIds = stages
    .slice(0, Math.max(0, clampedActiveStageIndex - 1))
    .map((stage) => stage.id);
  const nextRuntime = materializeTaskStageRuntime({
    stagePlan,
    stageRuntime: {
      ...normalizeObjectRecord(previousRuntime),
      version: Number.isFinite(previousRuntime?.version)
        ? Math.max(1, Math.trunc(previousRuntime.version)) + 1
        : 2,
      currentStageId: stages[clampedActiveStageIndex - 1]?.id || null,
      completedStageIds,
    },
  });
  return nextRuntime;
}

export async function syncTrackingRuntimeStageProgress(
  trackingState,
  {
    history = null,
    currentSessionBoundary = false,
    observedAt = Date.now(),
  } = {},
) {
  if (!trackingState || typeof trackingState !== "object") {
    return {
      stageRuntime: null,
      runtimeObservation: null,
    };
  }

  const contract = normalizeObjectRecord(trackingState.contract);
  if (!contract) {
    return {
      stageRuntime: null,
      runtimeObservation: trackingState.runtimeObservation || null,
    };
  }

  const stagePlan = materializeTaskStagePlan({
    contractId: contract.id || null,
    stagePlan: contract.stagePlan,
    phases: contract.phases,
  });
  if (!stagePlan || !Array.isArray(stagePlan.stages) || stagePlan.stages.length === 0) {
    return {
      stageRuntime: contract.stageRuntime || null,
      runtimeObservation: trackingState.runtimeObservation || null,
    };
  }

  const normalizedRuntime = materializeTaskStageRuntime({
    stagePlan,
    stageRuntime: contract.stageRuntime,
  });
  const existingRuntimeState = resolveExistingRuntimeState(normalizedRuntime, stagePlan.stages.length);
  const currentRuntimeObservation = normalizeObjectRecord(trackingState.runtimeObservation) || {};
  const outputArtifact = await observeOutputArtifact(
    contract.output,
    currentRuntimeObservation.outputArtifact,
    observedAt,
  );
  const completedSessionCount = countCompletedSessionBoundaries(
    history || getTaskHistorySnapshot(),
    contract.id,
  );
  const observedBoundaryCount = completedSessionCount + (currentSessionBoundary ? 1 : 0);
  const outputBoost = computeOutputBoost(outputArtifact, stagePlan.stages.length);
  const derivedActiveStageIndex = Math.min(
    stagePlan.stages.length,
    Math.max(1, observedBoundaryCount + 1 + outputBoost),
  );
  const activeStageIndex = Math.max(existingRuntimeState.activeStageIndex, derivedActiveStageIndex);

  let nextStageRuntime = normalizedRuntime;
  if (!existingRuntimeState.terminalCompleted) {
    const candidateRuntime = buildAdvancedStageRuntime(stagePlan, normalizedRuntime, activeStageIndex);
    if (hasStageRuntimeChanged(normalizedRuntime, candidateRuntime)) {
      nextStageRuntime = candidateRuntime;
      trackingState.contract = {
        ...contract,
        stageRuntime: candidateRuntime,
        updatedAt: observedAt,
      };
    }
  }

  trackingState.runtimeObservation = {
    ...currentRuntimeObservation,
    ...(outputArtifact ? { outputArtifact } : {}),
    progressEvidence: {
      source: "runtime_stage_progress",
      observedAt,
      completedSessionCount,
      currentSessionBoundary: Boolean(currentSessionBoundary),
      observedBoundaryCount,
      outputBoost,
      activeStageIndex: existingRuntimeState.terminalCompleted
        ? stagePlan.stages.length
        : activeStageIndex,
      totalStages: stagePlan.stages.length,
    },
  };

  return {
    stageRuntime: trackingState.contract?.stageRuntime || nextStageRuntime || null,
    runtimeObservation: trackingState.runtimeObservation,
  };
}
