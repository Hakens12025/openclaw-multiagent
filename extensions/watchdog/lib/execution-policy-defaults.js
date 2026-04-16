// lib/execution-policy-defaults.js — executionPolicy defaults by role
//
// Role-based defaults are a transitional bridge. Long-term, each agent
// should have an explicit executionPolicy in its binding.  When most agents
// carry their own config, role defaults can be shrunk or removed.

import { AGENT_ROLE } from "./agent/agent-metadata.js";

// DRAFT lifecycle eliminated: ingress creates PENDING directly, dispatch-graph-policy handles dispatch.
// planRequired/draftLifecycle/autoPromoteTimeout removed (plan-dispatch-service deleted).
const EXECUTION_POLICY_DEFAULTS = Object.freeze({});

export function getDefaultExecutionPolicy(role) {
  if (!role) return null;
  return EXECUTION_POLICY_DEFAULTS[role] || null;
}

export function mergeExecutionPolicy(defaults, configured) {
  if (!defaults && !configured) return null;
  if (!defaults) return { ...configured };
  if (!configured) return { ...defaults };

  const merged = { ...defaults };
  for (const [key, value] of Object.entries(configured)) {
    if (value !== null && value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}
