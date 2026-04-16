import {
  normalizeExecutionMode,
  normalizeHarnessCoverage,
  normalizeHarnessSelection,
  normalizeProfileTrustLevel,
} from "../harness/harness-registry.js";
import { normalizeHarnessRun, normalizeHarnessSpec } from "../harness/harness-run.js";
import { normalizeCount, normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";

function summarizeCoverageCounts(coverage) {
  const source = normalizeRecord(coverage, {});
  return {
    hardShaped: Array.isArray(source.hardShaped) ? source.hardShaped.length : 0,
    softGuided: Array.isArray(source.softGuided) ? source.softGuided.length : 0,
    freeform: Array.isArray(source.freeform) ? source.freeform.length : 0,
  };
}

export function projectAutomationHarnessSummary({
  harness,
  runtime,
} = {}) {
  const selection = normalizeHarnessSelection(harness) || {};
  const activeHarnessSpec = normalizeHarnessSpec(runtime?.activeHarnessSpec);
  const activeHarnessRun = normalizeHarnessRun(runtime?.activeHarnessRun);
  const lastHarnessRun = normalizeHarnessRun(runtime?.lastHarnessRun);
  const recentHarnessRuns = Array.isArray(runtime?.recentHarnessRuns) ? runtime.recentHarnessRuns : [];
  const coverage = normalizeHarnessCoverage(selection.coverage);

  return {
    executionMode: normalizeExecutionMode(selection.mode || selection.executionMode, "freeform"),
    assuranceLevel: selection.assuranceLevel || null,
    harnessEnabled: selection.enabled === true,
    harnessProfileId: normalizeString(selection.profileId) || null,
    harnessProfileTrustLevel: normalizeProfileTrustLevel(selection.profileTrustLevel, null),
    harnessModuleCount: uniqueStrings(selection.moduleRefs || []).length,
    harnessCoverage: coverage,
    harnessCoverageCounts: summarizeCoverageCounts(coverage),
    activeHarnessStatus: normalizeString(activeHarnessRun?.status)?.toLowerCase() || null,
    activeHarnessRound: Number.isFinite(activeHarnessRun?.round)
      ? activeHarnessRun.round
      : (Number.isFinite(activeHarnessSpec?.round) ? activeHarnessSpec.round : null),
    activeHarnessRunId: normalizeString(activeHarnessRun?.id) || null,
    activeHarnessGateVerdict: normalizeString(activeHarnessRun?.gateSummary?.verdict)?.toLowerCase() || null,
    activeHarnessPendingModuleCount: normalizeCount(activeHarnessRun?.moduleCounts?.pending, 0),
    activeHarnessFailedModuleCount: normalizeCount(activeHarnessRun?.moduleCounts?.failed, 0),
    lastHarnessStatus: normalizeString(lastHarnessRun?.status)?.toLowerCase() || null,
    lastHarnessDecision: normalizeString(lastHarnessRun?.decision)?.toLowerCase() || null,
    lastHarnessGateVerdict: normalizeString(lastHarnessRun?.gateSummary?.verdict)?.toLowerCase() || null,
    lastHarnessFailedModuleCount: normalizeCount(lastHarnessRun?.moduleCounts?.failed, 0),
    recentHarnessRunCount: recentHarnessRuns.length,
  };
}
