import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLoopEpochKey,
  resolveLoopEpochKey,
  parseLoopEpochKey,
} from "../lib/loop/loop-epoch-key.js";

test("buildLoopEpochKey composes sessionKey#run=runId when both present", () => {
  assert.equal(buildLoopEpochKey("agent:worker:main", "run-1"), "agent:worker:main#run=run-1");
});

test("buildLoopEpochKey falls back to bare sessionKey when runId is missing", () => {
  assert.equal(buildLoopEpochKey("agent:worker:main", null), "agent:worker:main");
  assert.equal(buildLoopEpochKey("agent:worker:main"), "agent:worker:main");
});

test("buildLoopEpochKey returns null when sessionKey is missing", () => {
  assert.equal(buildLoopEpochKey(null, "run-1"), null);
  assert.equal(buildLoopEpochKey("", "run-1"), null);
});

test("resolveLoopEpochKey pulls from trackingState shape", () => {
  assert.equal(
    resolveLoopEpochKey({ sessionKey: "agent:worker:main", runId: "run-2" }),
    "agent:worker:main#run=run-2",
  );
  assert.equal(
    resolveLoopEpochKey({ sessionKey: "agent:worker:main" }),
    "agent:worker:main",
  );
});

test("parseLoopEpochKey round-trips keys with colons in sessionKey", () => {
  assert.deepEqual(parseLoopEpochKey("agent:worker:main#run=run-1"), {
    sessionKey: "agent:worker:main",
    runId: "run-1",
  });
  assert.deepEqual(parseLoopEpochKey("agent:worker:main"), {
    sessionKey: "agent:worker:main",
    runId: null,
  });
});

test("fresh runId gets a fresh epoch key on the same mailbox", () => {
  const mailboxSession = "agent:worker:main";
  const firstEpoch = buildLoopEpochKey(mailboxSession, "run-1");
  const secondEpoch = buildLoopEpochKey(mailboxSession, "run-2");
  assert.notEqual(firstEpoch, secondEpoch);
});
