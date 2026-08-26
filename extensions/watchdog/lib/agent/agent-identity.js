import { runtimeAgentConfigs } from "../state.js";
import { getAgentCard, listAgentCards } from "../store/agent-card-store.js";
import { normalizeString, uniqueStrings } from "../core/normalize.js";
import { composeAgentBinding, composeEffectiveProfile } from "../effective-profile-composer.js";
import { buildAgentMainSessionKey } from "../session/session-keys.js";
import { resolveActorPlanePolicy } from "./agent-plane-policy.js";
import {
  AGENT_IDS,
  AGENT_ROLE,
  PROTECTED_AGENT_IDS,
  SUPPORTED_AGENT_ROLES,
  SYSTEM_ACTION_ENABLED_ROLES,
  isSupportedAgentRole,
  isSystemActionEnabledRole,
} from "./agent-metadata.js";

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
      registered: false,
      registeredSource: "none",
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

  const configured = getRuntimeAgentConfig(normalizedAgentId);
  const card = getAgentCard(normalizedAgentId);
  const registered = Boolean(configured || card);
  const registeredSource = configured ? "config" : (card ? "card" : "none");
  const configuredRole = getConfiguredRole(normalizedAgentId);
  const cardRole = normalizeString(card?.role)?.toLowerCase() || null;
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
  const configuredPlane = normalizeString(configured?.plane)?.toLowerCase() || null;
  const configuredMainViewVisible = typeof configured?.mainViewVisible === "boolean"
    ? configured.mainViewVisible
    : null;
  const configuredFormalTimelineVisible = typeof configured?.formalTimelineVisible === "boolean"
    ? configured.formalTimelineVisible
    : null;
  const configuredAutoWakeEligible = typeof configured?.autoWakeEligible === "boolean"
    ? configured.autoWakeEligible
    : null;

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

  const actorPolicy = resolveActorPlanePolicy({
    agentId: normalizedAgentId,
    configuredPlane,
    configuredMainViewVisible,
    configuredFormalTimelineVisible,
    configuredAutoWakeEligible,
    role,
    gateway,
    ingressSource,
  });

  return {
    agentId: normalizedAgentId,
    registered,
    registeredSource,
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
    plane: actorPolicy.plane,
    mainViewVisible: actorPolicy.mainViewVisible,
    formalTimelineVisible: actorPolicy.formalTimelineVisible,
    autoWakeEligible: actorPolicy.autoWakeEligible,
  };
}

export function getAgentRole(agentId) {
  return getAgentIdentitySnapshot(agentId).role;
}

// Returns the configured skill list for an agent from runtimeAgentConfigs.
// Returns an empty array when the agent is not registered or has no skills.
export function getAgentConfiguredSkills(agentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) return [];
  const skills = runtimeAgentConfigs.get(normalizedAgentId)?.skills;
  return Array.isArray(skills) ? [...skills] : [];
}

export function isGatewayAgent(agentId) {
  return getAgentIdentitySnapshot(agentId).gateway === true;
}

