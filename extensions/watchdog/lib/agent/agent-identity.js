import { runtimeAgentConfigs } from "../state.js";
import { getAgentCard, listAgentCards } from "../store/agent-card-store.js";
import { normalizeString, uniqueStrings } from "../core/normalize.js";
import { composeAgentBinding } from "../effective-profile-composer.js";
import { buildAgentMainSessionKey } from "../session-keys.js";
import {
  AGENT_IDS,
  AGENT_ROLE,
  PROTECTED_AGENT_IDS,
  SUPPORTED_AGENT_ROLES,
  SYSTEM_ACTION_ENABLED_ROLES,
  isSupportedAgentRole,
  isSystemActionEnabledRole,
} from "./agent-metadata.js";

let runtimePlannerDispatchOrigin = null;
let runtimeAgentConfigVersion = 0;

export {
  AGENT_IDS,
  AGENT_ROLE,
  PROTECTED_AGENT_IDS,
  SUPPORTED_AGENT_ROLES,
  SYSTEM_ACTION_ENABLED_ROLES,
  isSupportedAgentRole,
  isSystemActionEnabledRole,
} from "./agent-metadata.js";

export function getRuntimeAgentConfig(agentId) {
  const normalizedAgentId = normalizeString(agentId);
  return normalizedAgentId ? runtimeAgentConfigs.get(normalizedAgentId) || null : null;
}

function getConfiguredIngressSource(agentId) {
  return normalizeString(getRuntimeAgentConfig(agentId)?.ingressSource)?.toLowerCase() || null;
}

function getConfiguredRole(agentId) {
  return normalizeString(getRuntimeAgentConfig(agentId)?.role)?.toLowerCase() || null;
}

function getCardRole(agentId) {
  return normalizeString(getAgentCard(agentId)?.role)?.toLowerCase() || null;
}

function getConfiguredBooleanFlag(agentId, key) {
  const value = getRuntimeAgentConfig(agentId)?.[key];
  return typeof value === "boolean" ? value : null;
}

export function isBridgeAgent(agentId) {
  return getAgentRole(agentId) === AGENT_ROLE.BRIDGE;
}

export function normalizeAgentRole(role, agentId) {
  void agentId;
  const explicitRole = normalizeString(role)?.toLowerCase();
  if (explicitRole) return explicitRole;
  return AGENT_ROLE.AGENT;
}

export function getAgentIdentitySnapshot(agentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    return {
      agentId: null,
      role: AGENT_ROLE.AGENT,
      roleSource: "default",
      gateway: false,
      gatewaySource: "default",
      ingressSource: null,
      ingressSourceSource: "default",
      specialized: false,
      specializedSource: "default",
      protected: false,
      protectedSource: "default",
    };
  }

  const configuredRole = getConfiguredRole(normalizedAgentId);
  const cardRole = getCardRole(normalizedAgentId);
  let role = AGENT_ROLE.AGENT;
  let roleSource = "default";
  if (configuredRole) {
    role = normalizeAgentRole(configuredRole, normalizedAgentId);
    roleSource = "config";
  } else if (cardRole) {
    role = normalizeAgentRole(cardRole, normalizedAgentId);
    roleSource = "card";
  }

  const configuredGateway = getConfiguredBooleanFlag(normalizedAgentId, "gateway");
  let gateway = false;
  let gatewaySource = "default";
  if (configuredGateway !== null) {
    gateway = configuredGateway;
    gatewaySource = "config";
  }

  const configuredSource = getConfiguredIngressSource(normalizedAgentId);
  let ingressSource = null;
  let ingressSourceSource = "default";
  if (configuredSource) {
    ingressSource = configuredSource;
    ingressSourceSource = "config";
  }

  const configuredSpecialized = getConfiguredBooleanFlag(normalizedAgentId, "specialized");
  let specialized = false;
  let specializedSource = "default";
  if (role === AGENT_ROLE.EXECUTOR) {
    if (configuredSpecialized !== null) {
      specialized = configuredSpecialized;
      specializedSource = "config";
    }
  }

  const configuredProtected = getConfiguredBooleanFlag(normalizedAgentId, "protected");
  let protectedAgent = false;
  let protectedSource = "default";
  if (configuredProtected !== null) {
    protectedAgent = configuredProtected;
    protectedSource = "config";
  }

  return {
    agentId: normalizedAgentId,
    role,
    roleSource,
    gateway,
    gatewaySource,
    ingressSource,
    ingressSourceSource,
    specialized,
    specializedSource,
    protected: protectedAgent,
    protectedSource,
  };
}

