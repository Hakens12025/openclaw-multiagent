import { normalizeReviewerResult } from "./reviewer-result.js";
import {
  normalizeExecutionMode,
  normalizeHarnessCoverage,
  normalizeProfileTrustLevel,
} from "./harness-registry.js";
import { getHarnessModuleCatalogEntry } from "./harness-module-catalog.js";
import { normalizeHarnessModuleKind } from "./harness-module-contract.js";
import { normalizeCount, normalizeFiniteNumber, normalizePositiveInteger, normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";

export const HARNESS_RUN_STATUS = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  ABANDONED: "abandoned",
  CANCELLED: "cancelled",
  AWAITING_INPUT: "awaiting_input",
});

export const HARNESS_MODULE_STATUS = Object.freeze({
  PENDING: "pending",
  PASSED: "passed",
  FAILED: "failed",
  SKIPPED: "skipped",
});

export const HARNESS_GATE_VERDICT = Object.freeze({
  NONE: "none",
  PENDING: "pending",
  PASSED: "passed",
  FAILED: "failed",
  SKIPPED: "skipped",
});

const VALID_HARNESS_RUN_STATUSES = new Set(Object.values(HARNESS_RUN_STATUS));
const VALID_HARNESS_MODULE_RUN_STATUSES = new Set(Object.values(HARNESS_MODULE_STATUS));
const VALID_HARNESS_GATE_VERDICTS = new Set(Object.values(HARNESS_GATE_VERDICT));

function normalizeHarnessExecutor(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;
  return {
    kind: normalizeString(source.kind)?.toLowerCase() || "agent",
    agentId: normalizeString(source.agentId) || null,
  };
}

function normalizeHarnessArtifacts(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const source = normalizeRecord(entry, null);
      if (!source) return null;
      const path = normalizeString(source.path);
      if (!path) return null;
      return {
        kind: normalizeString(source.kind)?.toLowerCase() || "artifact",
        path,
      };
    })
    .filter(Boolean);
}

function normalizeHarnessToolUsage(value) {
  const source = normalizeRecord(value, null);
  if (!source) {
    return {
      totalCalls: 0,
      byTool: {},
    };
  }

  const byToolSource = normalizeRecord(source.byTool, {});
  const byTool = Object.fromEntries(
    Object.entries(byToolSource).map(([toolName, count]) => [
      normalizeString(toolName) || toolName,
      normalizeCount(count, 0),
    ]),
  );

  return {
    totalCalls: normalizeCount(source.totalCalls, 0),
    byTool,
  };
}

function normalizeHarnessDiagnostics(value) {
  const source = normalizeRecord(value, null);
  if (!source) {
    return {
      traceId: null,
      warnings: [],
      error: null,
    };
  }

  return {
    traceId: normalizeString(source.traceId) || null,
    warnings: uniqueStrings(source.warnings || []),
    error: normalizeString(source.error) || null,
  };
}

function deriveCoverageCounts(coverage) {
  const source = normalizeRecord(coverage, {});
  return {
    hardShaped: Array.isArray(source.hardShaped) ? source.hardShaped.length : 0,
    softGuided: Array.isArray(source.softGuided) ? source.softGuided.length : 0,
    freeform: Array.isArray(source.freeform) ? source.freeform.length : 0,
  };
}

function normalizeCoverageCounts(value, coverage = null) {
  const source = normalizeRecord(value, null);
  const derived = deriveCoverageCounts(coverage);
  if (!source) return derived;
  return {
    hardShaped: normalizeCount(source.hardShaped, derived.hardShaped),
    softGuided: normalizeCount(source.softGuided, derived.softGuided),
    freeform: normalizeCount(source.freeform, derived.freeform),
  };
}

function buildHarnessRunId(automationId, round, requestedAt) {
  return `harness:${automationId}:round:${round}:ts:${requestedAt}`;
}

function normalizeHarnessRunStatus(value, fallback = "running") {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized && VALID_HARNESS_RUN_STATUSES.has(normalized)
    ? normalized
    : fallback;
}

function normalizeHarnessModuleRunStatus(value, fallback = "pending") {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized && VALID_HARNESS_MODULE_RUN_STATUSES.has(normalized)
    ? normalized
    : fallback;
}

function normalizeHarnessGateVerdict(value, fallback = "none") {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized && VALID_HARNESS_GATE_VERDICTS.has(normalized)
    ? normalized
    : fallback;
}

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

function summarizeHarnessModuleCounts(moduleRuns) {
  const entries = Array.isArray(moduleRuns) ? moduleRuns : [];
  return {
    total: entries.length,
    pending: entries.filter((entry) => entry?.status === "pending").length,
    passed: entries.filter((entry) => entry?.status === "passed").length,
    failed: entries.filter((entry) => entry?.status === "failed").length,
    skipped: entries.filter((entry) => entry?.status === "skipped").length,
    guards: entries.filter((entry) => entry?.kind === "guard").length,
    collectors: entries.filter((entry) => entry?.kind === "collector").length,
    gates: entries.filter((entry) => entry?.kind === "gate").length,
    normalizers: entries.filter((entry) => entry?.kind === "normalizer").length,
  };
}

function deriveHarnessGateSummary(moduleRuns) {
  const gates = (Array.isArray(moduleRuns) ? moduleRuns : [])
    .filter((entry) => entry?.kind === "gate");

  const counts = {
    total: gates.length,
    pending: gates.filter((entry) => entry?.status === "pending").length,
    passed: gates.filter((entry) => entry?.status === "passed").length,
    failed: gates.filter((entry) => entry?.status === "failed").length,
    skipped: gates.filter((entry) => entry?.status === "skipped").length,
  };
  const failedModuleIds = gates
    .filter((entry) => entry?.status === "failed")
    .map((entry) => entry?.moduleId);
  const pendingModuleIds = gates
    .filter((entry) => entry?.status === "pending")
    .map((entry) => entry?.moduleId);

  let verdict = "none";
  if (counts.total === 0) {
    verdict = "none";
  } else if (counts.failed > 0) {
    verdict = "failed";
  } else if (counts.pending > 0) {
    verdict = "pending";
  } else if (counts.passed > 0) {
    verdict = "passed";
  } else {
    verdict = "skipped";
  }

  return {
    ...counts,
    verdict,
    failedModuleIds: uniqueStrings(failedModuleIds),
    pendingModuleIds: uniqueStrings(pendingModuleIds),
  };
}

function normalizeHarnessGateSummary(value, moduleRuns = []) {
  const source = normalizeRecord(value, null);
  const derived = deriveHarnessGateSummary(moduleRuns);
  if (Array.isArray(moduleRuns) && moduleRuns.length > 0) {
    return derived;
  }
  if (!source) return derived;

  return {
    total: normalizeCount(source.total, derived.total),
    pending: normalizeCount(source.pending, derived.pending),
    passed: normalizeCount(source.passed, derived.passed),
    failed: normalizeCount(source.failed, derived.failed),
    skipped: normalizeCount(source.skipped, derived.skipped),
    verdict: normalizeHarnessGateVerdict(source.verdict, derived.verdict),
    failedModuleIds: uniqueStrings(source.failedModuleIds || derived.failedModuleIds),
    pendingModuleIds: uniqueStrings(source.pendingModuleIds || derived.pendingModuleIds),
  };
}

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

  return {
    id: normalizeString(source.id || source.runId) || buildHarnessRunId(baseSpec.automationId, baseSpec.round, baseSpec.requestedAt),
    ...baseSpec,
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
