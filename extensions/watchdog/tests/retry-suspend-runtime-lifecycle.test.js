import { test, mock } from "node:test";
import assert from "node:assert/strict";

const dispatchTargetStateMap = new Map();
const releaseWorkerCalls = [];
const broadcastCalls = [];
const deleteTrackingCalls = [];
const recordHistoryCalls = [];
const onAgentDoneCalls = [];
const qqTypingStopCalls = [];
const runtimeAgentConfigs = new Map();

mock.module("../lib/state.js", {
  namedExports: {
    CONTRACTS_DIR: "/tmp/contracts",
    HOME: "/tmp",
    OC: "/tmp/openclaw-test",
    QQ_OPENID: "qq-openid-test",
    agentWorkspace: (agentId) => `/tmp/${agentId}`,
    atomicWriteFile: async () => {},
    cfg: {},
    persistState: async () => {},
    runtimeAgentConfigs,
    sseClients: new Set(),
    withLock: async (_key, fn) => fn(),
    dispatchTargetStateMap,
  },
});

mock.module("../lib/transport/sse.js", {
  namedExports: {
    broadcast: (...args) => {
      broadcastCalls.push(args);
    },
    buildProgressPayload: (trackingState) => ({
      sessionKey: trackingState.sessionKey,
      status: trackingState.status,
      contractId: trackingState.contract?.id || null,
    }),
  },
});

mock.module("../lib/routing/dispatch-runtime-state.js", {
  namedExports: {
    hasDispatchTarget: (agentId) => dispatchTargetStateMap.has(agentId),
    isDispatchTargetBusy: (agentId) => {
      const state = dispatchTargetStateMap.get(agentId);
      return Boolean(state?.busy || state?.dispatching);
    },
    releaseDispatchTargetContract: async (payload) => {
      releaseWorkerCalls.push(payload);
    },
  },
});

mock.module("../lib/qq.js", {
  namedExports: {
    qqTypingStop: (contractId) => {
      qqTypingStopCalls.push(contractId);
    },
  },
});

mock.module("../lib/store/tracker-store.js", {
  namedExports: {
    deleteTrackingSession: (sessionKey) => {
      deleteTrackingCalls.push(sessionKey);
    },
    listTrackingStates: () => [],
  },
});

mock.module("../lib/stage-projection.js", {
  namedExports: {
    refreshTrackingProjection: async () => {},
  },
});

mock.module("../lib/store/task-history-store.js", {
  namedExports: {
    getTaskHistorySnapshot: () => [],
    recordTaskHistory: (payload) => {
      recordHistoryCalls.push(payload);
    },
  },
});

mock.module("../lib/routing/dispatch-graph-policy.js", {
  namedExports: {
    onAgentDone: async (...args) => {
      onAgentDoneCalls.push(args);
    },
  },
});

const {
  finalizeAgentSession,
  SESSION_FINALIZE_MODE,
} = await import("../lib/lifecycle/runtime-lifecycle.js");

const logger = { info() {}, warn() {}, error() {} };

test("retry suspend keeps worker reservation and suppresses terminal cleanup side effects", async () => {
  dispatchTargetStateMap.clear();
  runtimeAgentConfigs.clear();
  releaseWorkerCalls.length = 0;
  broadcastCalls.length = 0;
  deleteTrackingCalls.length = 0;
  recordHistoryCalls.length = 0;
  onAgentDoneCalls.length = 0;
  qqTypingStopCalls.length = 0;

  dispatchTargetStateMap.set("worker-a", {
    busy: true,
    dispatching: false,
    currentContract: "TC-RETRY",
    healthy: true,
    lastSeen: Date.now(),
    queue: [],
  });
  runtimeAgentConfigs.set("worker-a", { id: "worker-a", role: "executor" });

  const trackingState = {
    sessionKey: "agent:worker-a:contract:TC-RETRY",
    agentId: "worker-a",
    status: "waiting_retry",
    contract: {
      id: "TC-RETRY",
      status: "running",
    },
  };

  await finalizeAgentSession({
    agentId: "worker-a",
    sessionKey: trackingState.sessionKey,
    trackingState,
    api: {},
    logger,
    mode: SESSION_FINALIZE_MODE.RETRY_SUSPEND,
  });

  assert.equal(releaseWorkerCalls.length, 0);
  assert.equal(onAgentDoneCalls.length, 1);
  assert.deepEqual(onAgentDoneCalls[0][3], { retainBusy: true });
  assert.equal(deleteTrackingCalls.length, 0);
  assert.equal(recordHistoryCalls.length, 0);
  assert.equal(qqTypingStopCalls.length, 0);
  assert.equal(broadcastCalls.some(([event]) => event === "track_progress"), true);
  assert.equal(broadcastCalls.some(([event]) => event === "track_end"), false);
});