export function getAgentRole(agentId) {
  return getAgentIdentitySnapshot(agentId).role;
}

export function isGatewayAgent(agentId) {
  return getAgentIdentitySnapshot(agentId).gateway === true;
}

export function isResearcherAgent(agentId) {
  return getAgentRole(agentId) === AGENT_ROLE.RESEARCHER;
}

export function isExecutorAgent(agentId) {
  return getAgentRole(agentId) === AGENT_ROLE.EXECUTOR;
}

function pushUniqueAgentId(list, agentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId || list.includes(normalizedAgentId)) return;
  list.push(normalizedAgentId);
}

function listRoleCandidates(role) {
  const normalizedRole = normalizeString(role)?.toLowerCase();
  if (!normalizedRole) return [];

  const candidates = [];
  for (const [agentId] of runtimeAgentConfigs.entries()) {
    const snapshot = getAgentIdentitySnapshot(agentId);
    if (snapshot.role !== normalizedRole) continue;
    pushUniqueAgentId(candidates, agentId);
  }

  for (const [agentId] of listAgentCards()) {
    const snapshot = getAgentIdentitySnapshot(agentId);
    if (snapshot.role !== normalizedRole) continue;
    pushUniqueAgentId(candidates, agentId);
  }

  return candidates;
}

export function listAgentIdsByRole(role) {
  return listRoleCandidates(role);
}

export function listRuntimeAgentIds() {
  return [...runtimeAgentConfigs.keys()];
}

export function getPlanDispatchOrigin() {
  return runtimePlannerDispatchOrigin;
}

export function getRuntimeAgentConfigVersion() {
  return runtimeAgentConfigVersion;
}

export function listGatewayAgentIds() {
  const explicit = [];
  for (const [agentId] of runtimeAgentConfigs.entries()) {
    const snapshot = getAgentIdentitySnapshot(agentId);
    if (!snapshot.gateway) continue;
    pushUniqueAgentId(explicit, agentId);
  }
  return explicit;
}

export function resolveAgentIdByRole(role) {
  return listRoleCandidates(role)[0] || null;
}

export function resolvePreferredExecutorAgentId({
  specializedFirst = true,
} = {}) {
  if (specializedFirst) {
    const specializedAgentId = getSpecializedExecutorIds()[0] || null;
    if (specializedAgentId) {
      return specializedAgentId;
    }
  }
  return resolveAgentIdByRole(AGENT_ROLE.EXECUTOR);
}

function getSpecializedExecutorIds() {
  const explicit = [];
  for (const [agentId] of runtimeAgentConfigs.entries()) {
    const snapshot = getAgentIdentitySnapshot(agentId);
    if (snapshot.role !== AGENT_ROLE.EXECUTOR) continue;
    if (snapshot.specialized === true) {
      pushUniqueAgentId(explicit, agentId);
    }
  }
  return explicit;
}

export function isSpecializedExecutor(agentId) {
  const normalizedAgentId = normalizeString(agentId);
  return normalizedAgentId ? getSpecializedExecutorIds().includes(normalizedAgentId) : false;
}

export function isProtectedAgentId(agentId) {
  return getAgentIdentitySnapshot(agentId).protected === true;
}

