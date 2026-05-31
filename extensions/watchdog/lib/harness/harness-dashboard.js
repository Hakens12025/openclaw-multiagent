import { inspectCliSystemSurface } from "../cli-system/cli-surface-registry.js";
import { getHarnessModule, summarizeHarnessRegistry } from "./harness-registry.js";
import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";
import { humanizeIdentifier, inferProfileFamily, buildPlacementSummary } from "./harness-dashboard-stages.js";
import { summarizeRecentRuns } from "./harness-dashboard-runs.js";

// Re-export for callers who imported summarizeHarnessPlacement from this file
export function summarizeHarnessPlacement(automation) {
  const placement = buildPlacementSummary(automation);
  placement.recentRuns = summarizeRecentRuns(automation);
  return placement;
}

// ---------------------------------------------------------------------------
// Catalog summary — modules/profiles/families with usage stats
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main dashboard entry point
// ---------------------------------------------------------------------------

export async function summarizeHarnessDashboard() {
  const [registry, automations] = await Promise.all([
    summarizeHarnessRegistry(),
    // automation summary 经 CLI-system inspect surface 读取，不直读 store（收口旁路）。
    inspectCliSystemSurface({ surfaceId: "inspect.automation_runtime_summary" }),
  ]);
  const placements = (Array.isArray(automations?.automations) ? automations.automations : [])
    .map((automation) => {
      const placement = buildPlacementSummary(automation);
      placement.recentRuns = summarizeRecentRuns(automation);
      return placement;
    })
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
