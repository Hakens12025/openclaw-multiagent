import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  applyStoredConfiguredDefaultAgentSkills,
  stripConfiguredDefaultAgentSkills,
} from "../agent-default-skills-store.js";
import { isDefaultResetToken } from "./agent-admin-defaults.js";
import { normalizeStoredAgentBindings } from "../agent-binding-store.js";
import {
  requireExistingAgent,
  requireNormalizedAgentId,
} from "./agent-admin-context.js";
import { invalidateCapabilityRegistryCache } from "../../management/capability-registry.js";
import { registerRuntimeAgents } from "../agent-identity.js";
import { normalizeString, uniqueStrings } from "../../core/normalize.js";
import { OC, atomicWriteFile, withLock } from "../../state.js";
import {
  emitDispatchRuntimeSnapshot,
  persistDispatchRuntimeState,
  syncDispatchTargetsFromRuntime,
} from "../../routing/dispatch/dispatch-runtime-state.js";

export function normalizeSkillPayload(skills) {
  if (Array.isArray(skills)) {
    return uniqueStrings(skills);
  }
  const normalized = normalizeString(skills);
  if (!normalized) return [];
  return uniqueStrings(normalized.split(/[\n,]+/g));
}

function configPath() {
  return join(OC, "openclaw.json");
}

// loadConfig is called on every before_agent_start hook; mtime-keyed cache
// avoids repeated readFile + JSON.parse + normalize on the hot path while
// still picking up legitimate edits (admin saves bump mtime).
let configCacheMtime = null;
let configCachePromise = null;

function invalidateConfigCache() {
  configCacheMtime = null;
  configCachePromise = null;
}

async function loadConfigUncached() {
  const raw = await readFile(configPath(), "utf8");
  const config = JSON.parse(raw);
  if (!config || typeof config !== "object") {
    throw new Error("invalid openclaw config");
  }
  if (!config.agents || typeof config.agents !== "object") {
    throw new Error("missing config.agents");
  }
  if (!Array.isArray(config.agents.list)) {
    throw new Error("missing config.agents.list");
  }
  const originalSnapshot = JSON.stringify(config);
  const nextConfig = await applyStoredConfiguredDefaultAgentSkills(config);
  normalizeStoredAgentBindings(nextConfig);
  if (originalSnapshot !== JSON.stringify(nextConfig)) {
    await atomicWriteFile(configPath(), JSON.stringify(nextConfig, null, 2));
    invalidateConfigCache();
  }
  return nextConfig;
}

export async function loadConfig() {
  try {
    const info = await stat(configPath());
    const mtime = info.mtimeMs;
    if (mtime === configCacheMtime && configCachePromise) {
      return configCachePromise;
    }
    configCacheMtime = mtime;
    configCachePromise = loadConfigUncached();
    return configCachePromise;
  } catch (error) {
    invalidateConfigCache();
    if (error?.code === "ENOENT") throw error;
    return loadConfigUncached();
  }
}

export function stripUnsupportedAgentConfigKeys(config) {
  let changed = false;
  if (stripConfiguredDefaultAgentSkills(config)) {
    changed = true;
  }
  return changed;
}

export async function saveConfig(config) {
  stripUnsupportedAgentConfigKeys(config);
  normalizeStoredAgentBindings(config);
  await atomicWriteFile(configPath(), JSON.stringify(config, null, 2));
  invalidateConfigCache();
  registerRuntimeAgents(config);
  await syncDispatchTargetsFromRuntime();
  emitDispatchRuntimeSnapshot();
  await persistDispatchRuntimeState();
  invalidateCapabilityRegistryCache();
}

export async function runAgentAdminWrite(fn) {
  return withLock("agent-admin:write", fn);
}

export function normalizeOverrideListInput(value, normalizer = uniqueStrings) {
  if (Array.isArray(value)) {
    const normalized = normalizer(value);
    if (normalized.length === 1 && isDefaultResetToken(normalized[0])) {
      return null;
    }
    return normalized.length ? normalized : null;
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  if (isDefaultResetToken(normalized)) {
    return null;
  }

  const parsed = normalizer(normalized.split(/[\n,]+/g));
  return parsed.length ? parsed : null;
}

export async function loadExistingAgentConfig(agentId) {
  const normalizedAgentId = requireNormalizedAgentId(agentId);
  const config = await loadConfig();
  const agent = requireExistingAgent(config, normalizedAgentId);
  return {
    config,
    agent,
    agentId: normalizedAgentId,
  };
}
