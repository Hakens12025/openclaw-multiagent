import {
  normalizeRecord,
  normalizeString,
  uniqueStrings,
} from "./core/normalize.js";
import {
  listStageArtifactPaths,
  normalizeStageCompletion,
  normalizeStageRunResult,
} from "./stage-results.js";

function normalizeObservationFiles(files) {
  return uniqueStrings((Array.isArray(files) ? files : []).map((entry) => normalizeString(entry)).filter(Boolean));
}

function normalizeObservationArtifactPaths(artifactPaths, stageRunResult) {
  return uniqueStrings([
    ...(Array.isArray(artifactPaths) ? artifactPaths : []),
    ...listStageArtifactPaths(stageRunResult),
  ].map((entry) => normalizeString(entry)).filter(Boolean));
}

function normalizeObservationPayload(value) {
  return normalizeRecord(value, null);
}

export function normalizeExecutionObservation(observation, {
  contractId = null,
  observedAt = null,
  fallbackPrimaryOutputPath = null,
} = {}) {
  const source = normalizeRecord(observation, null);
  const normalizedContractId = normalizeString(contractId);
  const normalizedFallbackPrimaryOutputPath = normalizeString(fallbackPrimaryOutputPath) || null;
  if (!source) {
    const artifactPaths = normalizedFallbackPrimaryOutputPath ? [normalizedFallbackPrimaryOutputPath] : [];
    return {
      version: 1,
      collected: false,
      contractId: normalizedContractId || null,
      routerHandlerId: null,
      files: [],
      artifactPaths,
      primaryOutputPath: normalizedFallbackPrimaryOutputPath,
      contractResult: null,
      reviewerResult: null,
      reviewVerdict: null,
      researchDirection: null,
      nextAction: null,
      searchSpace: null,
      artifactKind: null,
      error: null,
      stageRunResult: null,
      stageCompletion: null,
      observedAt: Number.isFinite(observedAt) ? observedAt : null,
    };
  }

  const stageRunResult = normalizeStageRunResult(source.stageRunResult || null);
  const stageCompletion = normalizeStageCompletion(
    source.stageCompletion || null,
    stageRunResult?.completion || {},
  );
  const files = normalizeObservationFiles(source.files);
  const artifactPaths = normalizeObservationArtifactPaths(
    [
      ...(Array.isArray(source.artifactPaths) ? source.artifactPaths : []),
      ...(normalizedFallbackPrimaryOutputPath ? [normalizedFallbackPrimaryOutputPath] : []),
    ],
    stageRunResult,
  );
  const primaryOutputPath = normalizeString(source.primaryOutputPath)
    || normalizeString(stageRunResult?.primaryArtifactPath)
    || normalizedFallbackPrimaryOutputPath
    || artifactPaths[0]
    || null;
  const normalized = {
    version: Number.isFinite(source.version) ? Math.max(1, Math.trunc(source.version)) : 1,
    collected: source.collected === true,
    contractId: normalizeString(source.contractId) || normalizedContractId || null,
    routerHandlerId: normalizeString(source.routerHandlerId) || null,
    files,
    artifactPaths,
    primaryOutputPath,
    contractResult: normalizeObservationPayload(source.contractResult),
    reviewerResult: normalizeObservationPayload(source.reviewerResult),
    reviewVerdict: normalizeObservationPayload(source.reviewVerdict),
    researchDirection: normalizeObservationPayload(source.researchDirection),
    nextAction: normalizeObservationPayload(source.nextAction),
    searchSpace: normalizeObservationPayload(source.searchSpace),
    artifactKind: normalizeString(source.artifactKind) || null,
    error: normalizeString(source.error) || null,
    stageRunResult,
    stageCompletion,
    observedAt: Number.isFinite(source.observedAt) ? source.observedAt : (Number.isFinite(observedAt) ? observedAt : null),
  };

  normalized.collected = normalized.collected === true || Boolean(
    normalized.stageRunResult
    || normalized.stageCompletion
    || normalized.contractResult
    || normalized.reviewerResult
    || normalized.reviewVerdict
    || normalized.researchDirection
    || normalized.nextAction
    || normalized.searchSpace
    || normalized.files.length > 0
    || normalized.artifactPaths.length > 0
    || normalized.primaryOutputPath
    || normalized.error
  );

  return normalized;
}

export function materializeExecutionObservation(observation, opts = {}) {
  const normalized = normalizeExecutionObservation(observation, opts);
  return {
    ...normalized,
    observedAt: Number.isFinite(normalized.observedAt) ? normalized.observedAt : Date.now(),
  };
}

export function hasExecutionObservationPayload(observation) {
  const normalized = normalizeExecutionObservation(observation);
  return normalized.collected === true;
}
