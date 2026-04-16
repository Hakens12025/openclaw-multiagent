export const AGENT_IDS = Object.freeze({
  CONTROLLER: "controller",
  QQ_BRIDGE: "agent-for-kksl",
  PLANNER: "planner",
  RESEARCHER: "researcher",
  REVIEWER: "reviewer",
  WORKER_D: "worker-d",
});

export const AGENT_ROLE = Object.freeze({
  BRIDGE: "bridge",
  PLANNER: "planner",
  EXECUTOR: "executor",
  RESEARCHER: "researcher",
  REVIEWER: "reviewer",
  AGENT: "agent",
});

export const ROLE_FALLBACK_IDS = Object.freeze({
  [AGENT_ROLE.PLANNER]: Object.freeze([AGENT_IDS.PLANNER]),
  [AGENT_ROLE.RESEARCHER]: Object.freeze([AGENT_IDS.RESEARCHER]),
  [AGENT_ROLE.REVIEWER]: Object.freeze([AGENT_IDS.REVIEWER]),
});

export const SPECIALIZED_EXECUTOR_FALLBACK_IDS = Object.freeze([
  AGENT_IDS.WORKER_D,
]);

export const AGENT_WORKSPACE_OVERRIDES = Object.freeze({
  [AGENT_IDS.CONTROLLER]: "workspaces/controller",
  [AGENT_IDS.QQ_BRIDGE]: "workspaces/kksl",
});

export const BRIDGE_AGENT_IDS = new Set([
  AGENT_IDS.CONTROLLER,
  AGENT_IDS.QQ_BRIDGE,
]);

export const GATEWAY_AGENT_IDS = new Set([
  AGENT_IDS.CONTROLLER,
  AGENT_IDS.QQ_BRIDGE,
]);

export const QQ_INGRESS_AGENT_IDS = new Set([
  AGENT_IDS.QQ_BRIDGE,
]);

export const PROTECTED_AGENT_IDS = new Set([
  AGENT_IDS.CONTROLLER,
  AGENT_IDS.QQ_BRIDGE,
  AGENT_IDS.PLANNER,
]);

export const SUPPORTED_AGENT_ROLES = new Set([
  AGENT_ROLE.BRIDGE,
  AGENT_ROLE.PLANNER,
  AGENT_ROLE.EXECUTOR,
  AGENT_ROLE.RESEARCHER,
  AGENT_ROLE.REVIEWER,
  AGENT_ROLE.AGENT,
]);

export const SYSTEM_ACTION_ENABLED_ROLES = new Set([
  AGENT_ROLE.AGENT,
  AGENT_ROLE.PLANNER,
  AGENT_ROLE.EXECUTOR,
  AGENT_ROLE.RESEARCHER,
  AGENT_ROLE.REVIEWER,
]);

export function isProtectedAgentId(agentId) {
  return PROTECTED_AGENT_IDS.has(agentId);
}

export function isSupportedAgentRole(role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  return SUPPORTED_AGENT_ROLES.has(normalized);
}

export function isSystemActionEnabledRole(role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  return SYSTEM_ACTION_ENABLED_ROLES.has(normalized);
}
