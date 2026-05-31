import test from "node:test";
import assert from "node:assert/strict";

import {
  trackToolCall,
  markSessionHardStopped,
  getSessionHardStopReason,
  isSessionHardStopped,
  clearAllSessions,
  HARD_STOP_REASON,
} from "../lib/loop/loop-detection.js";
import { buildLoopEpochKey, resolveLoopEpochKey } from "../lib/loop/loop-epoch-key.js";

test.beforeEach(() => {
  clearAllSessions();
});

test("two runs with the same sessionKey but different runId keep independent loop state", () => {
  const sessionKey = "agent:worker:main";
  const run1 = buildLoopEpochKey(sessionKey, "run-1");
  const run2 = buildLoopEpochKey(sessionKey, "run-2");

  for (let i = 0; i < 5; i++) {
    trackToolCall(run1, "read", { path: "a.md" });
  }
  assert.equal(isSessionHardStopped(run1), true, "run-1 hits repeat threshold");
  assert.equal(getSessionHardStopReason(run1), HARD_STOP_REASON.REPEAT_THRESHOLD);

  assert.equal(isSessionHardStopped(run2), false, "run-2 has no hard-stop state leaked from run-1");
});

test("resolveLoopEpochKey pulls runId off trackingState and stays stable", () => {
  const trackingState = {
    sessionKey: "agent:worker:main",
    runId: "abc123",
  };
  const key = resolveLoopEpochKey(trackingState);
  markSessionHardStopped(key, HARD_STOP_REASON.MAX_TOOL_CALLS);
  assert.equal(getSessionHardStopReason(resolveLoopEpochKey(trackingState)), HARD_STOP_REASON.MAX_TOOL_CALLS);
});

test("missing runId falls back to bare sessionKey (back-compat)", () => {
  const trackingState = { sessionKey: "agent:worker:main" };
  const key = resolveLoopEpochKey(trackingState);
  assert.equal(key, "agent:worker:main");
  markSessionHardStopped(key, HARD_STOP_REASON.MANUAL);
  assert.equal(getSessionHardStopReason("agent:worker:main"), HARD_STOP_REASON.MANUAL);
});
