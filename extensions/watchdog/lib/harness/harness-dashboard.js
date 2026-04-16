import { summarizeAutomationRuntimeRegistry } from "../automation/automation-runtime.js";
import { projectAutomationHarnessSummary } from "../automation/automation-harness-projection.js";
import {
  getHarnessModule,
  normalizeHarnessSelection,
  summarizeHarnessRegistry,
} from "./harness-registry.js";
import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";

const EXECUTION_STAGES = Object.freeze([
  { id: "preflight", label: "PREFLIGHT" },
  { id: "dispatch", label: "DISPATCH" },
  { id: "in_run", label: "IN-RUN" },
  { id: "completion", label: "COMPLETION" },
  { id: "evaluation", label: "EVALUATION" },
  { id: "feedback", label: "FEEDBACK" },
]);

function humanizeIdentifier(value) {
  // Strip harness: namespace prefix before humanizing (e.g. "harness:guard.budget" → "Budget")
  const raw = String(value || "");
  const colonIdx = raw.indexOf(":");
  const name = colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw;
  // Take only the part after the first dot separator (the logical name)
  const dotIdx = name.indexOf(".");
  const displayPart = dotIdx >= 0 ? name.slice(dotIdx + 1) : name;
  return displayPart
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function inferProfileFamily(profileId) {
  const normalized = normalizeString(profileId);
  if (!normalized) return "general";
  const [family] = normalized.split(".");
  return family || "general";
}

function inferStageFromModuleKind(kind) {
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

function inferStageFromCoverageArea(area) {
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
    return {
      mode: "active",
      run: source.activeHarnessRun,
    };
  }
  if (source.lastHarnessRun && typeof source.lastHarnessRun === "object") {
    return {
      mode: "last",
      run: source.lastHarnessRun,
    };
  }
  return {
    mode: "none",
    run: null,
  };
}

function buildPlacementStages(automation, selection) {
  const runtime = normalizeRecord(automation?.runtime);
  const {
    mode: selectedRunMode,
    run: selectedRun,
  } = selectPlacementRun(runtime);
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

function summarizeRecentRuns(automation) {
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

function summarizePlacement(automation) {
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
  const {
    selectedRunMode,
    stages,
  } = buildPlacementStages(automation, effectiveSelection);
  const activeRun = normalizeRecord(automation?.runtime?.activeHarnessRun);
  const lastRun = normalizeRecord(automation?.runtime?.lastHarnessRun);
  const recentRuns = summarizeRecentRuns(automation);

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
    recentRuns,
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

export function summarizeHarnessPlacement(automation) {
  return summarizePlacement(automation);
}

function summarizeCatalog(registry, placements) {
  const modules = Array.isArray(registry?.modules) ? registry.modules : [];
  const profiles = Array.isArray(registry?.profiles) ? registry.profiles : [];
  const placementsList = Array.isArray(placements) ? placements : [];

  const profileUsage = new Map();
  const moduleUsage = new Map();

  for (const placement of placementsList) {
    if (placement?.harnessProfileId) {
      profileUsage.set(placement.harnessProfileId, (profileUsage.get(placement.harnessProfileId) || 0) + 1);
    }
    for (const moduleId of placement?.moduleRefs || []) {
      moduleUsage.set(moduleId, (moduleUsage.get(moduleId) || 0) + 1);
    }
  }

  const decoratedProfiles = profiles.map((profile) => ({
    ...profile,
    family: inferProfileFamily(profile.id),
    usageCount: profileUsage.get(profile.id) || 0,
    hardShaped: uniqueStrings((profile.moduleRefs || [])
      .flatMap((moduleId) => getHarnessModule(moduleId)?.hardShaped || [])),
    coverageCounts: {
      hardShaped: Array.isArray(profile.hardShaped) ? profile.hardShaped.length : 0,
      softGuided: Array.isArray(profile.softGuided) ? profile.softGuided.length : 0,
      freeform: Array.isArray(profile.freeform) ? profile.freeform.length : 0,
    },
  }));

  const moduleFamilies = new Map();
  for (const profile of decoratedProfiles) {
    for (const moduleId of Array.isArray(profile.moduleRefs) ? profile.moduleRefs : []) {
      if (!moduleFamilies.has(moduleId)) moduleFamilies.set(moduleId, new Set());
      moduleFamilies.get(moduleId).add(profile.family);
    }
  }

  const decoratedModules = modules.map((module) => ({
    ...module,
    familyIds: [...(moduleFamilies.get(module.id) || new Set(["core"]))].sort(),
    usageCount: moduleUsage.get(module.id) || 0,
    profileIds: decoratedProfiles
      .filter((profile) => Array.isArray(profile.moduleRefs) && profile.moduleRefs.includes(module.id))
      .map((profile) => profile.id),
  }));

  const families = [...new Set([
    ...decoratedProfiles.map((profile) => profile.family),
    ...decoratedModules.flatMap((module) => module.familyIds || []),
  ])]
    .sort()
    .map((familyId) => ({
      id: familyId,
      label: humanizeIdentifier(familyId),
      profileCount: decoratedProfiles.filter((profile) => profile.family === familyId).length,
      moduleCount: decoratedModules.filter((module) => Array.isArray(module.familyIds) && module.familyIds.includes(familyId)).length,
      automationCount: placementsList.filter((placement) => inferProfileFamily(placement?.harnessProfileId) === familyId).length,
      stableProfiles: decoratedProfiles.filter((profile) => profile.family === familyId && profile.trustLevel === "stable").length,
      provisionalProfiles: decoratedProfiles.filter((profile) => profile.family === familyId && profile.trustLevel === "provisional").length,
      experimentalProfiles: decoratedProfiles.filter((profile) => profile.family === familyId && profile.trustLevel === "experimental").length,
    }));

  return {
    counts: {
      modules: decoratedModules.length,
      profiles: decoratedProfiles.length,
      families: families.length,
    },
    modules: decoratedModules,
    profiles: decoratedProfiles,
    families,
  };
}

export async function summarizeHarnessDashboard() {
  const [registry, automations] = await Promise.all([
    summarizeHarnessRegistry(),
    summarizeAutomationRuntimeRegistry(),
  ]);
  const placements = (Array.isArray(automations?.automations) ? automations.automations : [])
    .map((automation) => summarizePlacement(automation))
    .sort((left, right) => {
      const leftScore = left.runtimeStatus === "running" ? 3 : left.failedModuleCount > 0 ? 2 : left.pendingModuleCount > 0 ? 1 : 0;
      const rightScore = right.runtimeStatus === "running" ? 3 : right.failedModuleCount > 0 ? 2 : right.pendingModuleCount > 0 ? 1 : 0;
      if (rightScore !== leftScore) return rightScore - leftScore;
      return String(left.label || left.id).localeCompare(String(right.label || right.id));
    });
  const catalog = summarizeCatalog(registry, placements);

  return {
    generatedAt: Date.now(),
    counts: {
      modules: catalog.counts.modules,
      profiles: catalog.counts.profiles,
      families: catalog.counts.families,
      automations: placements.length,
      activeAutomations: placements.filter((entry) => entry.runtimeStatus === "running").length,
      pendingHarnessAutomations: placements.filter((entry) => entry.pendingModuleCount > 0 || entry.gateVerdict === "pending").length,
      failingHarnessAutomations: placements.filter((entry) => entry.failedModuleCount > 0 || entry.gateVerdict === "failed").length,
      freeformAutomations: placements.filter((entry) => entry.executionMode === "freeform").length,
      hybridAutomations: placements.filter((entry) => entry.executionMode === "hybrid").length,
      guardedAutomations: placements.filter((entry) => entry.executionMode === "guarded").length,
    },
    catalog,
    placements,
    links: {
      automations: "/watchdog/automations",
      operatorSnapshot: "/watchdog/operator-snapshot",
    },
  };
}
