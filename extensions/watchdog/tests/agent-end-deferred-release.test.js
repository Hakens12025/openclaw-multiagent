import { test, mock } from "node:test";
import assert from "node:assert/strict";

const calls = {
  clearReconcile: [],
  flushDeferred: [],
  lifecycle: [],
  getTrackingState: [],
};

mock.module("../lib/lifecycle/agent-end/lifecycle.js", {
  namedExports: {
    runAgentEndLifecycle: async (input) => {
      calls.lifecycle.push(input);
    },
  },
});

mock.module("../lib/protocol/protocol-commit-reconcile.js", {
  namedExports: {
    clearProtocolCommitReconcile: (sessionKey) => {
      calls.clearReconcile.push(sessionKey);
    },
    flushProtocolCommitDeferredRelease: async (sessionKey) => {
      calls.flushDeferred.push(sessionKey);
      return { released: true };
    },
  },
});

mock.module("../lib/store/tracker-store.js", {
  namedExports: {
    getTrackingState: (sessionKey) => {
      calls.getTrackingState.push(sessionKey);
      return null;
    },
  },
});

mock.module("../lib/store/heartbeat-session-store.js", {
  namedExports: {
    isHeartbeatSessionIgnored: () => false,
    unignoreHeartbeatSession: () => {},
  },
});

const { register } = await import("../hooks/agent-end.js");

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("agent_end flushes deferred protocol commit release when tracker state is gone", async () => {
  const handlers = new Map();
  register({
    on(name, handler) {
      handlers.set(name, handler);
    },
  }, logger);

  await handlers.get("agent_end")({ success: true }, {
    sessionKey: "agent:worker:contract:TC-DEFERRED",
  });

  assert.deepEqual(calls.clearReconcile, ["agent:worker:contract:TC-DEFERRED"]);
  assert.deepEqual(calls.flushDeferred, ["agent:worker:contract:TC-DEFERRED"]);
  assert.equal(calls.lifecycle.length, 1);
  assert.equal(calls.lifecycle[0].trackingState, null);
});
