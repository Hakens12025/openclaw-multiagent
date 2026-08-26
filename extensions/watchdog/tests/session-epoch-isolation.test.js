import test from "node:test";
import assert from "node:assert/strict";

import {
  trackToolCall,
  markSessionHardStopped,
  getSessionHardStopReason,
  isSessionHardStopped,
  clearAllSessions,
  HARD_STOP_REASON,
} from "../lib/runtime/execution-hard-stop-registry.js";
import { buildSessionEpochKey, resolveSessionEpochKey } from "../lib/runtime/session-epoch-key.js";

test.beforeEach(() => {
  clearAllSessions();
});

test("two runs with the same sessionKey but different runId keep independent loop state", () => {
  const sessionKey = "agent:worker:main";
  const run1 = buildSessionEpochKey(sessionKey, "run-1");
  const run2 = buildSessionEpochKey(sessionKey, "run-2");

  for (let i = 0; i < 5; i++) {
    trackToolCall(run1, "read", { path: "a.md" });
  }
  assert.equal(isSessionHardStopped(run1), true, "run-1 hits repeat threshold");
  assert.equal(getSessionHardStopReason(run1), HARD_STOP_REASON.REPEAT_THRESHOLD);

  assert.equal(isSessionHardStopped(run2), false, "run-2 has no hard-stop state leaked from run-1");
});

test("resolveSessionEpochKey pulls runId off trackingState and stays stable", () => {
  const trackingState = {
    sessionKey: "agent:worker:main",
    runId: "abc123",
  };
  const key = resolveSessionEpochKey(trackingState);
  markSessionHardStopped(key, HARD_STOP_REASON.MAX_TOOL_CALLS);
  assert.equal(getSessionHardStopReason(resolveSessionEpochKey(trackingState)), HARD_STOP_REASON.MAX_TOOL_CALLS);
});

test("missing runId falls back to bare sessionKey (back-compat)", () => {
  const trackingState = { sessionKey: "agent:worker:main" };
  const key = resolveSessionEpochKey(trackingState);
  assert.equal(key, "agent:worker:main");
  markSessionHardStopped(key, HARD_STOP_REASON.MANUAL);
  assert.equal(getSessionHardStopReason("agent:worker:main"), HARD_STOP_REASON.MANUAL);
});
