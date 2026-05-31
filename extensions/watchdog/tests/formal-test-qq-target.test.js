import test from "node:test";
import assert from "node:assert/strict";

import {
  buildQQTestReplyTo,
  resolveQQTestTarget,
} from "../lib/formal-test-qq-target.js";

test("resolveQQTestTarget prefers explicit live target without reply ids", () => {
  const target = resolveQQTestTarget({
    env: {
      OPENCLAW_TEST_QQ_TARGET: "c2c:live-openid",
      OPENCLAW_TEST_QQ_REPLY_TO_ID: "ignored",
    },
    knownUsers: [],
  });

  assert.equal(target.target, "c2c:live-openid");
  assert.equal(target.accountId, "default");
  assert.equal("messageId" in target, false);
  assert.equal("replyToId" in target, false);
});

test("resolveQQTestTarget uses newest c2c known user when env target is absent", () => {
  const target = resolveQQTestTarget({
    env: {},
    knownUsers: [
      { type: "c2c", openid: "older", accountId: "default", lastSeenAt: 10 },
      { type: "group", groupOpenid: "group-1", accountId: "default", lastSeenAt: 999 },
      { type: "c2c", openid: "newer", accountId: "alt", lastSeenAt: 20 },
    ],
  });

  assert.deepEqual(target, {
    channel: "qqbot",
    target: "c2c:newer",
    accountId: "alt",
  });
});

test("buildQQTestReplyTo returns a live proactive QQ reply target for test-runner", () => {
  const replyTo = buildQQTestReplyTo({
    runId: "TR-1",
    target: {
      channel: "qqbot",
      target: "c2c:user-1",
      accountId: "default",
    },
  });

  assert.deepEqual(replyTo, {
    kind: "test_run",
    runId: "TR-1",
    agentId: "agent-for-kksl",
    sessionKey: "test-run:TR-1",
    channel: "qqbot",
    target: "c2c:user-1",
    accountId: "default",
  });
});
