import { normalizeReviewerResult } from "./reviewer-result.js";
import {
  normalizeExecutionMode,
  normalizeHarnessCoverage,
  normalizeProfileTrustLevel,
} from "./harness-registry.js";
import { getHarnessModuleCatalogEntry } from "./harness-module-catalog.js";
import { normalizeHarnessModuleKind } from "./harness-module-contract.js";
import { buildRunShapeMap } from "./run-shape-map.js";
import { buildSoftGuidanceSuggestions } from "./soft-guidance.js";
import { normalizeFiniteNumber, normalizePositiveInteger, normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";

export {
  HARNESS_RUN_STATUS,
  HARNESS_MODULE_STATUS,
  HARNESS_GATE_VERDICT,
} from "./harness-run-constants.js";

import {
  normalizeHarnessRunStatus,
  normalizeHarnessModuleRunStatus,
  buildHarnessRunId,
  normalizeHarnessExecutor,
  normalizeHarnessArtifacts,
  normalizeHarnessToolUsage,
  normalizeHarnessDiagnostics,
  deriveCoverageCounts,
  normalizeCoverageCounts,
  summarizeHarnessModuleCounts,
  normalizeHarnessGateSummary,
} from "./harness-run-normalizers.js";

// ---------------------------------------------------------------------------
// Spec normalizer/builder
// ---------------------------------------------------------------------------

export function normalizeHarnessSpec(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const automationId = normalizeString(source.automationId || source.id);
  const round = normalizePositiveInteger(source.round, 0);
  if (!automationId || !round) return null;

  const coverage = normalizeHarnessCoverage(source.coverage || source.harnessCoverage);

  return {
    automationId,
    round,
    trigger: normalizeString(source.trigger)?.toLowerCase() || "manual",
    requestedAt: Number.isFinite(source.requestedAt) ? source.requestedAt : Date.now(),
    enabled: source.enabled === true,
    executionMode: normalizeExecutionMode(source.executionMode || source.mode, "freeform"),
    assuranceLevel: normalizeString(source.assuranceLevel) || null,
    profileId: normalizeString(source.profileId || source.harnessProfileId) || null,
    profileTrustLevel: normalizeProfileTrustLevel(source.profileTrustLevel, null),
    moduleRefs: uniqueStrings(source.moduleRefs),
    coverage,
    coverageCounts: normalizeCoverageCounts(source.coverageCounts, coverage),
  };
}

export function buildHarnessSpec(automationSpec, {
  round,
  trigger = "manual",
  requestedAt = Date.now(),
} = {}) {
  const automationId = normalizeString(automationSpec?.id);
  const normalizedRound = normalizePositiveInteger(round, 0);
  if (!automationId || !normalizedRound) {
    throw new Error("automationId and round are required to build harness spec");
  }

  const harness = normalizeRecord(automationSpec?.harness, {});
  const coverage = normalizeHarnessCoverage(harness.coverage);

  return normalizeHarnessSpec({
    automationId,
    round: normalizedRound,
    trigger,
    requestedAt,
    enabled: harness.enabled === true,
    executionMode: harness.mode || harness.executionMode || "freeform",
    assuranceLevel: harness.assuranceLevel || "low_assurance",
    profileId: harness.profileId || null,
    profileTrustLevel: harness.profileTrustLevel || null,
    moduleRefs: harness.moduleRefs || [],
    coverage,
    coverageCounts: deriveCoverageCounts(coverage),
  });
}

// ---------------------------------------------------------------------------
// Module run normalizer
// ---------------------------------------------------------------------------

export function normalizeHarnessModuleRun(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const moduleId = normalizeString(source.moduleId || source.id);
  if (!moduleId) return null;
  const hasExplicitKind = normalizeString(source.kind) != null;
  const normalizedKind = normalizeHarnessModuleKind(source.kind, null);
  const catalogKind = getHarnessModuleCatalogEntry(moduleId)?.kind || null;
  const kind = hasExplicitKind
    ? normalizedKind
    : normalizedKind || catalogKind;
  if (!kind) return null;

  return {
    moduleId,
    kind,
    status: normalizeHarnessModuleRunStatus(source.status, "pending"),
    summary: normalizeString(source.summary) || null,
    reason: normalizeString(source.reason) || null,
    hardShaped: uniqueStrings(source.hardShaped),
    startedAt: Number.isFinite(source.startedAt) ? source.startedAt : null,
    finalizedAt: Number.isFinite(source.finalizedAt) ? source.finalizedAt : null,
    evidence: normalizeRecord(source.evidence, null),
  };
}

// ---------------------------------------------------------------------------
// Public harness run API
// ---------------------------------------------------------------------------

export function normalizeHarnessRun(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const baseSpec = normalizeHarnessSpec(source);
  if (!baseSpec) return null;
  const rawModuleRuns = Array.isArray(source.moduleRuns) ? source.moduleRuns : [];
  const moduleRuns = rawModuleRuns
    .map((entry) => normalizeHarnessModuleRun(entry))
    .filter(Boolean);
  if (rawModuleRuns.length !== moduleRuns.length) return null;

  // Run-Shape Map：coverage 的正式对象化（本轮执行塑形覆盖图）。同一真值的 schema 化，非第二份。
  const runShapeMap = buildRunShapeMap(baseSpec.coverage);

  return {
    id: normalizeString(source.id || source.runId) || buildHarnessRunId(baseSpec.automationId, baseSpec.round, baseSpec.requestedAt),
    ...baseSpec,
    // 挂到 run 供 dashboard 投影 / 完整性校验读取（写了必被读）。
    runShapeMap,
    // 软管反逼：对 softGuided 段产出结构建议（参考，不强制），供下游/agent 读取（写了必被读）。
    softGuidance: buildSoftGuidanceSuggestions(runShapeMap),
    status: normalizeHarnessRunStatus(source.status, "running"),
    startedAt: Number.isFinite(source.startedAt) ? source.startedAt : baseSpec.requestedAt,
    finalizedAt: Number.isFinite(source.finalizedAt) ? source.finalizedAt : null,
    contractId: normalizeString(source.contractId) || null,
    pipelineId: normalizeString(source.pipelineId) || null,
    loopId: normalizeString(source.loopId) || null,
    terminalStatus: normalizeString(source.terminalStatus)?.toLowerCase() || null,
    decision: normalizeString(source.decision)?.toLowerCase() || null,
    completionReason: normalizeString(source.completionReason)?.toLowerCase() || null,
    runtimeStatus: normalizeString(source.runtimeStatus)?.toLowerCase() || null,
    score: normalizeFiniteNumber(source.score, null),
    artifact: normalizeString(source.artifact || source.output || source.path || source?.artifacts?.[0]?.path) || null,
    summary: normalizeString(source.summary || source?.outcome?.summary) || null,
    moduleRuns,
    moduleCounts: summarizeHarnessModuleCounts(moduleRuns),
    gateSummary: normalizeHarnessGateSummary(source.gateSummary, moduleRuns),
    executor: normalizeHarnessExecutor(source.executor || (source.agentId ? { kind: "agent", agentId: source.agentId } : null)),
    sessionKey: normalizeString(source.sessionKey) || null,
    toolUsage: normalizeHarnessToolUsage(source.toolUsage),
    artifacts: normalizeHarnessArtifacts(source.artifacts),
    diagnostics: normalizeHarnessDiagnostics(source.diagnostics),
    reviewerResult: normalizeReviewerResult(source.reviewerResult),
  };
}

export function startHarnessRun(harnessSpec, {
  startedAt = Date.now(),
  contractId = null,
  pipelineId = null,
  loopId = null,
} = {}) {
  const spec = normalizeHarnessSpec(harnessSpec);
  if (!spec) {
    throw new Error("invalid harness spec");
  }

  return normalizeHarnessRun({
    ...spec,
    id: buildHarnessRunId(spec.automationId, spec.round, spec.requestedAt),
    status: "running",
    startedAt,
    contractId,
    pipelineId,
    loopId,
  });
}

export function finalizeHarnessRun(harnessRun, {
  terminalStatus = "completed",
  decision = null,
  completionReason = null,
  runtimeStatus = null,
  score = null,
  artifact = null,
  summary = null,
  contractId = null,
  pipelineId = null,
  loopId = null,
  finalizedAt = Date.now(),
} = {}) {
  const run = normalizeHarnessRun(harnessRun);
  if (!run) {
    throw new Error("invalid harness run");
  }

  const normalizedTerminalStatus = normalizeHarnessRunStatus(terminalStatus, "completed");

  return normalizeHarnessRun({
    ...run,
    status: normalizedTerminalStatus,
    finalizedAt,
    contractId: contractId || run.contractId || null,
    pipelineId: pipelineId || run.pipelineId || null,
    loopId: loopId || run.loopId || null,
    terminalStatus: normalizedTerminalStatus,
    decision,
    completionReason,
    runtimeStatus,
    score,
    artifact,
    summary,
  });
}
