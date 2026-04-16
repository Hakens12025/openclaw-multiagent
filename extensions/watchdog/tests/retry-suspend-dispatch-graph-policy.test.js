import { test, mock } from "node:test";
import assert from "node:assert/strict";

const dispatchTargetStateMap = new Map();
const dispatchSharedCalls = [];
const roundRobinCursorByAgent = new Map();

mock.module("../lib/state.js", {
  namedExports: {
    dispatchTargetStateMap,
    OC: "/tmp/openclaw-test",
    QUEUE_STATE_FILE: "/tmp/openclaw-test/queue-state.json",
    atomicWriteFile: async () => {},
    withLock: async (_key, fn) => fn(),
  },
});

mock.module("../lib/agent/agent-graph.js", {
  namedExports: {
    loadGraph: async () => ({ edges: [] }),
    detectCycles: () => [],
    hasDirectedEdge: (graph, from, to) =>
      (graph?.edges || []).some((edge) => edge.from === from && edge.to === to),
    getEdgesFrom: (graph, nodeId) => (graph?.edges || []).filter((edge) => edge.from === nodeId),
    getEdgesTo: (graph, nodeId) => (graph?.edges || []).filter((edge) => edge.to === nodeId),
  },
});

mock.module("../lib/routing/dispatch-transport.js", {
  namedExports: {
    dispatchSendExecutionContract: async (...args) => {
      dispatchSharedCalls.push(args);
      return { ok: true };
    },
  },
});

mock.module("../lib/transport/sse.js", {
  namedExports: {
    broadcast: () => {},
  },
});

mock.module("../lib/contracts.js", {
  namedExports: {
    mutateContractSnapshot: async (_path, _logger, fn) => {
      fn({ assignee: null, status: "running" });
      return { contract: { id: "mock-contract", assignee: null, status: "running" } };
    },
    getContractPath: (id) => `/tmp/${id}.json`,
    readContractSnapshotById: async (id) => ({
      id,
      task: `task:${id}`,
      output: `/tmp/${id}.md`,
    }),
  },
});

mock.module("../lib/routing/dispatch-runtime-state.js", {
  namedExports: {
    listDispatchTargetIds: () => [...dispatchTargetStateMap.keys()],
    hasDispatchTarget: (agentId) => dispatchTargetStateMap.has(agentId),
    isDispatchTargetBusy: (agentId) => {
      const state = dispatchTargetStateMap.get(agentId);
      return Boolean(state?.busy || state?.dispatching);
    },
    markDispatchTargetDispatching: (agentId, contractId) => {
      const state = dispatchTargetStateMap.get(agentId);
      if (!state) return false;
      state.dispatching = true;
      state.currentContract = contractId;
      return true;
    },
    rollbackDispatchTargetDispatch: (agentId) => {
      const state = dispatchTargetStateMap.get(agentId);
      if (!state) return false;
      state.dispatching = false;
      state.currentContract = null;
      return true;
    },
    claimDispatchTargetContract: async ({ contractId, agentId }) => {
      const state = dispatchTargetStateMap.get(agentId);
      if (!state) return false;
      state.busy = true;
      state.dispatching = false;
      state.currentContract = contractId;
      return true;
    },
    releaseDispatchTargetContract: async ({ agentId }) => {
      const state = dispatchTargetStateMap.get(agentId);
      if (!state) return false;
      state.busy = false;
      state.dispatching = false;
      state.currentContract = null;
      return true;
    },
    enqueueDispatchContract: (agentId, contractId) => {
      const state = dispatchTargetStateMap.get(agentId);
      if (!state) return false;
      state.queue = Array.isArray(state.queue) ? state.queue : [];
      if (!state.queue.some((entry) => entry?.contractId === contractId)) {
        state.queue.push({ contractId, fromAgent: "planner" });
      }
      return true;
    },
    dequeueDispatchContract: (agentId) => {
      const state = dispatchTargetStateMap.get(agentId);
      if (!state || !Array.isArray(state.queue) || state.queue.length === 0) return null;
      return state.queue.shift();
    },
    getDispatchQueueDepth: (agentId) => {
      const state = dispatchTargetStateMap.get(agentId);
      return Array.isArray(state?.queue) ? state.queue.length : 0;
    },
    advanceDispatchRoundRobinCursor: (agentId, modulo) => {
      const normalizedModulo = Number.isInteger(modulo) && modulo > 0 ? modulo : 1;
      const next = (roundRobinCursorByAgent.get(agentId) ?? 0) % normalizedModulo;
      roundRobinCursorByAgent.set(agentId, next + 1);
      return next;
    },
  },
});

mock.module("../lib/agent/agent-identity.js", {
  namedExports: {
    getAgentRole: () => "planner",
  },
});

mock.module("../lib/store/tracker-store.js", {
  namedExports: {
    waitForTrackingContractClaim: async (sessionKey, contractId) => ({
      claimed: true,
      sessionKey,
      contractId,
      source: "mock_waiter",
    }),
  },
});

mock.module("../lib/role-spec-registry.js", {
  namedExports: {
    getDispatchInstruction: () => "do the task",
    getRoleSummary: () => "planner summary",
  },
});

const {
  dispatchRouteExecutionContract,
  onAgentDone,
} = await import("../lib/routing/dispatch-graph-policy.js");

const logger = { info() {}, warn() {}, error() {} };
const api = {};

test("retry-suspended non-worker agent must stay busy and must not drain queued work", async () => {
  dispatchTargetStateMap.clear();
  dispatchSharedCalls.length = 0;
  roundRobinCursorByAgent.clear();

  const agentId = `planner-retry-${Date.now()}`;
  dispatchTargetStateMap.set(agentId, {
    busy: false,
    dispatching: false,
    currentContract: null,
    healthy: true,
    lastSeen: Date.now(),
    queue: [],
  });

  const first = await dispatchRouteExecutionContract("C-FIRST", "planner", agentId, api, logger);
  assert.equal(first.dispatched, true);
  assert.equal(dispatchSharedCalls.length, 1);

  const queued = await dispatchRouteExecutionContract("C-QUEUED", "planner", agentId, api, logger);
  assert.equal(queued.queued, true);
  assert.equal(queued.dispatched, false);

  await onAgentDone(agentId, api, logger, { retainBusy: true });

  assert.equal(dispatchSharedCalls.length, 1);

  const later = await dispatchRouteExecutionContract("C-LATER", "planner", agentId, api, logger);
  assert.equal(later.queued, true);
  assert.equal(later.dispatched, false);
  assert.equal(dispatchSharedCalls.length, 1);
});
