import { normalizeEnum, normalizeRecord, normalizeString } from "../core/normalize.js";

const VALID_STAGE_RUN_STATUSES = new Set([
  "completed",
  "failed",
]);

const VALID_STAGE_TRANSITION_KINDS = new Set([
  "advance",
  "conclude",
  "hold",
  "follow_graph",
]);

function normalizeCount(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeStageRunStatus(value, fallback = "completed") {
  return normalizeEnum(value, VALID_STAGE_RUN_STATUSES, fallback);
}

function normalizeStageTransitionKind(value, fallback = "hold") {
  return normalizeEnum(value, VALID_STAGE_TRANSITION_KINDS, fallback);
}

function normalizeStageArtifact(entry) {
  const source = normalizeRecord(entry, null);
  if (!source) return null;

  const path = normalizeString(source.path);
  if (!path) return null;

  return {
    path,
    type: normalizeString(source.type) || "artifact",
    label: normalizeString(source.label) || normalizeString(source.type) || path,
    required: source.required !== false,
    primary: source.primary === true,
    jsonPaths: Array.isArray(source.jsonPaths)
      ? source.jsonPaths.map((value) => normalizeString(value)).filter(Boolean)
      : [],
  };
}

function normalizeStageTransition(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const kind = normalizeStageTransitionKind(source.kind, null);
  if (!kind) return null;

  const targetStage = normalizeString(source.targetStage || source.target);
  return {
    kind,
    targetStage: kind === "advance" ? targetStage || null : (targetStage || null),
    reason: normalizeString(source.reason) || null,
  };
}

export function normalizeStageCompletion(value, fallback = {}) {
  const source = normalizeRecord(value, fallback);
  if (!source) return null;

  return {
    version: Number(source.version) || 1,
    status: normalizeStageRunStatus(source.status, normalizeStageRunStatus(fallback.status || "completed")),
    feedback: normalizeString(source.feedback) || normalizeString(fallback.feedback) || null,
    deadEnds: Array.isArray(source.deadEnds)
      ? source.deadEnds.map((entry) => normalizeString(entry)).filter(Boolean)
      : Array.isArray(fallback.deadEnds)
        ? fallback.deadEnds.map((entry) => normalizeString(entry)).filter(Boolean)
        : [],
    transition: normalizeStageTransition(source.transition || fallback.transition),
  };
}

export function normalizeStageRunResult(value, fallback = {}) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const artifacts = Array.isArray(source.artifacts)
    ? source.artifacts.map(normalizeStageArtifact).filter(Boolean)
    : Array.isArray(fallback.artifacts)
      ? fallback.artifacts.map(normalizeStageArtifact).filter(Boolean)
      : [];
  const explicitPrimary = normalizeString(source.primaryArtifactPath || fallback.primaryArtifactPath);
  const primaryArtifact = explicitPrimary || artifacts.find((entry) => entry.primary)?.path || artifacts[0]?.path || null;
  const revision = normalizeRecord(source.stagePlanRevision, normalizeRecord(fallback.stagePlanRevision, null));

  return {
    version: Number(source.version) || 1,
    stage: normalizeString(source.stage) || normalizeString(fallback.stage) || null,
    // 回路运行时退役(2026-08-18):pipelineId/loopId/loopSessionId 三字段随
    // contract.pipelineStage 一并移出 schema——归一层是它们最后的入口,不删则
    // 历史落盘里的残值会被一路抄回新产物,「schema 自然淘汰」永不发生。
    round: normalizeCount(source.round, normalizeCount(fallback.round, null)),
    status: normalizeStageRunStatus(source.status, normalizeStageRunStatus(fallback.status || "completed")),
    summary: normalizeString(source.summary) || normalizeString(fallback.summary) || null,
    feedback: normalizeString(source.feedback) || normalizeString(fallback.feedback) || null,
    artifacts,
    primaryArtifactPath: primaryArtifact,
    semanticStageId: normalizeString(source.semanticStageId) || normalizeString(fallback.semanticStageId) || null,
    stagePlanRevision: revision
      ? {
          reason: normalizeString(revision.reason) || null,
          stages: Array.isArray(revision.stages) ? [...revision.stages] : [],
        }
      : null,
    metadata: normalizeRecord(source.metadata, normalizeRecord(fallback.metadata, null)),
    completion: normalizeStageCompletion(source.completion, fallback.completion || {}),
  };
}

export function listStageArtifactPaths(stageRunResult) {
  const runResult = normalizeStageRunResult(stageRunResult);
  if (!runResult) return [];
  return runResult.artifacts.map((entry) => entry.path);
}
