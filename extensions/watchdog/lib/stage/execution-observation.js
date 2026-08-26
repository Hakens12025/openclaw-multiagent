import {
  normalizeRecord,
  normalizeString,
  uniqueStrings,
} from "../core/normalize.js";
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
      researchDirection: null,
      nextAction: null,
      searchSpace: null,
      error: null,
      stageRunResult: null,
      stageCompletion: null,
      primaryOutputPathSource: normalizedFallbackPrimaryOutputPath ? "contract_output_fallback" : null,
      observedAt: Number.isFinite(observedAt) ? observedAt : null,
    };
  }

  const stageRunResult = normalizeStageRunResult(source.stageRunResult || null);
  const stageCompletionSource = normalizeRecord(source.stageCompletion, null);
  const stageCompletion = stageCompletionSource || stageRunResult?.completion
    ? normalizeStageCompletion(stageCompletionSource, stageRunResult?.completion || {})
    : null;
  const files = normalizeObservationFiles(source.files);
  // Source-derived signals are computed BEFORE the contract.output fallback is
  // merged in: `collected` must reflect what was actually collected, never the
  // fallback (which mirrors the previous hop's file on multi-hop contracts).
  const sourceArtifactPaths = normalizeObservationArtifactPaths(
    Array.isArray(source.artifactPaths) ? source.artifactPaths : [],
    stageRunResult,
  );
  const sourcePrimaryOutputPath = normalizeString(source.primaryOutputPath)
    || normalizeString(stageRunResult?.primaryArtifactPath)
    || sourceArtifactPaths[0]
    || null;
  const artifactPaths = normalizedFallbackPrimaryOutputPath
    ? uniqueStrings([...sourceArtifactPaths, normalizedFallbackPrimaryOutputPath])
    : sourceArtifactPaths;
  const primaryOutputPath = sourcePrimaryOutputPath
    || normalizedFallbackPrimaryOutputPath
    || null;
  const normalized = {
    version: Number.isFinite(source.version) ? Math.max(1, Math.trunc(source.version)) : 1,
    collected: source.collected === true,
    contractId: normalizeString(source.contractId) || normalizedContractId || null,
    routerHandlerId: normalizeString(source.routerHandlerId) || null,
    files,
    artifactPaths,
    primaryOutputPath,
    researchDirection: normalizeObservationPayload(source.researchDirection),
    nextAction: normalizeObservationPayload(source.nextAction),
    searchSpace: normalizeObservationPayload(source.searchSpace),
    error: normalizeString(source.error) || null,
    stageRunResult,
    stageCompletion,
    // Provenance for freshness gates (H4): consumers can tell a genuinely
    // collected primary from the contract.output fallback mirror.
    primaryOutputPathSource: sourcePrimaryOutputPath
      ? "collected"
      : (primaryOutputPath ? "contract_output_fallback" : null),
    observedAt: Number.isFinite(source.observedAt) ? source.observedAt : (Number.isFinite(observedAt) ? observedAt : null),
  };

  // `collected` is derived from source signals only: the fallback path and a
  // collection error must never flip a failed collection into collected:true
  // (that inversion made logs and dashboards lie in both directions).
  normalized.collected = normalized.collected === true
    || normalized.files.length > 0
    || sourceArtifactPaths.length > 0
    || Boolean(sourcePrimaryOutputPath);

  return normalized;
}

export function materializeExecutionObservation(observation, opts = {}) {
  const normalized = normalizeExecutionObservation(observation, opts);
  return {
    ...normalized,
    observedAt: Number.isFinite(normalized.observedAt) ? normalized.observedAt : Date.now(),
  };
}
