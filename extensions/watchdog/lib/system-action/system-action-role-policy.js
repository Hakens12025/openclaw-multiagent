// system-action-role-policy.js — single runtime source of truth for allowed
// system-action action types per role. A single semantic skill id
// (`system-action`) is kept; role subsets are projected from this policy,
// not implemented by splitting skill ids.
//
// Canonical action matrix:
//   bridge     : assign_task
//   planner    : assign_task, request_review, advance_loop
//   executor   : request_review
//   researcher : request_review
//   reviewer   : request_review, advance_loop
//   agent      : assign_task, request_review, wake_agent, start_loop, advance_loop

import { AGENT_ROLE } from "../agent/agent-metadata.js";

export const SYSTEM_ACTION_TYPES = Object.freeze({
  ASSIGN_TASK: "assign_task",
  REQUEST_REVIEW: "request_review",
  WAKE_AGENT: "wake_agent",
  START_LOOP: "start_loop",
  ADVANCE_LOOP: "advance_loop",
});

const ROLE_ACTION_MATRIX = Object.freeze({
  [AGENT_ROLE.BRIDGE]: Object.freeze([
    SYSTEM_ACTION_TYPES.ASSIGN_TASK,
  ]),
  [AGENT_ROLE.PLANNER]: Object.freeze([
    SYSTEM_ACTION_TYPES.ASSIGN_TASK,
    SYSTEM_ACTION_TYPES.REQUEST_REVIEW,
    SYSTEM_ACTION_TYPES.ADVANCE_LOOP,
  ]),
  [AGENT_ROLE.EXECUTOR]: Object.freeze([
    SYSTEM_ACTION_TYPES.REQUEST_REVIEW,
  ]),
  [AGENT_ROLE.RESEARCHER]: Object.freeze([
    SYSTEM_ACTION_TYPES.REQUEST_REVIEW,
  ]),
  [AGENT_ROLE.REVIEWER]: Object.freeze([
    SYSTEM_ACTION_TYPES.REQUEST_REVIEW,
    SYSTEM_ACTION_TYPES.ADVANCE_LOOP,
  ]),
  [AGENT_ROLE.AGENT]: Object.freeze([
    SYSTEM_ACTION_TYPES.ASSIGN_TASK,
    SYSTEM_ACTION_TYPES.REQUEST_REVIEW,
    SYSTEM_ACTION_TYPES.WAKE_AGENT,
    SYSTEM_ACTION_TYPES.START_LOOP,
    SYSTEM_ACTION_TYPES.ADVANCE_LOOP,
  ]),
});

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

export function resolveDisallowedActionReason(role, actionType) {
  const normalizedRole = normalizeRole(role);
  const normalizedActionType = normalizeActionType(actionType);
  if (!ROLE_ACTION_MATRIX[normalizedRole]) {
    return `role not registered in system-action policy: ${normalizedRole || "<empty>"}`;
  }
  const allowed = ROLE_ACTION_MATRIX[normalizedRole];
  return `action ${normalizedActionType || "<empty>"} not allowed for role ${normalizedRole} (allowed: ${allowed.join(", ") || "<none>"})`;
}

export const SYSTEM_ACTION_ROLE_POLICY = Object.freeze({
  matrix: ROLE_ACTION_MATRIX,
  listAllowedActionTypesForRole,
  isActionAllowedForRole,
  resolveDisallowedActionReason,
});
