import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";

// ---------------------------------------------------------------------------
// Run summary builder — extracts key fields from a raw run object
// ---------------------------------------------------------------------------

function summarizeCoverageCounts(coverage) {
  const source = normalizeRecord(coverage);
  return {
    hardShaped: Array.isArray(source?.hardShaped) ? source.hardShaped.length : 0,
    softGuided: Array.isArray(source?.softGuided) ? source.softGuided.length : 0,
    freeform: Array.isArray(source?.freeform) ? source.freeform.length : 0,
  };
}

function summarizeRun(run) {
  const source = normalizeRecord(run, null);
  if (!source) return null;

  return {
    id: normalizeString(source.id) || null,
    round: Number.isFinite(source.round) ? source.round : null,
    status: normalizeString(source.status) || "none",
    decision: normalizeString(source.decision) || null,
    runtimeStatus: normalizeString(source.runtimeStatus) || null,
    score: source.score ?? null,
    artifact: normalizeString(source.artifact) || null,
    summary: normalizeString(source.summary) || null,
    startedAt: Number.isFinite(source.startedAt) ? source.startedAt : null,
    finalizedAt: Number.isFinite(source.finalizedAt) ? source.finalizedAt : null,
    profileId: normalizeString(source.profileId) || null,
    executionMode: normalizeString(source.executionMode) || null,
    assuranceLevel: normalizeString(source.assuranceLevel) || null,
    contractId: normalizeString(source.contractId) || null,
    pipelineId: normalizeString(source.pipelineId) || null,
    loopId: normalizeString(source.loopId) || null,
    moduleRefs: uniqueStrings(source.moduleRefs || []),
    coverageCounts: summarizeCoverageCounts(source.coverage),
    moduleCounts: {
      total: Number(source?.moduleCounts?.total) || 0,
      pending: Number(source?.moduleCounts?.pending) || 0,
      passed: Number(source?.moduleCounts?.passed) || 0,
      failed: Number(source?.moduleCounts?.failed) || 0,
      skipped: Number(source?.moduleCounts?.skipped) || 0,
    },
    gateSummary: {
      total: Number(source?.gateSummary?.total) || 0,
      pending: Number(source?.gateSummary?.pending) || 0,
      passed: Number(source?.gateSummary?.passed) || 0,
      failed: Number(source?.gateSummary?.failed) || 0,
      skipped: Number(source?.gateSummary?.skipped) || 0,
      verdict: normalizeString(source?.gateSummary?.verdict) || "none",
      pendingModuleIds: uniqueStrings(source?.gateSummary?.pendingModuleIds || []),
      failedModuleIds: uniqueStrings(source?.gateSummary?.failedModuleIds || []),
    },
    sourceTags: [],
  };
}

function mergeRecentRun(map, run, sourceTag) {
  const summarized = summarizeRun(run);
  if (!summarized?.id) return;

  const existing = map.get(summarized.id);
  if (!existing) {
    map.set(summarized.id, {
      ...summarized,
      sourceTags: uniqueStrings([sourceTag]),
    });
    return;
  }

  map.set(summarized.id, {
    ...existing,
    ...summarized,
    sourceTags: uniqueStrings([...(existing.sourceTags || []), sourceTag]),
  });
}

export function summarizeRecentRuns(automation) {
  const runtime = normalizeRecord(automation?.runtime);
  const runs = new Map();

  mergeRecentRun(runs, runtime?.activeHarnessRun, "active");
  mergeRecentRun(runs, runtime?.lastHarnessRun, "last");
  for (const run of Array.isArray(runtime?.recentHarnessRuns) ? runtime.recentHarnessRuns : []) {
    mergeRecentRun(runs, run, "recent");
  }

  return [...runs.values()]
    .sort((left, right) => {
      const leftActive = Array.isArray(left?.sourceTags) && left.sourceTags.includes("active") ? 1 : 0;
      const rightActive = Array.isArray(right?.sourceTags) && right.sourceTags.includes("active") ? 1 : 0;
      if (rightActive !== leftActive) return rightActive - leftActive;
      const leftTs = Number(left?.finalizedAt) || Number(left?.startedAt) || 0;
      const rightTs = Number(right?.finalizedAt) || Number(right?.startedAt) || 0;
      if (rightTs !== leftTs) return rightTs - leftTs;
      return Number(right?.round || 0) - Number(left?.round || 0);
    });
}
