import {
  normalizeBoolean,
  normalizeEnum,
  normalizePositiveInteger,
  normalizeRecord,
  normalizeString,
  uniqueStrings,
  uniqueTools,
} from "../core/normalize.js";
import {
  getHarnessModuleCatalogEntry,
  listHarnessModuleCatalog,
  resolveHarnessModuleCatalogId,
} from "./harness-module-catalog.js";

const VALID_EXECUTION_MODES = new Set([
  "freeform",
  "hybrid",
  "guarded",
]);

const VALID_PROFILE_TRUST_LEVELS = new Set([
  "stable",
  "provisional",
  "experimental",
]);

function freezeRecords(values) {
  return Object.freeze(values.map((entry) => Object.freeze({
    ...entry,
    moduleRefs: Object.freeze([...(Array.isArray(entry?.moduleRefs) ? entry.moduleRefs : [])]),
    hardShaped: Object.freeze([...(Array.isArray(entry?.hardShaped) ? entry.hardShaped : [])]),
    softGuided: Object.freeze([...(Array.isArray(entry?.softGuided) ? entry.softGuided : [])]),
    freeform: Object.freeze([...(Array.isArray(entry?.freeform) ? entry.freeform : [])]),
  })));
}

export function resolveModuleId(id) {
  return resolveHarnessModuleCatalogId(id);
}

const HARNESS_PROFILES = freezeRecords([
  {
    id: "coding.patch_and_test",
    trustLevel: "stable",
    moduleRefs: [
      "harness:guard.tool_access", "harness:guard.scope",
      "harness:collector.trace", "harness:collector.artifact",
      "harness:gate.test", "harness:gate.artifact",
      "harness:normalizer.eval_input",
    ],
    softGuided: [
      "change_summary",
      "handoff_note",
    ],
    freeform: [
      "implementation_strategy",
      "refactor_style",
    ],
  },
  {
    id: "experiment.research_cycle",
    trustLevel: "provisional",
    moduleRefs: [
      "harness:guard.budget",
      "harness:collector.trace", "harness:collector.artifact",
      "harness:gate.artifact", "harness:gate.schema",
      "harness:normalizer.eval_input", "harness:normalizer.failure",
    ],
    softGuided: [
      "experiment_memo",
      "error_list",
      "structured_handoff",
    ],
    freeform: [
      "research_reasoning",
      "parameter_search_direction",
      "implementation_strategy",
    ],
  },
  {
    id: "evaluation.score_and_verdict",
    trustLevel: "stable",
    moduleRefs: [
      "harness:collector.artifact",
      "harness:gate.schema", "harness:gate.artifact",
      "harness:normalizer.eval_input", "harness:normalizer.failure",
    ],
    softGuided: [
      "score_explanation",
      "verdict_summary",
    ],
    freeform: [
      "qualitative_reasoning",
    ],
  },
  {
    id: "stage.completion",
    trustLevel: "experimental",
    moduleRefs: [
      "harness:gate.artifact", "harness:gate.schema",
      "harness:normalizer.eval_input",
    ],
    softGuided: [
      "stage_summary",
      "stage_handoff",
    ],
    freeform: [
      "stage_reasoning",
      "stage_trace",
    ],
  },
]);

function uniqueCoverage(values) {
  return uniqueStrings(values || []);
}

function normalizeNonNegativeInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function mergeCoverageLists(...values) {
  return uniqueCoverage(values.flatMap((entry) => (Array.isArray(entry) ? entry : [])));
}

function buildDisjointCoverage({
  hardShaped = [],
  softGuided = [],
  freeform = [],
} = {}) {
  const hard = uniqueCoverage(hardShaped);
  const hardSet = new Set(hard);
  const soft = uniqueCoverage(softGuided).filter((entry) => !hardSet.has(entry));
  const softSet = new Set(soft);
  const free = uniqueCoverage(freeform).filter((entry) => !hardSet.has(entry) && !softSet.has(entry));
  return {
    hardShaped: hard,
    softGuided: soft,
    freeform: free,
  };
}

