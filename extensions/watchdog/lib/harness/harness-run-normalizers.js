import { normalizeCount, normalizeString, uniqueStrings } from "../core/normalize.js";
import { normalizeRecord } from "../core/normalize.js";
import {
  VALID_HARNESS_RUN_STATUSES,
  VALID_HARNESS_MODULE_RUN_STATUSES,
  VALID_HARNESS_GATE_VERDICTS,
} from "./harness-run-constants.js";

// ---------------------------------------------------------------------------
// Status normalizers (use normalizeString for safe coercion)
// ---------------------------------------------------------------------------

export function normalizeHarnessRunStatus(value, fallback = "running") {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized && VALID_HARNESS_RUN_STATUSES.has(normalized) ? normalized : fallback;
}

export function normalizeHarnessModuleRunStatus(value, fallback = "pending") {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized && VALID_HARNESS_MODULE_RUN_STATUSES.has(normalized) ? normalized : fallback;
}

export function normalizeHarnessGateVerdict(value, fallback = "none") {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized && VALID_HARNESS_GATE_VERDICTS.has(normalized) ? normalized : fallback;
}

// ---------------------------------------------------------------------------
// Run ID builder
// ---------------------------------------------------------------------------

export function buildHarnessRunId(automationId, round, requestedAt) {
  return `harness:${automationId}:round:${round}:ts:${requestedAt}`;
}

// ---------------------------------------------------------------------------
// Sub-object normalizers (executor, artifacts, toolUsage, diagnostics)
// ---------------------------------------------------------------------------

export function normalizeHarnessExecutor(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;
  return {
    kind: normalizeString(source.kind)?.toLowerCase() || "agent",
    agentId: normalizeString(source.agentId) || null,
  };
}

export function normalizeHarnessArtifacts(value) {
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

export function normalizeHarnessToolUsage(value) {
  const source = normalizeRecord(value, null);
  if (!source) {
    return { totalCalls: 0, byTool: {} };
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

export function normalizeHarnessDiagnostics(value) {
  const source = normalizeRecord(value, null);
  if (!source) {
    return { traceId: null, warnings: [], error: null };
  }
  return {
    traceId: normalizeString(source.traceId) || null,
    warnings: uniqueStrings(source.warnings || []),
    error: normalizeString(source.error) || null,
  };
}

// ---------------------------------------------------------------------------
// Coverage count helpers
// ---------------------------------------------------------------------------

export function deriveCoverageCounts(coverage) {
  const source = normalizeRecord(coverage, {});
  return {
    hardShaped: Array.isArray(source.hardShaped) ? source.hardShaped.length : 0,
    softGuided: Array.isArray(source.softGuided) ? source.softGuided.length : 0,
    freeform: Array.isArray(source.freeform) ? source.freeform.length : 0,
  };
}

export function normalizeCoverageCounts(value, coverage = null) {
  const source = normalizeRecord(value, null);
  const derived = deriveCoverageCounts(coverage);
  if (!source) return derived;
  return {
    hardShaped: normalizeCount(source.hardShaped, derived.hardShaped),
    softGuided: normalizeCount(source.softGuided, derived.softGuided),
    freeform: normalizeCount(source.freeform, derived.freeform),
  };
}

// ---------------------------------------------------------------------------
// Module counts and gate summary derivation
// ---------------------------------------------------------------------------

export function summarizeHarnessModuleCounts(moduleRuns) {
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

export function deriveHarnessGateSummary(moduleRuns) {
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

export function normalizeHarnessGateSummary(value, moduleRuns = []) {
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
