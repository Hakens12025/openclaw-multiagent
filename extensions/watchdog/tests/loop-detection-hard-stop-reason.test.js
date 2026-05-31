import test from "node:test";
import assert from "node:assert/strict";

import {
  trackToolCall,
  markSessionHardStopped,
  getSessionHardStopReason,
  isSessionHardStopped,
  clearAllSessions,
} from "../lib/loop/loop-detection.js";

test.beforeEach(() => {
  clearAllSessions();
});

test("markSessionHardStopped stores the reason verbatim", () => {
  markSessionHardStopped("sess-a", "manual");
  assert.equal(getSessionHardStopReason("sess-a"), "manual");
  assert.equal(isSessionHardStopped("sess-a"), true);
});

test("repeated identical tool call threshold sets reason to repeat_threshold", () => {
  const sessionKey = "sess-b";
  // Default threshold is 5 repeats of the same call.
  for (let i = 0; i < 5; i++) {
    trackToolCall(sessionKey, "read", { path: "a.md" });
  }
  assert.equal(isSessionHardStopped(sessionKey), true);
  assert.equal(getSessionHardStopReason(sessionKey), "repeat_threshold");
});

test("no-op / absent session keys return null/false without throwing", () => {
  assert.equal(getSessionHardStopReason(null), null);
  assert.equal(getSessionHardStopReason(""), null);
  assert.equal(getSessionHardStopReason("absent"), null);
  assert.equal(isSessionHardStopped(null), false);
});

test("first-wins reason is preserved against later overrides of the same session", () => {
  markSessionHardStopped("sess-c", "repeat_threshold");
  // A second signal with a different reason should not silently downgrade
  // the first one (first call wins; explicit override must pass a non-empty reason).
  markSessionHardStopped("sess-c", "");
  assert.equal(getSessionHardStopReason("sess-c"), "repeat_threshold");
});
