import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { OC, atomicWriteFile } from "../state.js";
import { uniqueStrings } from "../core/normalize.js";

const AGENT_DEFAULT_SKILLS_STORE = join(OC, "workspaces", "controller", ".agent-default-skills.json");

function ensureAgentDefaults(config) {
  if (!config || typeof config !== "object") {
    return {};
  }
  if (!config.agents || typeof config.agents !== "object") {
    config.agents = {};
  }
  if (!config.agents.defaults || typeof config.agents.defaults !== "object") {
    config.agents.defaults = {};
  }
  return config.agents.defaults;
}

function readConfigDefaultSkills(config) {
  return uniqueStrings(config?.agents?.defaults?.skills || []);
}

export async function loadStoredConfiguredDefaultAgentSkills({ fallback = [] } = {}) {
  try {
    const parsed = JSON.parse(await readFile(AGENT_DEFAULT_SKILLS_STORE, "utf8"));
    if (Array.isArray(parsed)) {
      return uniqueStrings(parsed);
    }
    if (parsed && typeof parsed === "object") {
      return uniqueStrings(parsed.skills || []);
    }
  } catch {
    // Missing or invalid store falls back to the config snapshot.
  }
  return uniqueStrings(fallback);
}

export async function applyStoredConfiguredDefaultAgentSkills(config) {
  const defaults = ensureAgentDefaults(config);
  const skills = await loadStoredConfiguredDefaultAgentSkills({
    fallback: readConfigDefaultSkills(config),
  });
  if (skills.length > 0) {
    defaults.skills = skills;
  } else {
    delete defaults.skills;
  }
  return config;
}

export async function saveStoredConfiguredDefaultAgentSkills(skills) {
  const normalized = uniqueStrings(skills);
  await mkdir(join(OC, "workspaces", "controller"), { recursive: true });
  await atomicWriteFile(AGENT_DEFAULT_SKILLS_STORE, JSON.stringify({
    skills: normalized,
    updatedAt: Date.now(),
  }, null, 2));
  return normalized;
}

export function stripConfiguredDefaultAgentSkills(config) {
  if (
    config?.agents?.defaults
    && typeof config.agents.defaults === "object"
    && "skills" in config.agents.defaults
  ) {
    delete config.agents.defaults.skills;
    return true;
  }
  return false;
}