export function registerRuntimeAgents(config) {
  runtimeAgentConfigs.clear();
  runtimePlannerDispatchOrigin = normalizeString(config?.agents?.dispatchOrigin)
    || normalizeString(config?.graph?.dispatchOrigin)
    || null;
  runtimeAgentConfigVersion += 1;
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  for (const agent of agents) {
    const composedBinding = composeAgentBinding({
      config,
      agentConfig: agent,
      card: null,
      role: null,
    });
    const agentId = normalizeString(composedBinding.agentId) || normalizeString(agent?.id);
    if (!agentId) continue;
    const configuredCapabilities = {};
    const routerHandlerId = normalizeString(composedBinding.capabilities?.configured?.routerHandlerId);
    const outboxCommitKinds = uniqueStrings(composedBinding.capabilities?.configured?.outboxCommitKinds || []);
    if (routerHandlerId) {
      configuredCapabilities.routerHandlerId = routerHandlerId;
    }
    if (outboxCommitKinds.length > 0) {
      configuredCapabilities.outboxCommitKinds = outboxCommitKinds;
    }
    const role = normalizeString(composedBinding.roleRef)?.toLowerCase() || null;
    runtimeAgentConfigs.set(agentId, {
      id: agentId,
      role,
      workspace: normalizeString(composedBinding.workspace?.configured) || null,
      specialized: typeof composedBinding.policies?.specialized === "boolean"
        ? composedBinding.policies.specialized
        : null,
      gateway: typeof composedBinding.policies?.gateway === "boolean"
        ? composedBinding.policies.gateway
        : null,
      protected: typeof composedBinding.policies?.protected === "boolean"
        ? composedBinding.policies.protected
        : null,
      ingressSource: normalizeString(composedBinding.policies?.ingressSource)?.toLowerCase() || null,
      capabilities: Object.keys(configuredCapabilities).length > 0 ? configuredCapabilities : null,
      skills: uniqueStrings(composedBinding.skills?.configured || []),
      effectiveExecutionPolicy: composedBinding.policies?.effectiveExecutionPolicy || null,
    });
  }
}

export function getExecutionPolicy(agentId) {
  const normalizedAgentId = normalizeString(agentId);
  return normalizedAgentId
    ? runtimeAgentConfigs.get(normalizedAgentId)?.effectiveExecutionPolicy || null
    : null;
}

export function hasExecutionPolicy(agentId, key) {
  const policy = getExecutionPolicy(agentId);
  return policy != null && policy[key] === true;
}

export function isQQIngressAgent(agentId) {
  return getAgentIdentitySnapshot(agentId).ingressSource === "qq";
}

export function resolveGatewayAgentIdForSource(source) {
  const normalizedSource = normalizeString(source)?.toLowerCase() || "webui";

  // Config-first: exact ingressSource match
  for (const [agentId] of runtimeAgentConfigs.entries()) {
    if (!isGatewayAgent(agentId)) continue;
    if (getConfiguredIngressSource(agentId) === normalizedSource) return agentId;
  }

  // Default source: find any gateway agent with no specific source or "webui"
  if (normalizedSource === "webui") {
    for (const [agentId] of runtimeAgentConfigs.entries()) {
      if (!isGatewayAgent(agentId)) continue;
      const src = getConfiguredIngressSource(agentId);
      if (!src || src === "webui") return agentId;
    }
  }

  return null;
}

export function buildGatewayReplyTarget(source = "webui") {
  const agentId = resolveGatewayAgentIdForSource(source);
  return agentId
    ? {
        agentId,
        sessionKey: buildAgentMainSessionKey(agentId),
      }
    : null;
}

export function resolveAgentIngressSource(agentId, fallbackSource = "webui") {
  const normalizedFallback = normalizeString(fallbackSource) || "webui";
  const snapshot = getAgentIdentitySnapshot(agentId);
  if (snapshot.ingressSource) {
    return snapshot.ingressSource;
  }
  return normalizedFallback;
}
