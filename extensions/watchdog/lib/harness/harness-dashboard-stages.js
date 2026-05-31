import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";
import { getHarnessModule, normalizeHarnessSelection } from "./harness-registry.js";
import { projectAutomationHarnessSummary } from "../automation/automation-harness-projection.js";

// ---------------------------------------------------------------------------
// Execution stages definition
// ---------------------------------------------------------------------------

export const EXECUTION_STAGES = Object.freeze([
  { id: "preflight", label: "PREFLIGHT" },
  { id: "dispatch", label: "DISPATCH" },
  { id: "in_run", label: "IN-RUN" },
  { id: "completion", label: "COMPLETION" },
  { id: "evaluation", label: "EVALUATION" },
  { id: "feedback", label: "FEEDBACK" },
]);

// ---------------------------------------------------------------------------
// Profile family inference
// ---------------------------------------------------------------------------

export function inferProfileFamily(profileId) {
  const normalized = normalizeString(profileId);
  if (!normalized) return "general";
  const [family] = normalized.split(".");
  return family || "general";
}

// ---------------------------------------------------------------------------
// Identifier humanizer
// ---------------------------------------------------------------------------

export function humanizeIdentifier(value) {
  const raw = String(value || "");
  const colonIdx = raw.indexOf(":");
  const name = colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw;
  const dotIdx = name.indexOf(".");
  const displayPart = dotIdx >= 0 ? name.slice(dotIdx + 1) : name;
  return displayPart
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

// ---------------------------------------------------------------------------
// Stage inference helpers
// ---------------------------------------------------------------------------

export function inferStageFromModuleKind(kind) {
  switch (normalizeString(kind)) {
    case "guard":
      return "preflight";
    case "collector":
      return "in_run";
    case "gate":
      return "completion";
    case "normalizer":
      return "evaluation";
    default:
      return "in_run";
  }
}

export function inferStageFromCoverageArea(area) {
  const normalized = normalizeString(area)?.toLowerCase() || "";
  if (!normalized) return "in_run";
  if ([
    "timeout",
    "retry",
    "sandbox",
    "network",
    "workspace",
    "tool",
    "budget",
    "boundary",
    "whitelist",
    "scope",
    "cancellation",
  ].some((token) => normalized.includes(token))) {
    return "preflight";
  }
  if ([
    "summary",
    "memo",
    "handoff",
    "error_list",
    "structured_handoff",
    "change_summary",
  ].some((token) => normalized.includes(token))) {
    return "feedback";
  }
  if ([
    "evaluation",
    "score",
    "verdict",
    "qualitative",
  ].some((token) => normalized.includes(token))) {
    return "evaluation";
  }
  if ([
    "artifact",
    "trace",
    "diff",
    "log",
    "capture",
    "test",
    "schema",
    "experiment_status",
  ].some((token) => normalized.includes(token))) {
    return "completion";
  }
  return "in_run";
}

// ---------------------------------------------------------------------------
// Stage map builders
// ---------------------------------------------------------------------------

function createStageMap() {
  return new Map(EXECUTION_STAGES.map((stage) => [stage.id, {
    ...stage,
    lanes: {
      hardShaped: [],
      softGuided: [],
      freeform: [],
    },
  }]));
}

function addStageItem(stageMap, stageId, lane, item) {
  const stage = stageMap.get(stageId) || stageMap.get("in_run");
  stage.lanes[lane].push(item);
}

function decorateStageMap(stageMap) {
  return [...stageMap.values()].map((stage) => ({
    ...stage,
    counts: {
      hardShaped: stage.lanes.hardShaped.length,
      softGuided: stage.lanes.softGuided.length,
      freeform: stage.lanes.freeform.length,
    },
  }));
}

function selectPlacementRun(runtime) {
  const source = normalizeRecord(runtime);
  if (source.activeHarnessRun && typeof source.activeHarnessRun === "object") {
    return { mode: "active", run: source.activeHarnessRun };
  }
  if (source.lastHarnessRun && typeof source.lastHarnessRun === "object") {
    return { mode: "last", run: source.lastHarnessRun };
  }
  return { mode: "none", run: null };
}

export function buildPlacementStages(automation, selection) {
  const runtime = normalizeRecord(automation?.runtime);
  const { mode: selectedRunMode, run: selectedRun } = selectPlacementRun(runtime);
  const moduleRuns = Array.isArray(selectedRun?.moduleRuns) ? selectedRun.moduleRuns : [];
  const moduleRunById = new Map(moduleRuns.map((entry) => [entry?.moduleId, entry]));
  const stageMap = createStageMap();

  for (const moduleId of Array.isArray(selection?.moduleRefs) ? selection.moduleRefs : []) {
    const module = getHarnessModule(moduleId);
    const moduleRun = moduleRunById.get(moduleId) || null;
    addStageItem(stageMap, inferStageFromModuleKind(module?.kind), "hardShaped", {
      id: moduleId,
      label: humanizeIdentifier(moduleId),
      rawLabel: moduleId,
      source: "module",
      kind: normalizeString(module?.kind) || "module",
      status: normalizeString(moduleRun?.status) || (selectedRunMode === "none" ? "configured" : "pending"),
      summary: normalizeString(moduleRun?.summary) || null,
      reason: normalizeString(moduleRun?.reason) || null,
    });
  }

  for (const coverageArea of selection?.coverage?.softGuided || []) {
    addStageItem(stageMap, inferStageFromCoverageArea(coverageArea), "softGuided", {
      id: coverageArea,
      label: humanizeIdentifier(coverageArea),
      rawLabel: coverageArea,
      source: "coverage",
      kind: "soft_guidance",
      status: "configured",
      summary: null,
      reason: null,
    });
  }

  for (const coverageArea of selection?.coverage?.freeform || []) {
    addStageItem(stageMap, inferStageFromCoverageArea(coverageArea), "freeform", {
      id: coverageArea,
      label: humanizeIdentifier(coverageArea),
      rawLabel: coverageArea,
      source: "coverage",
      kind: "freeform_area",
      status: "open",
      summary: null,
      reason: null,
    });
  }

  return {
    selectedRunMode,
    stages: decorateStageMap(stageMap),
  };
}

// ---------------------------------------------------------------------------
// Coverage count helper
// ---------------------------------------------------------------------------

export function summarizeCoverageCounts(coverage) {
  const source = normalizeRecord(coverage);
  return {
    hardShaped: Array.isArray(source?.hardShaped) ? source.hardShaped.length : 0,
    softGuided: Array.isArray(source?.softGuided) ? source.softGuided.length : 0,
    freeform: Array.isArray(source?.freeform) ? source.freeform.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Full placement summary builder
// ---------------------------------------------------------------------------

export function buildPlacementSummary(automation) {
  const selection = normalizeHarnessSelection(automation?.harness || {}) || {};
  const harnessSummary = projectAutomationHarnessSummary({
    harness: automation?.harness,
    runtime: automation?.runtime,
  });
  const effectiveSelection = {
    ...selection,
    enabled: harnessSummary.harnessEnabled === true,
    mode: harnessSummary.executionMode || "freeform",
    profileId: harnessSummary.harnessProfileId || null,
    profileTrustLevel: harnessSummary.harnessProfileTrustLevel || null,
    assuranceLevel: harnessSummary.assuranceLevel || null,
    coverage: normalizeRecord(harnessSummary.harnessCoverage, selection.coverage || {}),
  };
  const coverage = normalizeRecord(effectiveSelection.coverage);
  const { selectedRunMode, stages } = buildPlacementStages(automation, effectiveSelection);
  const activeRun = normalizeRecord(automation?.runtime?.activeHarnessRun);
  const lastRun = normalizeRecord(automation?.runtime?.lastHarnessRun);

  return {
    id: automation?.id || "unknown",
    label: automation?.objective?.summary || automation?.id || "unknown",
    objectiveSummary: automation?.objective?.summary || null,
    objectiveDomain: automation?.adapters?.domain || automation?.objective?.domain || null,
    targetAgent: automation?.entry?.targetAgent || null,
    runtimeStatus: automation?.runtime?.status || null,
    executionMode: harnessSummary.executionMode,
    assuranceLevel: harnessSummary.assuranceLevel || "low_assurance",
    harnessEnabled: harnessSummary.harnessEnabled === true,
    harnessProfileId: harnessSummary.harnessProfileId || null,
    harnessProfileTrustLevel: harnessSummary.harnessProfileTrustLevel || null,
    currentRound: Number.isFinite(automation?.runtime?.currentRound) ? automation.runtime.currentRound : 0,
    bestScore: automation?.runtime?.bestScore ?? null,
    gateVerdict: harnessSummary.activeHarnessGateVerdict || harnessSummary.lastHarnessGateVerdict || "none",
    pendingModuleCount: Number(harnessSummary.activeHarnessPendingModuleCount) || 0,
    failedModuleCount: Math.max(
      Number(harnessSummary.activeHarnessFailedModuleCount) || 0,
      Number(harnessSummary.lastHarnessFailedModuleCount) || 0,
    ),
    recentHarnessRunCount: Number(harnessSummary.recentHarnessRunCount) || 0,
    coverage,
    coverageCounts: normalizeRecord(harnessSummary.harnessCoverageCounts),
    moduleRefs: uniqueStrings(effectiveSelection.moduleRefs),
    stages,
    selectedRunMode,
    activeRun: {
      id: normalizeString(activeRun.id) || null,
      status: normalizeString(activeRun.status) || null,
      round: Number.isFinite(activeRun.round) ? activeRun.round : null,
      gateVerdict: normalizeString(activeRun?.gateSummary?.verdict) || null,
      pendingModuleIds: uniqueStrings(activeRun?.gateSummary?.pendingModuleIds || []),
      failedModuleIds: uniqueStrings(activeRun?.gateSummary?.failedModuleIds || []),
    },
    lastRun: {
      id: normalizeString(lastRun.id) || null,
      status: normalizeString(lastRun.status) || null,
      round: Number.isFinite(lastRun.round) ? lastRun.round : null,
      gateVerdict: normalizeString(lastRun?.gateSummary?.verdict) || null,
      decision: normalizeString(lastRun.decision) || null,
      pendingModuleIds: uniqueStrings(lastRun?.gateSummary?.pendingModuleIds || []),
      failedModuleIds: uniqueStrings(lastRun?.gateSummary?.failedModuleIds || []),
    },
    usageKey: `${effectiveSelection.profileId || "freeform"}::${automation?.id || "unknown"}`,
  };
}
