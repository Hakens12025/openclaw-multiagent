import { listFormalTestPresets } from "./formal-test-presets.js";
import {
  SINGLE_CASES,
  CONCURRENT_CASES,
} from "./formal-runtime/suite-single.js";
import { DIRECT_SERVICE_CASES } from "./formal-runtime/suite-direct-service.js";

export const DEV_TEST_PRESETS = listFormalTestPresets();
export const TEST_RUN_CLEAN_MODE = "session-clean";

const PRESET_MAP = new Map(DEV_TEST_PRESETS.map((preset) => [preset.id, preset]));

function collectCases(caseIds, cases, suite) {
  const caseMap = new Map(cases.map((item) => [item.id, item]));
  return caseIds.map((id) => {
    const entry = caseMap.get(id);
    if (!entry) {
      throw new Error(`unknown ${suite} case: ${id}`);
    }
    return entry;
  });
}

export function collectSingleCases(caseIds) {
  return collectCases(caseIds, SINGLE_CASES, "single");
}

export function collectConcurrentCases(caseIds) {
  return collectCases(caseIds, CONCURRENT_CASES, "concurrent");
}

export function collectDirectServiceCases(caseIds) {
  return collectCases(caseIds, DIRECT_SERVICE_CASES, "direct-service");
}

export function resolvePresetCases(preset) {
  const caseIds = Array.isArray(preset?.caseIds) ? preset.caseIds : [];
  switch (preset?.suite) {
    case "single":
      return collectSingleCases(caseIds);
    case "concurrent":
      return collectConcurrentCases(caseIds);
    case "direct-service":
      return collectDirectServiceCases(caseIds);
    default:
      throw new Error(`unknown preset suite: ${preset?.suite || "unknown"}`);
  }
}

export function normalizeTestRunCleanMode(value) {
  const normalized = String(value || "").trim() || TEST_RUN_CLEAN_MODE;
  if (normalized !== TEST_RUN_CLEAN_MODE) {
    throw new Error(`unsupported test run cleanMode: ${normalized}`);
  }
  return TEST_RUN_CLEAN_MODE;
}

function buildAdHocCasePreset({
  suite,
  caseId,
  caseDef,
  transport = "isolated",
} = {}) {
  const normalizedCaseId = String(caseId || "").trim();
  if (!normalizedCaseId) {
    throw new TypeError("buildAdHocCasePreset requires caseId");
  }
  const description = String(caseDef?.description || caseDef?.message || normalizedCaseId).trim();
  return {
    id: `case-${normalizedCaseId}`,
    label: `单用例 ${normalizedCaseId}`,
    description,
    suite,
    caseIds: [normalizedCaseId],
    resetBetweenCases: false,
    transport,
    cleanMode: TEST_RUN_CLEAN_MODE,
    requestedCaseId: normalizedCaseId,
  };
}

function resolveAdHocCasePreset(caseId) {
  const normalizedCaseId = String(caseId || "").trim();
  if (!normalizedCaseId) return null;

  const candidates = [
    { suite: "single", transport: "isolated", collect: collectSingleCases },
    { suite: "concurrent", transport: "isolated", collect: collectConcurrentCases },
    { suite: "direct-service", transport: "runtime", collect: collectDirectServiceCases },
  ];
  for (const candidate of candidates) {
    try {
      const caseDef = candidate.collect([normalizedCaseId])[0];
      if (!caseDef) continue;
      return buildAdHocCasePreset({
        suite: candidate.suite,
        caseId: normalizedCaseId,
        caseDef,
        transport: candidate.transport,
      });
    } catch {
      continue;
    }
  }

  return null;
}

export function resolveRequestedFormalPreset({
  presetId = null,
  caseId = null,
} = {}) {
  const normalizedPresetId = String(presetId || "").trim();
  const normalizedCaseId = String(caseId || "").trim();

  if (normalizedPresetId && normalizedCaseId) {
    throw new Error("provide either presetId or caseId, not both");
  }

  if (normalizedPresetId) {
    const preset = PRESET_MAP.get(normalizedPresetId);
    if (!preset) {
      throw new Error(`unknown preset: ${normalizedPresetId}`);
    }
    return {
      ...preset,
      caseIds: [...preset.caseIds],
    };
  }

  if (normalizedCaseId) {
    const preset = resolveAdHocCasePreset(normalizedCaseId);
    if (!preset) {
      throw new Error(`unknown case: ${normalizedCaseId}`);
    }
    return preset;
  }

  throw new Error("missing presetId or caseId");
}
