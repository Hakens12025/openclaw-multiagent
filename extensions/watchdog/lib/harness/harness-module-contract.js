import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";
import { getHarnessModuleCatalogEntry } from "./harness-module-catalog.js";

export const HARNESS_MODULE_KIND = Object.freeze({
  GUARD: "guard",
  COLLECTOR: "collector",
  GATE: "gate",
  NORMALIZER: "normalizer",
});

const VALID_HARNESS_MODULE_KINDS = new Set(Object.values(HARNESS_MODULE_KIND));

function cloneJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function normalizeHarnessModuleKind(value, fallback = null) {
  const normalized = normalizeString(value)?.toLowerCase() || null;
  return normalized && VALID_HARNESS_MODULE_KINDS.has(normalized)
    ? normalized
    : fallback;
}

export function normalizeHarnessModuleDefinition(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const id = normalizeString(source.id || source.moduleId);
  const kind = normalizeHarnessModuleKind(source.kind);
  if (!id || !kind) return null;

  return {
    id,
    kind,
    hardShaped: uniqueStrings(source.hardShaped || []),
  };
}

function resolveHarnessModuleDefinition({ module = null, moduleId = null } = {}) {
  const direct = normalizeHarnessModuleDefinition(module);
  if (direct) return direct;
  return normalizeHarnessModuleDefinition(getHarnessModuleCatalogEntry(moduleId));
}

function normalizeModuleConfig(automationSpec, moduleId) {
  const harness = normalizeRecord(automationSpec?.harness, {});
  const moduleConfig = normalizeRecord(harness.moduleConfig, {});
  return cloneJsonValue(normalizeRecord(moduleConfig[moduleId], {}));
}

export function buildHarnessModuleStartInput({
  module = null,
  moduleId = null,
  harnessRun = null,
  automationSpec = null,
  executionContext = null,
} = {}) {
  const resolvedModule = resolveHarnessModuleDefinition({ module, moduleId });
  if (!resolvedModule) return null;

  return {
    phase: "start",
    module: resolvedModule,
    run: cloneJsonValue(normalizeRecord(harnessRun, {})),
    automationSpec: cloneJsonValue(automationSpec),
    executionContext: cloneJsonValue(normalizeRecord(executionContext, {})),
    moduleConfig: normalizeModuleConfig(automationSpec, resolvedModule.id),
  };
}

export function buildHarnessModuleFinalizeInput({
  module = null,
  moduleId = null,
  harnessRun = null,
  automationSpec = null,
  executionContext = null,
  terminalSource = null,
  baseEvidence = null,
} = {}) {
  const startInput = buildHarnessModuleStartInput({
    module,
    moduleId,
    harnessRun,
    automationSpec,
    executionContext,
  });
  if (!startInput) return null;

  return {
    ...startInput,
    phase: "finalize",
    terminalSource: cloneJsonValue(normalizeRecord(terminalSource, {})),
    baseEvidence: cloneJsonValue(normalizeRecord(baseEvidence, {})),
  };
}
