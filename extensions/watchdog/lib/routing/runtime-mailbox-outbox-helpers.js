// lib/runtime-mailbox-outbox-helpers.js — shared runtime mailbox outbox helpers

import { copyFile, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { evictContractSnapshotByPath } from "../store/contract-store.js";
import { ARTIFACT_TYPES, RUNTIME_RESULT_FILE } from "../protocol-primitives.js";
import {
  normalizeStageCompletion,
  normalizeStageRunResult,
} from "../stage-results.js";
import {
  buildReviewerResult,
  normalizeReviewerResult,
} from "../harness/reviewer-result.js";
import {
  normalizeReviewerDecision,
} from "./runtime-mailbox-outbox-reviewer-verdict.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { OC } from "../state.js";

const OUTPUT_DIR = CONTROL_PLANE_PATHS.outputDir;
const CONTROL_OUTBOX_FILE_NAMES = new Set([
  RUNTIME_RESULT_FILE,
]);
const LEGACY_OUTBOX_FILE_NAMES = new Set([
  "_manifest.json",
]);

export { OUTPUT_DIR };

export async function removeFileQuietly(path) {
  await unlink(path).catch(() => {});
  evictContractSnapshotByPath(path);
}

function listCommittedOutboxFiles(files) {
  return [...new Set((Array.isArray(files) ? files : [])
    .map((fileName) => typeof fileName === "string" ? fileName.trim() : "")
    .filter((fileName) => fileName && !CONTROL_OUTBOX_FILE_NAMES.has(fileName)))];
}

function inferImplicitArtifactType(fileName) {
  return fileName.toLowerCase().endsWith(".md")
    ? ARTIFACT_TYPES.TEXT_OUTPUT
    : "artifact";
}

function normalizeRuntimeResultReviewVerdict(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const verdict = typeof value.verdict === "string" && value.verdict.trim()
    ? value.verdict.trim()
    : typeof value.action === "string" && value.action.trim()
      ? value.action.trim()
      : null;
  if (!verdict) {
    return null;
  }
  return {
    ...value,
    verdict,
  };
}

function deriveRuntimeResultReviewerResult({ parsed, reviewVerdict, activeContract }) {
  const explicit = normalizeReviewerResult(parsed?.reviewerResult);
  if (explicit) {
    return explicit;
  }
  if (!reviewVerdict) {
    return null;
  }
  const decision = normalizeReviewerDecision(reviewVerdict);
  return buildReviewerResult({
    source: "system_action_review_delivery",
    verdict: decision.mapped.verdict,
    score: decision.score,
    findings: decision.findings,
    failureClass: decision.mapped.verdict === "fail" ? "review_rejected" : null,
    reworkTarget: decision.reworkTarget,
    continueHint: decision.mapped.continueHint,
    contractId: activeContract?.id || null,
    ts: Date.now(),
  });
}

function resolvePreferredPrimaryArtifactFile({ artifactFiles, explicitPrimaryFileName, activeContract }) {
  if (explicitPrimaryFileName && artifactFiles.includes(explicitPrimaryFileName)) {
    return explicitPrimaryFileName;
  }

  const contractOutputFileName = typeof activeContract?.output === "string" && activeContract.output.trim()
    ? basename(activeContract.output.trim())
    : null;
  if (contractOutputFileName && artifactFiles.includes(contractOutputFileName)) {
    return contractOutputFileName;
  }

  const markdownFile = artifactFiles.find((fileName) => fileName.toLowerCase().endsWith(".md"));
  if (markdownFile) {
    return markdownFile;
  }

  return artifactFiles[0] || null;
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
  const contractStage = activeContract?.pipelineStage && typeof activeContract.pipelineStage === "object"
    ? activeContract.pipelineStage
    : {};
  return {
    stage: contractStage.stage || agentId || null,
    pipelineId: contractStage.pipelineId || null,
    loopId: contractStage.loopId || null,
    loopSessionId: contractStage.loopSessionId || null,
    round: Number.isFinite(contractStage.round) ? contractStage.round : null,
    semanticStageId: contractStage.semanticStageId || activeContract?.stageRuntime?.currentStageId || null,
  };
}

export function normalizeObservedStageRunResult(stageRunResult) {
  return normalizeStageRunResult(stageRunResult);
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
        logger?.info?.(`[mailbox] collectOutbox: mirrored ${fileName} -> ${mirrorOutputPath}`);
      }
      await removeFileQuietly(src);
      collected.push(fileName);
      logger?.info?.(`[mailbox] collectOutbox: ${fileName} -> output/${fileName}`);
    } catch (error) {
      logger?.warn?.(`[mailbox] collectOutbox: failed to move ${fileName}: ${error.message}`);
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

export async function collectRuntimeResult({
  agentId,
  outboxDir,
  files,
  logger,
  activeContract,
} = {}) {
  const legacyFileName = (Array.isArray(files) ? files : []).find((fileName) => LEGACY_OUTBOX_FILE_NAMES.has(fileName));
  if (legacyFileName) {
    return { collected: false, error: `legacy outbox manifest is not accepted: ${legacyFileName}` };
  }

  if (!Array.isArray(files) || !files.includes(RUNTIME_RESULT_FILE)) {
    return { collected: false, error: `missing ${RUNTIME_RESULT_FILE}` };
  }

  try {
    const raw = await readFile(join(outboxDir, RUNTIME_RESULT_FILE), "utf8");
    const parsed = JSON.parse(raw);
    const defaults = buildStageDefaults(activeContract, agentId);
    const normalized = normalizeStageRunResult(parsed, defaults);
    if (!normalized) {
      logger?.warn?.(`[mailbox] collectOutbox: invalid ${RUNTIME_RESULT_FILE}`);
      return { collected: false, error: "invalid runtime_result" };
    }

    const declaredArtifactFiles = normalized.artifacts
      .map((artifact) => basename(artifact.path))
      .filter((fileName) => files.includes(fileName));
    const implicitArtifactFiles = listCommittedOutboxFiles(files);
    const artifactFiles = [...new Set([
      ...declaredArtifactFiles,
      ...implicitArtifactFiles,
    ])];

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

    const primaryFileName = resolvePreferredPrimaryArtifactFile({
      artifactFiles,
      explicitPrimaryFileName: normalized.primaryArtifactPath ? basename(normalized.primaryArtifactPath) : null,
      activeContract,
    });
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
    await removeFileQuietly(join(outboxDir, RUNTIME_RESULT_FILE));

    const remapped = remapStageRunArtifacts(normalized, materialized.pathByFile);
    const remappedArtifacts = Array.isArray(remapped?.artifacts) ? remapped.artifacts : [];
    const existingArtifactPaths = new Set(remappedArtifacts.map((artifact) => artifact.path));
    for (const fileName of materialized.collected) {
      const materializedPath = materialized.pathByFile.get(fileName);
      if (!materializedPath || existingArtifactPaths.has(materializedPath)) {
        continue;
      }
      remappedArtifacts.push({
        type: inferImplicitArtifactType(fileName),
        path: materializedPath,
        label: fileName,
        required: true,
        primary: materializedPath === materialized.primaryArtifactPath,
      });
      existingArtifactPaths.add(materializedPath);
    }

    const stageRunResult = normalizeObservedStageRunResult(normalizeStageRunResult({
      ...(remapped || normalized),
      artifacts: remappedArtifacts,
      primaryArtifactPath: materialized.primaryArtifactPath
        || remapped?.primaryArtifactPath
        || normalized.primaryArtifactPath
        || null,
    }));

    // Merge external artifacts into the stage run result
    if (externalArtifacts.length > 0 && stageRunResult) {
      const existingPaths = new Set(stageRunResult.artifacts.map((a) => a.path));
      for (const ext of externalArtifacts) {
        if (!existingPaths.has(ext.path)) {
          stageRunResult.artifacts.push(ext);
        }
      }
    }

    const reviewVerdict = normalizeRuntimeResultReviewVerdict(parsed.reviewVerdict);
    const reviewerResult = deriveRuntimeResultReviewerResult({
      parsed,
      reviewVerdict,
      activeContract,
    });

    return {
      collected: true,
      files: materialized.collected,
      artifactPaths: stageRunResult?.artifacts.map((artifact) => artifact.path) || [],
      primaryOutputPath: stageRunResult?.primaryArtifactPath || null,
      stageRunResult,
      stageCompletion: normalizeStageCompletion(parsed.completion, stageRunResult?.completion || {}),
      explicitRuntimeResult: true,
      ...(reviewerResult ? { reviewerResult } : {}),
      ...(reviewVerdict ? { reviewVerdict } : {}),
      ...(reviewerResult || reviewVerdict ? { artifactKind: "code_review" } : {}),
    };
  } catch (error) {
    logger?.warn?.(`[mailbox] collectOutbox: runtime_result parse error: ${error.message}`);
    return { collected: false, error: error.message };
  }
}