test("terminal finalize stops QQ typing before releasing executor reservation", async () => {
  dispatchTargetStateMap.clear();
  runtimeAgentConfigs.clear();
  releaseWorkerCalls.length = 0;
  broadcastCalls.length = 0;
  deleteTrackingCalls.length = 0;
  recordHistoryCalls.length = 0;
  onAgentDoneCalls.length = 0;
  qqTypingStopCalls.length = 0;

  dispatchTargetStateMap.set("worker-a", {
    busy: true,
    dispatching: false,
    currentContract: "TC-TERM",
    healthy: true,
    lastSeen: Date.now(),
    queue: [],
  });
  runtimeAgentConfigs.set("worker-a", { id: "worker-a", role: "executor" });

  const trackingState = {
    sessionKey: "agent:worker-a:contract:TC-TERM",
    agentId: "worker-a",
    status: "completed",
    contract: {
      id: "TC-TERM",
      status: "completed",
    },
  };

  await finalizeAgentSession({
    agentId: "worker-a",
    sessionKey: trackingState.sessionKey,
    trackingState,
    api: {},
    logger,
    mode: SESSION_FINALIZE_MODE.TERMINAL,
  });

  assert.deepEqual(qqTypingStopCalls, ["TC-TERM"]);
  assert.equal(releaseWorkerCalls.length, 1);
  assert.equal(releaseWorkerCalls[0].agentId, "worker-a");
  assert.equal(onAgentDoneCalls.length, 1);
  assert.deepEqual(onAgentDoneCalls[0][3], { retainBusy: false });
  assert.deepEqual(deleteTrackingCalls, [trackingState.sessionKey]);
  assert.equal(broadcastCalls.some(([event]) => event === "track_end"), true);
});

test("synthetic completion ends tracking without releasing executor reservation yet", async () => {
  dispatchTargetStateMap.clear();
  runtimeAgentConfigs.clear();
  releaseWorkerCalls.length = 0;
  broadcastCalls.length = 0;
  deleteTrackingCalls.length = 0;
  recordHistoryCalls.length = 0;
  onAgentDoneCalls.length = 0;
  qqTypingStopCalls.length = 0;

  dispatchTargetStateMap.set("worker-a", {
    busy: true,
    dispatching: false,
    currentContract: "TC-SYNTH",
    healthy: true,
    lastSeen: Date.now(),
    queue: [],
  });
  runtimeAgentConfigs.set("worker-a", { id: "worker-a", role: "executor" });

  const trackingState = {
    sessionKey: "agent:worker-a:contract:TC-SYNTH",
    agentId: "worker-a",
    status: "completed",
    contract: {
      id: "TC-SYNTH",
      status: "completed",
    },
  };

  await finalizeAgentSession({
    agentId: "worker-a",
    sessionKey: trackingState.sessionKey,
    trackingState,
    api: {},
    logger,
    mode: SESSION_FINALIZE_MODE.SYNTHETIC_COMPLETION,
  });

  assert.deepEqual(qqTypingStopCalls, ["TC-SYNTH"]);
  assert.equal(releaseWorkerCalls.length, 0);
  assert.equal(onAgentDoneCalls.length, 0);
  assert.deepEqual(deleteTrackingCalls, [trackingState.sessionKey]);
  assert.equal(recordHistoryCalls.length, 1);
  assert.equal(broadcastCalls.some(([event]) => event === "track_end"), true);
});
