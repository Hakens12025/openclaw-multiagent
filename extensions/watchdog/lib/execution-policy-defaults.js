// lib/execution-policy-defaults.js — executionPolicy defaults by role.
// maxToolCalls is the formal tool-budget truth; the bare MAX_TOOL_CALLS
// constant previously used as a compat fallback has been retired.

export const DEFAULT_MAX_TOOL_CALLS = 50;

const DEFAULT_POLICY = Object.freeze({ maxToolCalls: DEFAULT_MAX_TOOL_CALLS });

export function getDefaultExecutionPolicy(role) {
  if (!role) return null;
  return DEFAULT_POLICY;
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

export function resolveMaxToolCallsFromPolicy(executionPolicy) {
  const configured = Number(executionPolicy?.maxToolCalls);
  if (Number.isFinite(configured) && configured > 0) return Math.trunc(configured);
  return DEFAULT_MAX_TOOL_CALLS;
}
