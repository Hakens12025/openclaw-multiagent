// system-action-role-policy.js — role-facing query surface over the single
// collaboration-intent source of truth (collaboration-intent-policy.js).
// A single semantic skill id (`system-action`) is kept; role subsets are
// projected from this policy, not implemented by splitting skill ids.
//
// Canonical action matrix (derived — edit collaboration-intent-policy.js):
//   bridge     : assign_task
//   planner    : assign_task
//   executor   : (none)
//   researcher : (none)
//   agent      : assign_task, wake_agent

import { deriveRoleActionMatrix, listExposedToolIntents } from "./collaboration-intent-policy.js";

export const SYSTEM_ACTION_TYPES = Object.freeze({
  ASSIGN_TASK: "assign_task",
  WAKE_AGENT: "wake_agent",
});

const ROLE_ACTION_MATRIX = deriveRoleActionMatrix();

function normalizeRole(role) {
  return typeof role === "string" ? role.trim().toLowerCase() : "";
}

function normalizeActionType(actionType) {
  return typeof actionType === "string" ? actionType.trim().toLowerCase() : "";
}

export function listAllowedActionTypesForRole(role) {
  const normalized = normalizeRole(role);
  const actions = ROLE_ACTION_MATRIX[normalized];
  return Array.isArray(actions) ? [...actions] : [];
}

export function isActionAllowedForRole(role, actionType) {
  const allowed = ROLE_ACTION_MATRIX[normalizeRole(role)];
  if (!Array.isArray(allowed)) return false;
  return allowed.includes(normalizeActionType(actionType));
}

// P4:before_tool_call 的角色工具白名单与协作工具面的并集判定——
// 该工具是暴露的协作 FC 且该角色被授权 → 白名单放行(授权单源赢)。
export function isExposedCollabToolForRole(role, toolName) {
  return listExposedToolIntents().includes(toolName) && isActionAllowedForRole(role, toolName);
}

export function resolveDisallowedActionReason(role, actionType) {
  const normalizedRole = normalizeRole(role);
  const normalizedActionType = normalizeActionType(actionType);
  if (!ROLE_ACTION_MATRIX[normalizedRole]) {
    return `role not registered in system-action policy: ${normalizedRole || "<empty>"}`;
  }
  const allowed = ROLE_ACTION_MATRIX[normalizedRole];
  return `action ${normalizedActionType || "<empty>"} not allowed for role ${normalizedRole} (allowed: ${allowed.join(", ") || "<none>"})`;
}

