// lib/runtime-mailbox-outbox-helpers.js — shared runtime mailbox outbox helpers

import { copyFile, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { OC } from "../state.js";
import { evictContractSnapshotByPath } from "../store/contract-store.js";
import { ARTIFACT_TYPES } from "../protocol-primitives.js";
import {
  normalizeStageCompletion,
  normalizeStageRunResult,
} from "../stage-results.js";

const OUTPUT_DIR = join(OC, "workspaces", "controller", "output");

export { OUTPUT_DIR };

export async function removeFileQuietly(path) {
  await unlink(path).catch(() => {});
  evictContractSnapshotByPath(path);
}

export function normalizeManifestFilePath(filePath) {
  const normalized = typeof filePath === "string" && filePath.trim()
    ? filePath.trim()
    : "";
  if (!normalized) return null;
  return basename(normalized);
}

export function findManifestArtifactFile(manifest, type, files, fallbackNames = []) {
  const entries = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  const match = entries.find((artifact) => artifact?.type === type && files.includes(normalizeManifestFilePath(artifact.path)));
  if (match) {
    return normalizeManifestFilePath(match.path);
  }
  return fallbackNames.find((name) => files.includes(name)) || null;
}

export function listManifestArtifactFiles(manifest, type, files, fallbackFilter) {
  const entries = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  const explicitFiles = entries
    .filter((artifact) => artifact?.type === type)
    .map((artifact) => normalizeManifestFilePath(artifact.path))
    .filter((fileName) => fileName && files.includes(fileName));
  if (explicitFiles.length > 0) {
    return [...new Set(explicitFiles)];
  }
  return files.filter(fallbackFilter);
}

export async function readActiveInboxContract(agentId) {
  if (typeof agentId !== "string" || !agentId.trim()) {
    return null;
  }

  try {
    const raw = await readFile(join(OC, "workspaces", agentId, "inbox", "contract.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function buildStageDefaults(activeContract, agentId) {
  const pipelineStage = activeContract?.pipelineStage && typeof activeContract.pipelineStage === "object"
    ? activeContract.pipelineStage
    : {};
  return {
    stage: pipelineStage.stage || agentId || null,
    pipelineId: pipelineStage.pipelineId || null,
    loopId: pipelineStage.loopId || null,
    loopSessionId: pipelineStage.loopSessionId || null,
    round: Number.isFinite(pipelineStage.round) ? pipelineStage.round : null,
    semanticStageId: pipelineStage.semanticStageId || activeContract?.stageRuntime?.currentStageId || null,
  };
}

export function normalizeObservedStageRunResult(stageRunResult) {
  return normalizeStageRunResult(stageRunResult);
}

function normalizeArtifactPaths(artifactPaths, primaryOutputPath) {
  const normalized = [
    ...(Array.isArray(artifactPaths) ? artifactPaths : []),
    primaryOutputPath,
  ]
    .map((entry) => typeof entry === "string" && entry.trim() ? entry.trim() : null)
    .filter(Boolean);
  return [...new Set(normalized)];
}

export function buildImplicitTextOutputStageRunResult({
  activeContract,
  agentId,
  artifactPaths = [],
  primaryOutputPath = null,
  summary = null,
  feedback = null,
  transition,
} = {}) {
  const effectiveArtifactPaths = normalizeArtifactPaths(artifactPaths, primaryOutputPath);
  const effectivePrimaryOutputPath = typeof primaryOutputPath === "string" && primaryOutputPath.trim()
    ? primaryOutputPath.trim()
    : effectiveArtifactPaths[0] || null;
  if (!effectivePrimaryOutputPath) {
    return null;
  }

  const effectiveSummary = typeof summary === "string" && summary.trim()
    ? summary.trim()
    : `${effectiveArtifactPaths.length} output file(s) collected`;
  const effectiveFeedback = typeof feedback === "string" && feedback.trim()
    ? feedback.trim()
    : effectiveSummary;
  const effectiveTransition = transition === undefined
    ? {
        kind: "follow_graph",
        reason: "stage_completed",
      }
    : transition;
  const stageDefaults = buildStageDefaults(activeContract, agentId);

  return normalizeObservedStageRunResult(normalizeStageRunResult({
    ...stageDefaults,
    status: "completed",
    summary: effectiveSummary,
    feedback: effectiveFeedback,
    artifacts: effectiveArtifactPaths.map((artifactPath) => ({
      type: ARTIFACT_TYPES.TEXT_OUTPUT,
      path: artifactPath,
      label: basename(artifactPath),
      required: true,
      primary: artifactPath === effectivePrimaryOutputPath,
    })),
    primaryArtifactPath: effectivePrimaryOutputPath,
    completion: buildCompletedStageCompletion({
      feedback: effectiveFeedback,
      transition: effectiveTransition,
    }),
  }));
}

export async function materializeOutboxArtifacts({
  outboxDir,
  fileNames,
  logger,
  primaryFileName = null,
  mirrorOutputPath = null,
} = {}) {
  const normalizedFiles = [...new Set((Array.isArray(fileNames) ? fileNames : []).filter(Boolean))];
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pathByFile = new Map();
  const artifactPaths = [];
  const collected = [];

  for (const fileName of normalizedFiles) {
    try {
      const src = join(outboxDir, fileName);
      const dest = join(OUTPUT_DIR, fileName);
      await copyFile(src, dest);
      pathByFile.set(fileName, dest);
      artifactPaths.push(dest);
      if (primaryFileName && fileName === primaryFileName && mirrorOutputPath && mirrorOutputPath !== dest) {
        await mkdir(dirname(mirrorOutputPath), { recursive: true });
        await copyFile(src, mirrorOutputPath);
        logger?.info?.(`[router] collectOutbox: mirrored ${fileName} -> ${mirrorOutputPath}`);
      }
      await removeFileQuietly(src);
      collected.push(fileName);
      logger?.info?.(`[router] collectOutbox: ${fileName} -> output/${fileName}`);
    } catch (error) {
      logger?.warn?.(`[router] collectOutbox: failed to move ${fileName}: ${error.message}`);
    }
  }

  return {
    collected,
    artifactPaths,
    pathByFile,
    primaryArtifactPath: primaryFileName ? pathByFile.get(primaryFileName) || null : artifactPaths[0] || null,
  };
}

export function remapStageRunArtifacts(stageRunResult, pathByFile) {
  const runResult = normalizeStageRunResult(stageRunResult);
  if (!runResult) return null;
  const artifactMap = pathByFile instanceof Map ? pathByFile : new Map();
  const artifacts = runResult.artifacts.map((artifact) => {
    const fileName = basename(artifact.path);
    const materializedPath = artifactMap.get(fileName) || artifact.path;
    return {
      ...artifact,
      path: materializedPath,
    };
  });
  const explicitPrimary = runResult.primaryArtifactPath ? basename(runResult.primaryArtifactPath) : null;
  const primaryArtifactPath = explicitPrimary
    ? artifactMap.get(explicitPrimary) || runResult.primaryArtifactPath
    : artifacts.find((entry) => entry.primary)?.path || artifacts[0]?.path || null;
  return normalizeStageRunResult({
    ...runResult,
    artifacts,
    primaryArtifactPath,
  });
}

export function buildCompletedStageCompletion({
  feedback = null,
  deadEnds = [],
  transition = null,
} = {}) {
  return normalizeStageCompletion({
    status: "completed",
    feedback,
    deadEnds,
    transition,
  });
}

export function buildHoldStageCompletion(status, feedback) {
  return normalizeStageCompletion({
    status,
    feedback,
    transition: {
      kind: "hold",
      reason: feedback || status,
    },
  });
}

export async function collectExplicitStageResult({
  agentId,
  outboxDir,
  files,
  logger,
  manifest,
  activeContract,
} = {}) {
  const stageResultFile = findManifestArtifactFile(manifest, ARTIFACT_TYPES.STAGE_RESULT, files, ["stage_result.json"]);
  if (!stageResultFile) return null;

  try {
    const raw = await readFile(join(outboxDir, stageResultFile), "utf8");
    const parsed = JSON.parse(raw);
    const defaults = buildStageDefaults(activeContract, agentId);
    const normalized = normalizeStageRunResult(parsed, defaults);
    if (!normalized) {
      logger?.warn?.("[router] collectOutbox: invalid stage_result.json");
      return { collected: false, error: "invalid stage_result" };
    }

    const artifactFiles = normalized.artifacts
      .map((artifact) => basename(artifact.path))
      .filter((fileName) => files.includes(fileName));

    // Collect external artifacts (absolute paths outside the outbox that exist on disk)
    const externalArtifacts = [];
    for (const artifact of normalized.artifacts) {
      const artPath = artifact.path;
      if (isAbsolute(artPath) && !files.includes(basename(artPath))) {
        try {
          await stat(artPath);
          externalArtifacts.push(artifact);
        } catch {
          // External file doesn't exist, skip
        }
      }
    }

    const primaryFileName = normalized.primaryArtifactPath ? basename(normalized.primaryArtifactPath) : (artifactFiles[0] || null);
    const mirrorOutputPath = typeof activeContract?.output === "string" && activeContract.output.trim()
      ? activeContract.output.trim()
      : null;
    const materialized = await materializeOutboxArtifacts({
      outboxDir,
      fileNames: artifactFiles,
      logger,
      primaryFileName,
      mirrorOutputPath,
    });
    await removeFileQuietly(join(outboxDir, stageResultFile));

    const stageRunResult = normalizeObservedStageRunResult(
      remapStageRunArtifacts(normalized, materialized.pathByFile),
    );

    // Merge external artifacts into the stage run result
    if (externalArtifacts.length > 0 && stageRunResult) {
      const existingPaths = new Set(stageRunResult.artifacts.map((a) => a.path));
      for (const ext of externalArtifacts) {
        if (!existingPaths.has(ext.path)) {
          stageRunResult.artifacts.push(ext);
        }
      }
    }

    return {
      collected: true,
      files: materialized.collected,
      artifactPaths: stageRunResult?.artifacts.map((artifact) => artifact.path) || [],
      primaryOutputPath: stageRunResult?.primaryArtifactPath || null,
      stageRunResult,
      stageCompletion: normalizeStageCompletion(parsed.completion, stageRunResult?.completion || {}),
      explicitStageResult: true,
    };
  } catch (error) {
    logger?.warn?.(`[router] collectOutbox: stage_result parse error: ${error.message}`);
    return { collected: false, error: error.message };
  }
}
