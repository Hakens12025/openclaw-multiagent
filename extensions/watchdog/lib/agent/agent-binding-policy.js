import {
  buildRoleInjectedSemanticSkillMap,
  listAutoInjectedAgentSkillRefs,
  listForcedPlatformSkillRefs,
  listReservedConfiguredDefaultSkillIds,
} from "../semantic-skill-registry.js";
import { uniqueStrings } from "../core/normalize.js";

const RESERVED_CONFIGURED_DEFAULT_SKILL_IDS = new Set(listReservedConfiguredDefaultSkillIds());
const ROLE_INJECTED_SEMANTIC_SKILL_MAP = Object.freeze(buildRoleInjectedSemanticSkillMap());

export function getConfiguredDefaultSkillRefs(config) {
  return uniqueStrings(config?.agents?.defaults?.skills || []);
}

export function getForcedPlatformSkillRefs() {
  return listForcedPlatformSkillRefs();
}

export function getReservedConfiguredDefaultSkillIds() {
  return [...RESERVED_CONFIGURED_DEFAULT_SKILL_IDS];
}

export function getSystemActionEnabledRoles() {
  return [...(ROLE_INJECTED_SEMANTIC_SKILL_MAP["system-action"] || [])];
}

export function getRoleInjectedDefaultSkillMap() {
  return Object.fromEntries(
    Object.entries(ROLE_INJECTED_SEMANTIC_SKILL_MAP)
      .map(([skillId, roles]) => [skillId, [...roles]]),
  );
}

export function splitConfiguredDefaultSkillRefs(skills) {
  const configured = [];
  const ignored = [];
  for (const skillId of uniqueStrings(skills || [])) {
    if (RESERVED_CONFIGURED_DEFAULT_SKILL_IDS.has(skillId)) {
      ignored.push(skillId);
      continue;
    }
    configured.push(skillId);
  }
  return { configured, ignored };
}

export function composeDefaultSkillRefs(config, role) {
  return uniqueStrings([
    ...getConfiguredDefaultSkillRefs(config),
    ...listAutoInjectedAgentSkillRefs(role),
  ]);
}

export function composeEffectiveSkillRefs({
  config,
  role,
  configuredSkills = [],
} = {}) {
  return uniqueStrings([
    ...composeDefaultSkillRefs(config, role),
    ...uniqueStrings(configuredSkills),
  ]);
}
