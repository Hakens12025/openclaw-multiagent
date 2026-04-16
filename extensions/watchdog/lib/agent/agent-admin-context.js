import { composeDefaultCapabilityProjection } from "./agent-capability-policy.js";
import { composeAgentCardBase } from "./agent-card-composer.js";
import {
  PROTECTED_AGENT_IDS,
  SUPPORTED_AGENT_ROLES,
  isProtectedAgentId,
  isSupportedAgentRole,
} from "./agent-identity.js";
import {
  resolveStoredAgentRole,
  syncAgentWorkspaceProfile,
  writeAgentCardProfile,
} from "./agent-admin-profile.js";
import { listSkillRegistry } from "../capability/capability-registry.js";
import {
  composeAgentBinding,
  loadAgentCardProjection,
} from "../effective-profile-composer.js";
import { normalizeString } from "../core/normalize.js";

export {
  PROTECTED_AGENT_IDS,
  SUPPORTED_AGENT_ROLES,
  isProtectedAgentId,
  isSupportedAgentRole,
} from "./agent-identity.js";

export function requireNormalizedAgentId(agentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    throw new Error("missing agentId");
  }
  return normalizedAgentId;
}

export function requireExistingAgent(config, agentId) {
  const agent = config.agents.list.find((item) => item?.id === agentId);
  if (!agent) {
    throw new Error(`agent not found: ${agentId}`);
  }
  return agent;
}

export async function validateRegisteredSkills(skillIds) {
  const availableSkills = new Set((await listSkillRegistry()).map((skill) => skill.id));
  const unknownSkills = skillIds.filter((skillId) => !availableSkills.has(skillId));
  if (unknownSkills.length > 0) {
    throw new Error(`unknown skill ids: ${unknownSkills.join(", ")}`);
  }
}

function buildAgentProfileBaseCard({
  agentId,
  role,
}) {
  return composeAgentCardBase({
    agentId,
    role,
  });
}

function buildAgentProfileBaseCapabilities({
  role,
  effectiveSkills,
}) {
  return composeDefaultCapabilityProjection({
    role,
    skills: effectiveSkills,
  });
}

export async function resolveAgentProfileContext({
  config,
  agentId,
  agent,
  role = null,
}) {
  const card = await loadAgentCardProjection(agent);
  const binding = composeAgentBinding({
    config,
    agentConfig: agent,
    card,
    role: role || await resolveStoredAgentRole(agentId),
  });
  return {
    role: binding.roleRef,
    configuredSkills: binding.skills?.configured || [],
    defaultSkills: binding.skills?.defaults || [],
    effectiveSkills: binding.skills?.effective || [],
    binding,
  };
}

export async function syncExistingAgentWorkspaceProfile({
  config,
  agentId,
  agent,
  role,
}) {
  const context = await resolveAgentProfileContext({
    config,
    agentId,
    agent,
    role,
  });
  const profile = await syncAgentWorkspaceProfile(agentId, {
    role: context.role,
    effectiveSkills: context.effectiveSkills,
  });
  return {
    ...context,
    profile,
  };
}

export async function writeExistingAgentCardProfile({
  config,
  agentId,
  agent,
  role = null,
  name = undefined,
  description = undefined,
  capabilitiesPatch = undefined,
  constraintsPatch = undefined,
}) {
  const context = await resolveAgentProfileContext({
    config,
    agentId,
    agent,
    role,
  });
  const profile = await writeAgentCardProfile(agentId, {
    role: context.role,
    effectiveSkills: context.effectiveSkills,
    name,
    description,
    capabilitiesPatch,
    constraintsPatch,
  });
  return {
    ...context,
    profile,
    baseCard: buildAgentProfileBaseCard({
      agentId,
      role: context.role,
    }),
    baseCapabilities: buildAgentProfileBaseCapabilities({
      role: context.role,
      effectiveSkills: context.effectiveSkills,
    }),
  };
}
