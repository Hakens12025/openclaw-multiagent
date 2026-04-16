import {
  getConfiguredDefaultSkillRefs,
  getForcedPlatformSkillRefs,
  getRoleInjectedDefaultSkillMap,
  getReservedConfiguredDefaultSkillIds,
} from "./agent-binding-policy.js";
import { normalizeString, uniqueStrings } from "../core/normalize.js";

const DEFAULT_OPENCLAW_HEARTBEAT_EVERY = "30m";
const DEFAULT_RESET_TOKENS = new Set(["default", "inherit", "reset"]);

export function ensureAgentDefaults(config) {
  if (!config.agents || typeof config.agents !== "object") {
    config.agents = {};
  }
  if (!config.agents.defaults || typeof config.agents.defaults !== "object") {
    config.agents.defaults = {};
  }
  return config.agents.defaults;
}

export function isDefaultResetToken(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return false;
  }
  return DEFAULT_RESET_TOKENS.has(normalized.toLowerCase().replace(/\s+/g, ""));
}

export function resolveDefaultModel(config) {
  return normalizeString(config?.agents?.defaults?.model?.primary)
    || normalizeString(config?.agents?.defaults?.model)
    || null;
}

export function resolveDefaultHeartbeatEvery(config) {
  return normalizeString(config?.agents?.defaults?.heartbeat?.every)
    || DEFAULT_OPENCLAW_HEARTBEAT_EVERY;
}

export function normalizeHeartbeatEveryInput(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error("missing heartbeat every");
  }

  const lowered = normalized.toLowerCase().replace(/\s+/g, "");
  if (DEFAULT_RESET_TOKENS.has(lowered)) {
    return null;
  }
  if (!/^\d+(ms|s|m|h|d)$/.test(lowered)) {
    throw new Error('invalid heartbeat.every: expected duration like "30m", "12h", "0m", or "default"');
  }
  return lowered;
}

export function normalizeRequiredModelInput(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error("missing model");
  }
  return normalized;
}

export function normalizeRequiredNameInput(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error("missing name");
  }
  return normalized;
}

export function normalizeRequiredDescriptionInput(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error("missing description");
  }
  return normalized;
}

export function normalizeOptionalBooleanInput(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  const normalized = normalizeString(String(value));
  if (!normalized) return undefined;
  const lowered = normalized.toLowerCase().replace(/\s+/g, "");
  if (DEFAULT_RESET_TOKENS.has(lowered)) return null;
  if (["true", "1", "yes", "on"].includes(lowered)) return true;
  if (["false", "0", "no", "off"].includes(lowered)) return false;
  throw new Error(`invalid ${fieldName}: expected boolean or "default"`);
}

export function normalizeOptionalIntegerInput(value, fieldName, { min = 1 } = {}) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    if (normalized < min) {
      throw new Error(`invalid ${fieldName}: expected integer >= ${min}`);
    }
    return normalized;
  }

  const normalized = normalizeString(String(value));
  if (!normalized) return undefined;
  const lowered = normalized.toLowerCase().replace(/\s+/g, "");
  if (DEFAULT_RESET_TOKENS.has(lowered)) return null;
  if (!/^\d+$/.test(lowered)) {
    throw new Error(`invalid ${fieldName}: expected integer or "default"`);
  }

  const parsed = Number.parseInt(lowered, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`invalid ${fieldName}: expected integer >= ${min}`);
  }
  return parsed;
}

export function normalizeOptionalStringTokenInput(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = normalizeString(String(value));
  if (!normalized) return undefined;
  const lowered = normalized.toLowerCase().replace(/\s+/g, "");
  if (DEFAULT_RESET_TOKENS.has(lowered)) return null;
  return normalizeString(value)?.toLowerCase() || null;
}

export function normalizeConstraintPatchInput({
  serialExecution = undefined,
  maxConcurrent = undefined,
  timeoutSeconds = undefined,
  maxRetry = undefined,
} = {}) {
  const patch = {
    serialExecution: normalizeOptionalBooleanInput(serialExecution, "serialExecution"),
    maxConcurrent: normalizeOptionalIntegerInput(maxConcurrent, "maxConcurrent"),
    timeoutSeconds: normalizeOptionalIntegerInput(timeoutSeconds, "timeoutSeconds"),
    maxRetry: normalizeOptionalIntegerInput(maxRetry, "maxRetry", { min: 0 }),
  };
  if (Object.values(patch).every((value) => value === undefined)) {
    throw new Error("missing constraints patch");
  }
  return patch;
}

export function buildAgentDefaultsSnapshot(config) {
  const defaults = ensureAgentDefaults(config);
  const heartbeatDefaults = defaults.heartbeat && typeof defaults.heartbeat === "object"
    ? defaults.heartbeat
    : {};
  const subagentDefaults = defaults.subagents && typeof defaults.subagents === "object"
    ? defaults.subagents
    : {};
  const configuredDefaultSkills = getConfiguredDefaultSkillRefs(config);
  const configuredModelPrimary = normalizeString(defaults?.model?.primary)
    || normalizeString(defaults?.model);
  const effectiveModelPrimary = resolveDefaultModel(config);
  const configuredHeartbeatEvery = normalizeString(heartbeatDefaults.every);
  const effectiveHeartbeatEvery = resolveDefaultHeartbeatEvery(config);
  return {
    configuredModelPrimary,
    effectiveModelPrimary,
    configuredHeartbeatEvery,
    effectiveHeartbeatEvery,
    heartbeatLightContext: heartbeatDefaults.lightContext === true,
    defaultSkills: configuredDefaultSkills,
    configuredDefaultSkills,
    effectivePlatformDefaultSkills: uniqueStrings([
      ...configuredDefaultSkills,
      ...getForcedPlatformSkillRefs(),
    ]),
    reservedConfiguredSkillIds: getReservedConfiguredDefaultSkillIds(),
    roleInjectedDefaultSkills: getRoleInjectedDefaultSkillMap(),
    timeoutSeconds: Number.isFinite(defaults.timeoutSeconds) ? defaults.timeoutSeconds : null,
    typingIntervalSeconds: Number.isFinite(defaults.typingIntervalSeconds) ? defaults.typingIntervalSeconds : null,
    typingMode: normalizeString(defaults.typingMode),
    maxConcurrent: Number.isFinite(defaults.maxConcurrent) ? defaults.maxConcurrent : null,
    subagentsMaxConcurrent: Number.isFinite(subagentDefaults.maxConcurrent) ? subagentDefaults.maxConcurrent : null,
    subagentsRunTimeoutSeconds: Number.isFinite(subagentDefaults.runTimeoutSeconds)
      ? subagentDefaults.runTimeoutSeconds
      : null,
  };
}
