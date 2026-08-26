export const AGENT_IDS = Object.freeze({
  CONTROLLER: "controller",
  OPERATOR: "operator",
  VIZ_MASTER: "viz-master",
  PLANNER: "planner",
  RESEARCHER: "researcher",
  WORKER_D: "worker-d",
});

export const AGENT_ROLE = Object.freeze({
  BRIDGE: "bridge",
  PLANNER: "planner",
  EXECUTOR: "executor",
  RESEARCHER: "researcher",
  AGENT: "agent",
});

export const AGENT_WORKSPACE_OVERRIDES = Object.freeze({
  [AGENT_IDS.CONTROLLER]: "workspaces/controller",
  [AGENT_IDS.OPERATOR]: "workspaces/operator",
  [AGENT_IDS.VIZ_MASTER]: "workspaces/viz-master",
});

// 单前台(备忘录156 §三方向B):controller 是唯一 bridge/gateway。
export const BRIDGE_AGENT_IDS = new Set([
  AGENT_IDS.CONTROLLER,
]);

export const GATEWAY_AGENT_IDS = new Set([
  AGENT_IDS.CONTROLLER,
]);

// Meta-agents own a control-plane surface family (operator owns "*",
// viz-master owns "chart"). A meta-agent is the SOLE WRITER of its surface
// family; both are runtime/protected agents with their own agent block and an
// entry in META_AGENT_SURFACE_OWNERSHIP.
export const META_AGENT_IDS = Object.freeze(new Set([AGENT_IDS.OPERATOR, AGENT_IDS.VIZ_MASTER]));

export const PROTECTED_AGENT_IDS = new Set([
  ...META_AGENT_IDS,
  AGENT_IDS.CONTROLLER,
  AGENT_IDS.PLANNER,
]);

export const SUPPORTED_AGENT_ROLES = new Set([
  AGENT_ROLE.BRIDGE,
  AGENT_ROLE.PLANNER,
  AGENT_ROLE.EXECUTOR,
  AGENT_ROLE.RESEARCHER,
  AGENT_ROLE.AGENT,
]);

// Roles that can emit [ACTION] markers at all. The per-action allowlist lives
// in lib/system-action/system-action-role-policy.js; this set is the coarser
// "is this role wired for system-action?" predicate used by semantic-skill-
// registry when injecting the skill. Order doesn't matter.
export const SYSTEM_ACTION_ENABLED_ROLES = new Set([
  AGENT_ROLE.BRIDGE,
  AGENT_ROLE.AGENT,
  AGENT_ROLE.PLANNER,
  AGENT_ROLE.EXECUTOR,
  AGENT_ROLE.RESEARCHER,
]);

export function isSupportedAgentRole(role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  return SUPPORTED_AGENT_ROLES.has(normalized);
}

export function isSystemActionEnabledRole(role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  return SYSTEM_ACTION_ENABLED_ROLES.has(normalized);
}
