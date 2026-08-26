import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionEpochKey,
  resolveSessionEpochKey,
  parseSessionEpochKey,
} from "../lib/runtime/session-epoch-key.js";

test("buildSessionEpochKey composes sessionKey#run=runId when both present", () => {
  assert.equal(buildSessionEpochKey("agent:worker:main", "run-1"), "agent:worker:main#run=run-1");
});

test("buildSessionEpochKey falls back to bare sessionKey when runId is missing", () => {
  assert.equal(buildSessionEpochKey("agent:worker:main", null), "agent:worker:main");
  assert.equal(buildSessionEpochKey("agent:worker:main"), "agent:worker:main");
});

test("buildSessionEpochKey returns null when sessionKey is missing", () => {
  assert.equal(buildSessionEpochKey(null, "run-1"), null);
  assert.equal(buildSessionEpochKey("", "run-1"), null);
});

test("resolveSessionEpochKey pulls from trackingState shape", () => {
  assert.equal(
    resolveSessionEpochKey({ sessionKey: "agent:worker:main", runId: "run-2" }),
    "agent:worker:main#run=run-2",
  );
  assert.equal(
    resolveSessionEpochKey({ sessionKey: "agent:worker:main" }),
    "agent:worker:main",
  );
});

test("parseSessionEpochKey round-trips keys with colons in sessionKey", () => {
  assert.deepEqual(parseSessionEpochKey("agent:worker:main#run=run-1"), {
    sessionKey: "agent:worker:main",
    runId: "run-1",
  });
  assert.deepEqual(parseSessionEpochKey("agent:worker:main"), {
    sessionKey: "agent:worker:main",
    runId: null,
  });
});

test("fresh runId gets a fresh epoch key on the same mailbox", () => {
  const mailboxSession = "agent:worker:main";
  const firstEpoch = buildSessionEpochKey(mailboxSession, "run-1");
  const secondEpoch = buildSessionEpochKey(mailboxSession, "run-2");
  assert.notEqual(firstEpoch, secondEpoch);
});