export function isResearcherAgent(agentId) {
  return getAgentRole(agentId) === AGENT_ROLE.RESEARCHER;
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

// per-agent constraints 运行时子集：只取数值型 timeoutSeconds/maxRetry（agent-timeout-sweep 消费）。
// card 优先（changeAgentConstraints 写进 card profile），回退 list 条目；无有效值返回 null。
function resolveRuntimeConstraints(card, agentConfig) {
  const src = (card?.constraints && typeof card.constraints === "object")
    ? card.constraints
    : (agentConfig?.constraints && typeof agentConfig.constraints === "object" ? agentConfig.constraints : null);
  if (!src) return null;
  const out = {};
  if (Number.isFinite(Number(src.timeoutSeconds))) out.timeoutSeconds = Number(src.timeoutSeconds);
  if (Number.isFinite(Number(src.maxRetry))) out.maxRetry = Number(src.maxRetry);
  return Object.keys(out).length > 0 ? out : null;
}

export function registerRuntimeAgents(config) {
  runtimeAgentConfigs.clear();
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  for (const agent of agents) {
    const agentId = normalizeString(agent?.id);
    const card = agentId ? getAgentCard(agentId) : null;
    const composedBinding = composeAgentBinding({
      config,
      agentConfig: agent,
      card,
      role: null,
    });
    const normalizedAgentId = normalizeString(composedBinding.agentId) || agentId;
    if (!normalizedAgentId) continue;
    const effectiveProfile = composeEffectiveProfile({
      config,
      agentConfig: agent,
      card,
    });
    const effectiveCapabilities = effectiveProfile?.capabilities && typeof effectiveProfile.capabilities === "object"
      ? { ...effectiveProfile.capabilities }
      : null;
    const role = normalizeString(composedBinding.roleRef)?.toLowerCase() || null;
    runtimeAgentConfigs.set(normalizedAgentId, {
      id: normalizedAgentId,
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
      plane: effectiveProfile?.plane || null,
      mainViewVisible: effectiveProfile?.mainViewVisible !== false,
      formalTimelineVisible: effectiveProfile?.formalTimelineVisible !== false,
      autoWakeEligible: effectiveProfile?.autoWakeEligible !== false,
      capabilities: effectiveCapabilities,
      skills: uniqueStrings(composedBinding.skills?.configured || []),
      effectiveExecutionPolicy: composedBinding.policies?.effectiveExecutionPolicy || null,
      // P6-Phase0: 通用 binding policy 运行时快照（无消费者也保留，供 Phase1 接入）。
      outputPolicy: composedBinding.policies?.outputPolicy || null,
      inboxPolicy: composedBinding.policies?.inboxPolicy || null,
      // per-agent constraints 运行时快照：agent-timeout-sweep 读 timeoutSeconds/maxRetry，
      // 免去每次巡检读 agent card 文件 I/O。来源优先 card，回退 list 条目。
      constraints: resolveRuntimeConstraints(card, agent),
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

// P6-Phase0: 通用 binding policy 读取 helper（与 getExecutionPolicy 对称）。
// Phase1 用它替代 contractor 硬编码（collectContractorOutbox / routeContractorInbox）。
export function getOutputPolicy(agentId) {
  const normalizedAgentId = normalizeString(agentId);
  return normalizedAgentId
    ? runtimeAgentConfigs.get(normalizedAgentId)?.outputPolicy || null
    : null;
}

export function getInboxPolicy(agentId) {
  const normalizedAgentId = normalizeString(agentId);
  return normalizedAgentId
    ? runtimeAgentConfigs.get(normalizedAgentId)?.inboxPolicy || null
    : null;
}

// P6-Phase1: 把"该 agent 能否当 reviewer rework 目标"从 role 特化迁到 policy。
// outputPolicy.canReceiveRework 缺省时由 role 默认推导：specialized-executor 或
// researcher 默认可接 rework（与迁移前 isSpecializedExecutor||isResearcherAgent 等价）。
export function canAgentReceiveRework(agentId) {
  const policy = getOutputPolicy(agentId);
  if (policy != null && typeof policy.canReceiveRework === "boolean") {
    return policy.canReceiveRework;
  }
  return isSpecializedExecutor(agentId) || isResearcherAgent(agentId);
}

// P6-Phase1: heartbeat actionable-work 判定从 role 特化迁到 policy。
// requiresContract 缺省：executor / researcher 默认 true（迁移前两个 role 分支都要 contract）。
// dedupeConcurrentTracker 缺省：executor 默认 true（迁移前只有 executor 分支去重并发 tracker）。
// 其它 role 缺省 false（保持迁移前的 permissive 落到通用分支）。
export function agentRequiresContractForHeartbeat(agentId) {
  const policy = getInboxPolicy(agentId);
  if (policy != null && typeof policy.requiresContract === "boolean") {
    return policy.requiresContract;
  }
  const role = getAgentRole(agentId);
  return role === AGENT_ROLE.EXECUTOR || role === AGENT_ROLE.RESEARCHER;
}

export function agentDedupesConcurrentTrackerForHeartbeat(agentId) {
  const policy = getInboxPolicy(agentId);
  if (policy != null && typeof policy.dedupeConcurrentTracker === "boolean") {
    return policy.dedupeConcurrentTracker;
  }
  return getAgentRole(agentId) === AGENT_ROLE.EXECUTOR;
}

// P6-Phase1: 直接 intake 准入从 role 特化迁到 policy。
// executionPolicy.noDirectIntake 显式 true → 拒收直发；缺省时 researcher 默认拒收
// （迁移前 ingress 硬路径用 `role !== RESEARCHER` 排除，等价行为，无需改配置）。
export function agentBlocksDirectIntake(agentId) {
  if (hasExecutionPolicy(agentId, "noDirectIntake")) {
    return true;
  }
  return getAgentRole(agentId) === AGENT_ROLE.RESEARCHER;
}

export function hasInboxPolicy(agentId, key) {
  const policy = getInboxPolicy(agentId);
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
