// lib/security/execution-policy-defaults.js — executionPolicy defaults by role.
// maxToolCalls is the formal tool-budget truth; the bare MAX_TOOL_CALLS
// constant previously used as a compat fallback has been retired.

// FIX(A5-per-role-budget): role->budget map needs the AGENT_ROLE enum; agent-
// metadata.js is a leaf module (zero imports) so importing it forms no cycle.
import { AGENT_ROLE } from "../agent/agent-metadata.js";

export const DEFAULT_MAX_TOOL_CALLS = 50;
// FIX(A4-output-length-stop): cumulative tool-output had no byte budget -> add a 20MB default mirroring maxToolCalls.
export const DEFAULT_MAX_OUTPUT_BYTES = 20_000_000;

// Single default-floor policy: the generic "agent" tier AND the unknown-role
// floor both resolve to this one frozen object (one identity = one truth).
const DEFAULT_POLICY = Object.freeze({ maxToolCalls: DEFAULT_MAX_TOOL_CALLS });

// FIX(A5-per-role-budget): getDefaultExecutionPolicy returned the SAME 50 for
// every role despite the role-shaped API -> map each role to a tier budget.
// Tiers (monotone bridge < planner < agent < executor/researcher):
//   bridge     15  hook-locked forwarder (controller / qq-bridge): read inbox,
//                  relay to outbox — a handful of tool calls suffices.
//   planner    30  read-mostly: decomposes work into a contract, little I/O.
//   executor   80  does the work: edits, runs, iterates — needs headroom.
//   researcher 80  investigation-heavy: many searches/reads/fetches.
//   agent      —   generic role: shares DEFAULT_POLICY (the floor).
// A configured executionPolicy.maxToolCalls still overrides (mergeExecutionPolicy).
const ROLE_POLICY = Object.freeze({
  [AGENT_ROLE.BRIDGE]: Object.freeze({ maxToolCalls: 15 }),
  [AGENT_ROLE.PLANNER]: Object.freeze({ maxToolCalls: 30 }),
  [AGENT_ROLE.EXECUTOR]: Object.freeze({ maxToolCalls: 80 }),
  [AGENT_ROLE.RESEARCHER]: Object.freeze({ maxToolCalls: 80 }),
  [AGENT_ROLE.AGENT]: DEFAULT_POLICY,
});

export function getDefaultExecutionPolicy(role) {
  // FIX(A5-per-role-budget): falsy role -> null (unchanged contract); known role
  // -> its tier; truthy-but-unknown role -> DEFAULT_POLICY floor.
  // Object.hasOwn guards against prototype-member role names ("constructor",
  // "__proto__") leaking Object/Object.prototype instead of the floor (review A5).
  if (!role) return null;
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  return Object.hasOwn(ROLE_POLICY, normalized) ? ROLE_POLICY[normalized] : DEFAULT_POLICY;
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

// FIX(A3-write-size-cap): before_tool_call never bounded write byte size (disk_full only
// recorded post-hoc in error-ledger) -> declare a configurable ceiling. ~5MB clears legit
// large text/data files while blocking runaway or binary-dump writes.
export const DEFAULT_MAX_WRITE_BYTES = 5_000_000;

// FIX(A3-write-size-cap): twin of resolveMaxToolCallsFromPolicy; per-binding
// executionPolicy.maxWriteBytes overrides, else the safe default.
export function resolveMaxWriteBytesFromPolicy(executionPolicy) {
  const configured = Number(executionPolicy?.maxWriteBytes);
  if (Number.isFinite(configured) && configured > 0) return Math.trunc(configured);
  return DEFAULT_MAX_WRITE_BYTES;
}

// FIX(A4-output-length-stop): resolve the per-session output-byte budget, mirroring maxToolCalls resolution (positive policy override wins, else default).
export function resolveMaxOutputBytesFromPolicy(executionPolicy) {
  const configured = Number(executionPolicy?.maxOutputBytes);
  if (Number.isFinite(configured) && configured > 0) return Math.trunc(configured);
  return DEFAULT_MAX_OUTPUT_BYTES;
}
