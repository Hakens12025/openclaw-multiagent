import { normalizeRecord, normalizeString } from "../core/normalize.js";

function normalizeStageArtifactEntry(entry) {
  const normalized = normalizeRecord(entry, null);
  if (!normalized) return null;
  return {
    label: normalizeString(normalized.label) || normalizeString(normalized.type) || null,
    type: normalizeString(normalized.type) || null,
    path: normalizeString(normalized.path) || null,
    required: normalized.required === true,
    primary: normalized.primary === true,
  };
}

function normalizeStageArtifacts(values) {
  if (!Array.isArray(values)) return [];
  return values.map((entry) => normalizeStageArtifactEntry(entry)).filter(Boolean);
}

export function normalizeStageRunResult(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;
  const artifacts = normalizeStageArtifacts(source.artifacts);
  return {
    version: Number.isFinite(source.version) ? source.version : 1,
    stage: normalizeString(source.stage) || null,
    pipelineId: normalizeString(source.pipelineId) || null,
    loopId: normalizeString(source.loopId) || null,
    loopSessionId: normalizeString(source.loopSessionId) || null,
    round: Number.isFinite(source.round) ? source.round : null,
    status: normalizeString(source.status)?.toLowerCase() || null,
    summary: normalizeString(source.summary) || null,
    feedback: normalizeString(source.feedback) || null,
    primaryArtifactPath: normalizeString(source.primaryArtifactPath) || null,
    artifacts,
    evaluationInput: normalizeRecord(source.evaluationInput, null),
    metadata: normalizeRecord(source.metadata, null),
    transition: normalizeRecord(source.transition, null),
  };
}

export function normalizeStageCompletion(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;
  return {
    version: Number.isFinite(source.version) ? source.version : 1,
    status: normalizeString(source.status)?.toLowerCase() || null,
    feedback: normalizeString(source.feedback) || null,
    deadEnds: Array.isArray(source.deadEnds) ? source.deadEnds.map((entry) => normalizeString(entry)).filter(Boolean) : [],
    transition: normalizeRecord(source.transition, null),
  };
}

export function resolveStageArtifactEvidence(stageResult) {
  if (!stageResult) return null;
  const artifacts = Array.isArray(stageResult.artifacts) ? stageResult.artifacts : [];
  const primary = artifacts.find((artifact) => artifact.primary && artifact.path)
    || artifacts.find((artifact) => artifact.path);
  const path = normalizeString(stageResult.primaryArtifactPath)
    || primary?.path
    || null;
  if (!path) {
    return { present: false, path: null, source: "stage_result" };
  }
  return {
    present: true,
    path,
    label: primary?.label || null,
    type: primary?.type || null,
    source: "stage_result",
  };
}

export function listMissingStageArtifacts(stageResult) {
  if (!stageResult) return [];
  const artifacts = Array.isArray(stageResult.artifacts) ? stageResult.artifacts : [];
  return artifacts
    .filter((artifact) => artifact.required && !artifact.path)
    .map((artifact) => ({ label: artifact.label || artifact.type || "artifact", type: artifact.type || null }));
}
