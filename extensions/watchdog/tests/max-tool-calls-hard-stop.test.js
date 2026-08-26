import test from "node:test";
import assert from "node:assert/strict";

import {
  clearAllSessions,
  getSessionHardStopReason,
  isSessionHardStopped,
  markSessionHardStopped,
  HARD_STOP_REASON,
} from "../lib/runtime/execution-hard-stop-registry.js";
import { buildSessionEpochKey, resolveSessionEpochKey } from "../lib/runtime/session-epoch-key.js";
import {
  DEFAULT_MAX_TOOL_CALLS,
  resolveMaxToolCallsFromPolicy,
} from "../lib/security/execution-policy-defaults.js";
import { createTrackingState } from "../lib/session/session-bootstrap.js";

test.beforeEach(() => {
  clearAllSessions();
});

test("trackingState snapshotted executionPolicy wins over bare default", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:worker:main",
    agentId: "worker",
    parentSession: null,
    executionPolicy: { maxToolCalls: 3 },
  });
  assert.equal(trackingState.executionPolicy.maxToolCalls, 3);
  assert.equal(resolveMaxToolCallsFromPolicy(trackingState.executionPolicy), 3);
});

test("no executionPolicy on trackingState falls back to DEFAULT_MAX_TOOL_CALLS", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:worker:main",
    agentId: "worker",
    parentSession: null,
  });
  assert.equal(trackingState.executionPolicy, null);
  assert.equal(resolveMaxToolCallsFromPolicy(trackingState.executionPolicy), DEFAULT_MAX_TOOL_CALLS);
});

test("max_tool_calls hard-stop reason sets session reason when toolCallTotal hits budget", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:worker:main",
    agentId: "worker",
    parentSession: null,
    executionPolicy: { maxToolCalls: 2 },
  });
  trackingState.toolCallTotal = 2;
  const epochKey = resolveSessionEpochKey(trackingState);
  const budget = resolveMaxToolCallsFromPolicy(trackingState.executionPolicy);
  if (trackingState.toolCallTotal >= budget) {
    markSessionHardStopped(epochKey, HARD_STOP_REASON.MAX_TOOL_CALLS);
  }
  assert.equal(isSessionHardStopped(epochKey), true);
  assert.equal(getSessionHardStopReason(epochKey), HARD_STOP_REASON.MAX_TOOL_CALLS);
});

test("max_tool_calls hard-stop is epoch-scoped (not leaked across runId)", () => {
  const sessionKey = "agent:worker:main";
  const run1 = buildSessionEpochKey(sessionKey, "run-a");
  const run2 = buildSessionEpochKey(sessionKey, "run-b");
  markSessionHardStopped(run1, HARD_STOP_REASON.MAX_TOOL_CALLS);
  assert.equal(getSessionHardStopReason(run2), null);
});