export function normalizeExecutionMode(value, fallback = "freeform") {
  return normalizeEnum(value, VALID_EXECUTION_MODES, fallback);
}

export function normalizeProfileTrustLevel(value, fallback = null) {
  return normalizeEnum(value, VALID_PROFILE_TRUST_LEVELS, fallback);
}

export function normalizeHarnessCoverage(value) {
  const source = normalizeRecord(value, {});
  return buildDisjointCoverage({
    hardShaped: mergeCoverageLists(
      source.hardShaped,
      source.hard,
      source.guaranteed,
    ),
    softGuided: mergeCoverageLists(
      source.softGuided,
      source.soft,
      source.guided,
    ),
    freeform: mergeCoverageLists(
      source.freeform,
      source.open,
    ),
  });
}

function listHarnessModules() {
  return listHarnessModuleCatalog();
}

export function getHarnessModule(moduleId) {
  return getHarnessModuleCatalogEntry(moduleId);
}

function listHarnessProfiles() {
  return [...HARNESS_PROFILES];
}

function getHarnessProfile(profileId) {
  const normalizedId = normalizeString(profileId);
  if (!normalizedId) return null;
  return HARNESS_PROFILES.find((entry) => entry.id === normalizedId) || null;
}

function parseHarnessModuleConfig(value) {
  const source = normalizeRecord(value, {});
  const moduleConfig = {};
  const invalidModuleIds = [];

  for (const [moduleId, rawConfig] of Object.entries(source)) {
    const normalizedModuleId = normalizeString(moduleId);
    if (!normalizedModuleId) continue;
    const resolvedModuleId = resolveHarnessModuleCatalogId(normalizedModuleId);
    if (resolvedModuleId === null) continue;
    if (!getHarnessModule(resolvedModuleId)) {
      invalidModuleIds.push(normalizedModuleId);
      continue;
    }

    const config = normalizeRecord(rawConfig, {});
    switch (resolvedModuleId) {
      case "harness:guard.budget":
        moduleConfig[resolvedModuleId] = {
          budgetSeconds: normalizePositiveInteger(
            config.budgetSeconds || config.timeoutSeconds,
            null,
          ),
          maxRetry: normalizeNonNegativeInteger(
            config.maxRetry || config.retryBudget,
            null,
          ),
        };
        break;
      case "harness:guard.tool_access":
        moduleConfig[resolvedModuleId] = {
          allowedTools: uniqueTools(config.allowedTools || config.tools || []),
          mode: normalizeString(config.mode || config.matchMode)?.toLowerCase() || "subset",
          allowNetwork: config.allowNetwork == null ? null : normalizeBoolean(config.allowNetwork),
          allowedDomains: uniqueStrings(config.allowedDomains || config.domains || []),
        };
        break;
      case "harness:guard.scope":
        moduleConfig[resolvedModuleId] = {
          policy: normalizeString(config.policy || config.mode || config.scope)?.toLowerCase() || null,
          allowedWorkspaceRoots: uniqueStrings(
            config.allowedWorkspaceRoots || config.allowedRoots || config.roots || [],
          ),
        };
        break;
      default:
        moduleConfig[resolvedModuleId] = { ...config };
        break;
    }
  }

  return {
    moduleConfig,
    configuredModuleIds: Object.keys(moduleConfig),
    invalidModuleIds,
  };
}

function buildProfileCoverage(profile) {
  const modules = uniqueCoverage((profile?.moduleRefs || [])
    .flatMap((moduleId) => getHarnessModule(moduleId)?.hardShaped || []));
  return buildDisjointCoverage({
    hardShaped: modules,
    softGuided: profile?.softGuided || [],
    freeform: profile?.freeform || [],
  });
}

function buildDefaultFreeformCoverage() {
  return {
    hardShaped: [],
    softGuided: [],
    freeform: [
      "agent_reasoning",
      "task_decomposition",
      "local_execution_strategy",
    ],
  };
}

