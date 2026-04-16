import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { OC } from "../state.js";
import { readJsonFile } from "../state-file-utils.js";
import { applyStoredConfiguredDefaultAgentSkills } from "../agent/agent-default-skills-store.js";
import { summarizeAgentJoinRegistry } from "../agent/agent-join-registry.js";
import { normalizeStoredAgentBindings } from "../agent/agent-binding-store.js";
import { getAdminChangeSetManagementActivity } from "../admin/admin-change-sets.js";
import { buildAgentDefaultsSnapshot } from "../agent/agent-admin-defaults.js";
import {
  getConfiguredDefaultSkillRefs,
  getForcedPlatformSkillRefs,
} from "../agent/agent-binding-policy.js";
import { buildAgentRegistry } from "../agent/agent-registry-view.js";
import { summarizeAutomationRuntimeRegistry } from "../automation/automation-runtime.js";
import { buildManagementRegistry } from "../management-registry-view.js";
import { buildModelRegistry } from "../model-registry-view.js";
import { normalizeString, uniqueStrings } from "../core/normalize.js";
import { getSemanticSkillSpec } from "../semantic-skill-registry.js";
const CAPABILITY_REGISTRY_TTL_MS = 1000;

let capabilityRegistryCache = null;
let capabilityRegistryCacheAt = 0;
let capabilityRegistryCachePromise = null;
let capabilityRegistryCacheGeneration = 0;

export function invalidateCapabilityRegistryCache() {
  capabilityRegistryCache = null;
  capabilityRegistryCacheAt = 0;
  capabilityRegistryCachePromise = null;
  capabilityRegistryCacheGeneration += 1;
}

function parseSkillFrontMatter(markdown) {
  const text = String(markdown || "");
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return {};
  const block = text.slice(4, end);
  const meta = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!match) continue;
    meta[match[1]] = match[2].trim();
  }
  return meta;
}

export async function loadOpenClawConfig() {
  const config = await readJsonFile(join(OC, "openclaw.json"));
  if (!config || typeof config !== "object") {
    return {};
  }
  const nextConfig = applyStoredConfiguredDefaultAgentSkills(config);
  normalizeStoredAgentBindings(nextConfig);
  return nextConfig;
}

async function buildSkillRegistry(config, agents) {
  const defaultSkills = new Set(uniqueStrings([
    ...getConfiguredDefaultSkillRefs(config),
    ...getForcedPlatformSkillRefs(),
  ]));
  const boundAgents = new Map();
  for (const agent of agents) {
    for (const skillId of agent.effectiveSkills || []) {
      if (!boundAgents.has(skillId)) boundAgents.set(skillId, []);
      boundAgents.get(skillId).push(agent.id);
    }
  }

  let entries = [];
  try {
    entries = await readdir(join(OC, "skills"), { withFileTypes: true });
  } catch {
    entries = [];
  }

  const skills = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const skillId = entry.name;
      const skillPath = join(OC, "skills", skillId, "SKILL.md");
      const source = await readFile(skillPath, "utf8").catch(() => "");
      const meta = parseSkillFrontMatter(source);
      const semanticSpec = getSemanticSkillSpec(skillId);
      return {
        id: skillId,
        name: normalizeString(semanticSpec?.name) || normalizeString(meta.name) || skillId,
        description: normalizeString(meta.description) || normalizeString(semanticSpec?.summary),
        path: `skills/${skillId}/SKILL.md`,
        defaultEnabled: defaultSkills.has(skillId),
        semanticLayer: normalizeString(semanticSpec?.layer) || null,
        audience: normalizeString(semanticSpec?.audience) || null,
        defaultInjection: normalizeString(semanticSpec?.defaultInjection) || null,
        enabledRoles: uniqueStrings(semanticSpec?.enabledRoles || []),
        pluginRefs: uniqueStrings(semanticSpec?.pluginRefs || []),
        toolRefs: uniqueStrings(semanticSpec?.toolRefs || []),
        guideLine: normalizeString(semanticSpec?.guideLine) || null,
        operatorUse: normalizeString(semanticSpec?.operatorUse) || null,
        boundAgents: (boundAgents.get(skillId) || []).sort(),
      };
    }));

  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadCapabilityRegistry() {
  if (capabilityRegistryCache && (Date.now() - capabilityRegistryCacheAt) < CAPABILITY_REGISTRY_TTL_MS) {
    return capabilityRegistryCache;
  }
  if (capabilityRegistryCachePromise) {
    return capabilityRegistryCachePromise;
  }

  const generation = capabilityRegistryCacheGeneration;
  capabilityRegistryCachePromise = (async () => {
    const config = await loadOpenClawConfig();
    const agentDefaults = {
      ok: true,
      ...buildAgentDefaultsSnapshot(config),
    };
    const baseAgents = await buildAgentRegistry(config);
    const skills = await buildSkillRegistry(config, baseAgents);
    const models = await buildModelRegistry(config);
    const agentJoins = await summarizeAgentJoinRegistry();
    const automations = await summarizeAutomationRuntimeRegistry();
    const activity = await getAdminChangeSetManagementActivity();
    const {
      agents,
      management,
    } = buildManagementRegistry({
      activity,
      agents: baseAgents,
      agentJoins: agentJoins.agentJoins,
      models,
      automations: automations.automations,
      agentDefaults,
    });
    const registry = {
      agents,
      agentJoins: agentJoins.agentJoins,
      skills,
      models,
      automations: automations.automations,
      agentDefaults,
      management,
    };
    if (generation === capabilityRegistryCacheGeneration) {
      capabilityRegistryCache = registry;
      capabilityRegistryCacheAt = Date.now();
    }
    return registry;
  })();

  try {
    return await capabilityRegistryCachePromise;
  } finally {
    capabilityRegistryCachePromise = null;
  }
}

export async function listAgentRegistry() {
  return (await loadCapabilityRegistry()).agents;
}

export async function listSkillRegistry() {
  return (await loadCapabilityRegistry()).skills;
}

export async function listModelRegistry() {
  return (await loadCapabilityRegistry()).models || [];
}

export async function readAgentDefaultsRegistry() {
  return (await loadCapabilityRegistry()).agentDefaults || { ok: true };
}

export async function getCapabilityManagementRegistry() {
  return (await loadCapabilityRegistry()).management;
}
