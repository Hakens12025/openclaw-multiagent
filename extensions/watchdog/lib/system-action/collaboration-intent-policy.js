// collaboration-intent-policy.js — single source of truth for collaboration
// intents (spec §5 / P2): one row per intent unifies the intent vocabulary,
// role authorization, runtime-handler expectation, and v1 tool-face exposure.
// system-action-role-policy.js derives its role matrix from this table.

import { AGENT_ROLE } from "../agent/agent-metadata.js";
import { INTENT_TYPES } from "../protocol/protocol-primitives.js";

const { BRIDGE, PLANNER, AGENT } = AGENT_ROLE;

export const COLLABORATION_INTENT_POLICY = Object.freeze([
  Object.freeze({
    intent: INTENT_TYPES.ASSIGN_TASK,
    roles: Object.freeze([BRIDGE, PLANNER, AGENT]),
    exposedAsTool: true,
    runtimeHandler: true,
  }),
  Object.freeze({
    intent: INTENT_TYPES.WAKE_AGENT,
    roles: Object.freeze([AGENT]),
    exposedAsTool: true,
    runtimeHandler: true,
  }),
  // Deferred build (spec §5): no role may issue create_task yet; the intent
  // stays in the vocabulary so the L3 text channel keeps parsing it as
  // known-but-denied instead of unknown.
  Object.freeze({
    intent: INTENT_TYPES.CREATE_TASK,
    roles: Object.freeze([]),
    exposedAsTool: false,
    runtimeHandler: true,
  }),
]);

export function listExposedToolIntents() {
  return COLLABORATION_INTENT_POLICY
    .filter((row) => row.exposedAsTool)
    .map((row) => row.intent);
}

export function listRolesForIntent(intentType) {
  const row = COLLABORATION_INTENT_POLICY.find((entry) => entry.intent === intentType);
  return row ? [...row.roles] : [];
}

export function deriveRoleActionMatrix() {
  const matrix = {};
  for (const role of Object.values(AGENT_ROLE)) {
    matrix[role] = Object.freeze(
      COLLABORATION_INTENT_POLICY
        .filter((row) => row.roles.includes(role))
        .map((row) => row.intent),
    );
  }
  return Object.freeze(matrix);
}