export function normalizeHarnessSelection(value) {
  const source = normalizeRecord(value, {});
  const requestedProfileId = normalizeString(
    source.profileId
    || source.harnessProfile
    || source.harnessProfileId
    || source.profile,
  );
  const profile = requestedProfileId ? getHarnessProfile(requestedProfileId) : null;
  if (requestedProfileId && !profile) {
    return null;
  }
  const {
    moduleConfig,
    configuredModuleIds,
    invalidModuleIds,
  } = parseHarnessModuleConfig(source.moduleConfig || source.moduleConfigs || source.modulesConfig);
  if (invalidModuleIds.length > 0) {
    return null;
  }
  const rawRequestedModuleRefs = uniqueCoverage([
    ...(Array.isArray(source.moduleRefs) ? source.moduleRefs : []),
    ...(Array.isArray(source.modules) ? source.modules : []),
    ...(Array.isArray(source.moduleIds) ? source.moduleIds : []),
  ]);
  const unresolvedModuleRefs = rawRequestedModuleRefs.filter((moduleId) => !resolveHarnessModuleCatalogId(moduleId));
  if (unresolvedModuleRefs.length > 0) {
    return null;
  }
  const requestedModuleRefs = uniqueCoverage([
    ...rawRequestedModuleRefs
      .map((moduleId) => resolveHarnessModuleCatalogId(moduleId))
      .filter(Boolean),
    ...configuredModuleIds,
  ]);

  const profileCoverage = profile ? buildProfileCoverage(profile) : null;
  const modules = uniqueCoverage([
    ...(profile?.moduleRefs || []),
    ...requestedModuleRefs,
  ]);
  const requestedModuleCoverage = buildDisjointCoverage({
    hardShaped: modules.flatMap((moduleId) => getHarnessModule(moduleId)?.hardShaped || []),
  });
  const normalizedCoverage = normalizeHarnessCoverage(source.coverage || source.harnessCoverage);
  // Derive mode from coverage ratio (not preset)
  const preCoverage = buildDisjointCoverage({
    hardShaped: mergeCoverageLists(
      profileCoverage?.hardShaped,
      requestedModuleCoverage?.hardShaped,
      normalizedCoverage.hardShaped,
    ),
    softGuided: mergeCoverageLists(
      profileCoverage?.softGuided,
      normalizedCoverage.softGuided,
    ),
    freeform: mergeCoverageLists(
      profileCoverage?.freeform,
      normalizedCoverage.freeform,
    ),
  });
  const totalCoverage = preCoverage.hardShaped.length + preCoverage.softGuided.length + preCoverage.freeform.length;
  const hardRatio = totalCoverage > 0 ? preCoverage.hardShaped.length / totalCoverage : 0;
  let mode;
  if (hardRatio === 0 && modules.length === 0) mode = "freeform";
  else if (hardRatio >= 0.8) mode = "guarded";
  else mode = "hybrid";
  const coverage = buildDisjointCoverage({
    hardShaped: preCoverage.hardShaped,
    softGuided: preCoverage.softGuided,
    freeform: mergeCoverageLists(
      preCoverage.freeform,
      (!profile && mode === "freeform") ? buildDefaultFreeformCoverage().freeform : [],
    ),
  });
  return {
    enabled: mode !== "freeform" || profile != null || modules.length > 0 || coverage.hardShaped.length > 0,
    mode,
    profileId: profile?.id || null,
    profileTrustLevel: normalizeProfileTrustLevel(profile?.trustLevel, null),
    moduleRefs: modules,
    moduleConfig,
    coverage,
    summary: {
      hardShapedCount: coverage.hardShaped.length,
      softGuidedCount: coverage.softGuided.length,
      freeformCount: coverage.freeform.length,
      moduleCount: modules.length,
    },
  };
}

export function summarizeHarnessRegistry() {
  const modules = listHarnessModules();
  const profiles = listHarnessProfiles();
  return {
    counts: {
      modules: modules.length,
      profiles: profiles.length,
      stableProfiles: profiles.filter((entry) => entry.trustLevel === "stable").length,
      provisionalProfiles: profiles.filter((entry) => entry.trustLevel === "provisional").length,
      experimentalProfiles: profiles.filter((entry) => entry.trustLevel === "experimental").length,
    },
    modules,
    profiles,
  };
}
