import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_TOOL_CALLS,
  getDefaultExecutionPolicy,
  mergeExecutionPolicy,
  resolveMaxToolCallsFromPolicy,
} from "../lib/execution-policy-defaults.js";
import { AGENT_ROLE } from "../lib/agent/agent-metadata.js";

test("DEFAULT_MAX_TOOL_CALLS is the formal role-default budget", () => {
  assert.equal(DEFAULT_MAX_TOOL_CALLS, 50);
});

test("every role's default policy exposes maxToolCalls", () => {
  for (const role of Object.values(AGENT_ROLE)) {
    const defaults = getDefaultExecutionPolicy(role);
    assert.ok(defaults, `role ${role} should have default policy`);
    assert.equal(defaults.maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
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
  const defaults = getDefaultExecutionPolicy(AGENT_ROLE.PLANNER);
  const merged = mergeExecutionPolicy(defaults, null);
  assert.equal(merged.maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
});
