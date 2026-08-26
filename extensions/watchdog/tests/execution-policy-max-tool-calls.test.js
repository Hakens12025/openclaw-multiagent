import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_TOOL_CALLS,
  getDefaultExecutionPolicy,
  mergeExecutionPolicy,
  resolveMaxToolCallsFromPolicy,
} from "../lib/security/execution-policy-defaults.js";
import { AGENT_ROLE } from "../lib/agent/agent-metadata.js";

test("DEFAULT_MAX_TOOL_CALLS is the formal role-default budget", () => {
  assert.equal(DEFAULT_MAX_TOOL_CALLS, 50);
});

// FIX(A5-per-role-budget): budgets now differ per role; the old assertion
// (every role == DEFAULT_MAX_TOOL_CALLS) is broken by the per-role map. These
// expected values mirror ROLE_POLICY in lib/execution-policy-defaults.js and
// intentionally pin the tiers (a source tier change must fail this test).
const EXPECTED_ROLE_MAX_TOOL_CALLS = {
  [AGENT_ROLE.BRIDGE]: 15,
  [AGENT_ROLE.PLANNER]: 30,
  [AGENT_ROLE.EXECUTOR]: 80,
  [AGENT_ROLE.RESEARCHER]: 80,
  [AGENT_ROLE.AGENT]: DEFAULT_MAX_TOOL_CALLS,
};

test("every role's default policy exposes a positive-integer maxToolCalls", () => {
  for (const role of Object.values(AGENT_ROLE)) {
    const defaults = getDefaultExecutionPolicy(role);
    assert.ok(defaults, `role ${role} should have default policy`);
    assert.ok(
      Number.isInteger(defaults.maxToolCalls) && defaults.maxToolCalls > 0,
      `role ${role} maxToolCalls should be a positive integer`,
    );
  }
});

test("each known role maps to its per-role tier budget", () => {
  for (const [role, expected] of Object.entries(EXPECTED_ROLE_MAX_TOOL_CALLS)) {
    const defaults = getDefaultExecutionPolicy(role);
    assert.equal(defaults.maxToolCalls, expected, `role ${role} -> tier ${expected}`);
  }
});

test("unknown role floors to DEFAULT_MAX_TOOL_CALLS; falsy role stays null", () => {
  assert.equal(getDefaultExecutionPolicy("evaluator").maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
  assert.equal(getDefaultExecutionPolicy(null), null);
  assert.equal(getDefaultExecutionPolicy(""), null);
});

// FIX(A5-per-role-budget/review): prototype-member role names must floor to
// DEFAULT_POLICY, not leak Object / Object.prototype through the map lookup.
test("prototype-member role names still floor to DEFAULT_MAX_TOOL_CALLS", () => {
  for (const evil of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const defaults = getDefaultExecutionPolicy(evil);
    assert.equal(defaults.maxToolCalls, DEFAULT_MAX_TOOL_CALLS, `role ${evil} must floor`);
  }
});

test("resolveMaxToolCallsFromPolicy returns explicit policy value when positive integer", () => {
  assert.equal(resolveMaxToolCallsFromPolicy({ maxToolCalls: 12 }), 12);
  assert.equal(resolveMaxToolCallsFromPolicy({ maxToolCalls: 1 }), 1);
});

test("resolveMaxToolCallsFromPolicy falls back to default on null/invalid", () => {
  assert.equal(resolveMaxToolCallsFromPolicy(null), DEFAULT_MAX_TOOL_CALLS);
  assert.equal(resolveMaxToolCallsFromPolicy({}), DEFAULT_MAX_TOOL_CALLS);
  assert.equal(resolveMaxToolCallsFromPolicy({ maxToolCalls: 0 }), DEFAULT_MAX_TOOL_CALLS);
  assert.equal(resolveMaxToolCallsFromPolicy({ maxToolCalls: -5 }), DEFAULT_MAX_TOOL_CALLS);
  assert.equal(resolveMaxToolCallsFromPolicy({ maxToolCalls: "not-a-number" }), DEFAULT_MAX_TOOL_CALLS);
});

test("mergeExecutionPolicy overlays configured maxToolCalls over defaults", () => {
  const defaults = getDefaultExecutionPolicy(AGENT_ROLE.EXECUTOR);
  const configured = { maxToolCalls: 8 };
  const merged = mergeExecutionPolicy(defaults, configured);
  assert.equal(merged.maxToolCalls, 8);
});

test("mergeExecutionPolicy preserves defaults when configured is null", () => {
  // FIX(A5-per-role-budget): planner default is now its tier (30), not the flat
  // DEFAULT_MAX_TOOL_CALLS -> assert merge preserves the planner tier.
  const defaults = getDefaultExecutionPolicy(AGENT_ROLE.PLANNER);
  const merged = mergeExecutionPolicy(defaults, null);
  assert.equal(merged.maxToolCalls, defaults.maxToolCalls);
  assert.equal(merged.maxToolCalls, 30);
});
