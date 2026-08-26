import test from "node:test";
import assert from "node:assert/strict";

import {
  clearAllSessions,
  getSessionHardStopReason,
  isSessionHardStopped,
  markSessionHardStopped,
  HARD_STOP_REASON,
} from "../lib/runtime/execution-hard-stop-registry.js";
import { resolveSessionEpochKey } from "../lib/runtime/session-epoch-key.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  resolveMaxOutputBytesFromPolicy,
} from "../lib/security/execution-policy-defaults.js";
import { measureToolResultBytes } from "../lib/delivery/runtime-user-facing-output.js";
import { createTrackingState } from "../lib/session/session-bootstrap.js";

test.beforeEach(() => {
  clearAllSessions();
});

test("measureToolResultBytes sizes content text parts, string, and object results", () => {
  const contentEvent = {
    result: {
      content: [
        { type: "text", text: "abcde" }, // 5 bytes
        { type: "text", text: "fg" },     // 2 bytes
        { type: "image", data: "…ignored…" },
      ],
    },
  };
  assert.equal(measureToolResultBytes(contentEvent), 7);
  assert.equal(measureToolResultBytes({ result: "☃" }), 3); // multibyte UTF-8
  assert.equal(
    measureToolResultBytes({ result: { a: 1 } }),
    Buffer.byteLength(JSON.stringify({ a: 1 }), "utf8"), // 7
  );
  assert.equal(measureToolResultBytes({}), 0);
  assert.equal(measureToolResultBytes(null), 0);
  assert.equal(measureToolResultBytes({ result: { content: [] } }), 0);
});

test("DEFAULT_MAX_OUTPUT_BYTES is the 20MB formal budget", () => {
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 20_000_000);
});

test("resolveMaxOutputBytesFromPolicy prefers a positive policy override", () => {
  assert.equal(resolveMaxOutputBytesFromPolicy(null), DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(resolveMaxOutputBytesFromPolicy({}), DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(resolveMaxOutputBytesFromPolicy({ maxOutputBytes: 1000 }), 1000);
  assert.equal(resolveMaxOutputBytesFromPolicy({ maxOutputBytes: 0 }), DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(resolveMaxOutputBytesFromPolicy({ maxOutputBytes: -5 }), DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(resolveMaxOutputBytesFromPolicy({ maxOutputBytes: "x" }), DEFAULT_MAX_OUTPUT_BYTES);
});

test("cumulative tool-output crossing budget hard-stops with OUTPUT_BUDGET_EXHAUSTED", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:worker:main",
    agentId: "worker",
    parentSession: null,
    executionPolicy: { maxOutputBytes: 10 },
  });
  const epochKey = resolveSessionEpochKey(trackingState);
  const budget = resolveMaxOutputBytesFromPolicy(trackingState.executionPolicy);
  const chunk = { result: { content: [{ type: "text", text: "1234567" }] } }; // 7 bytes

  // Replay the after-tool-call accounting block, one tool call at a time.
  trackingState.outputBytesTotal =
    Number(trackingState.outputBytesTotal || 0) + measureToolResultBytes(chunk);
  if (trackingState.outputBytesTotal >= budget) {
    markSessionHardStopped(epochKey, HARD_STOP_REASON.OUTPUT_BUDGET_EXHAUSTED);
  }
  assert.equal(getSessionHardStopReason(epochKey), null); // 7 < 10

  trackingState.outputBytesTotal =
    Number(trackingState.outputBytesTotal || 0) + measureToolResultBytes(chunk);
  if (trackingState.outputBytesTotal >= budget) {
    markSessionHardStopped(epochKey, HARD_STOP_REASON.OUTPUT_BUDGET_EXHAUSTED);
  }
  assert.equal(trackingState.outputBytesTotal, 14); // 14 >= 10
  assert.equal(isSessionHardStopped(epochKey), true);
  assert.equal(getSessionHardStopReason(epochKey), HARD_STOP_REASON.OUTPUT_BUDGET_EXHAUSTED);
  assert.equal(HARD_STOP_REASON.OUTPUT_BUDGET_EXHAUSTED, "output_budget_exhausted");
});
