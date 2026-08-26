import { test, mock } from "node:test";
import assert from "node:assert/strict";

const dispatchTargetStateMap = new Map();
const dispatchOutgoingStateMap = new Map();
const dispatchSharedCalls = [];
let mockGraph = { edges: [] };

function normalizeIncomingDispatchEntry(agentId, entry) {
  const source = typeof entry === "string" ? { contractId: entry } : (entry && typeof entry === "object" ? entry : {});
  if (!source.contractId) return null;
  return {
    contractId: source.contractId,
    fromAgent: source.fromAgent || null,
    targetAgent: agentId,
  };
}

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
    // 与真实实现同形:标了 pipeline 的边优先,一条都没标时全部边都是候选。
    getPipelineEdgesFrom: (graph, nodeId) => {
      const edges = (graph?.edges || []).filter((e) => e.from === nodeId);
      const marked = edges.filter((e) => e.metadata?.pipeline === true);
      return marked.length > 0 ? marked : edges;
    },
    loadGraph: async () => mockGraph,
    detectCycles: () => [],
    hasDirectedEdge: (graph, from, to) =>
      (graph?.edges || []).some((edge) => edge.from === from && edge.to === to),
    getEdgesFrom: (graph, nodeId) => (graph?.edges || []).filter((edge) => edge.from === nodeId),
    getEdgesTo: (graph, nodeId) => (graph?.edges || []).filter((edge) => edge.to === nodeId),
  },
});

mock.module("../lib/routing/dispatch/dispatch-transport.js", {
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

mock.module("../lib/contract/contracts.js", {
  namedExports: {
    mutateContractSnapshot: async (_path, _logger, fn) => {
      fn({ assignee: null, status: "running" });
      return { contract: { id: "mock-contract", assignee: null, status: "running" } };
    },
    mutateContractById: async (_id, _logger, fn) => {
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

mock.module("../lib/routing/dispatch/dispatch-runtime-state.js", {
  namedExports: {
    listDispatchTargetIds: () => [...dispatchTargetStateMap.keys()],
    hasDispatchTarget: (agentId) => dispatchTargetStateMap.has(agentId),
    ensureDispatchTargetAvailable: async (agentId) => dispatchTargetStateMap.has(agentId),
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
      state.queue = Array.isArray(state.queue)
        ? state.queue.filter((entry) => normalizeIncomingDispatchEntry(agentId, entry)?.contractId !== contractId)
        : [];
      if (state.dispatchingQueueEntry?.contractId === contractId) {
        state.dispatchingQueueEntry = null;
      }
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
      state.dispatchingQueueEntry = null;
      return true;
    },
    enqueueDispatchContract: (agentId, contractId) => {
      const state = dispatchTargetStateMap.get(agentId);
      if (!state) return false;
      state.queue = Array.isArray(state.queue) ? state.queue : [];
      const existingLease = normalizeIncomingDispatchEntry(agentId, state.dispatchingQueueEntry);
      const exists = existingLease?.contractId === contractId || state.queue.some((entry) => (
        normalizeIncomingDispatchEntry(agentId, entry)?.contractId === contractId
      ));
      if (!exists) {
        state.queue.push({ contractId, fromAgent: "planner" });
      }
      return true;
    },
    dequeueDispatchContract: (agentId) => {
      const state = dispatchTargetStateMap.get(agentId);
      if (state?.dispatchingQueueEntry) return null;
      if (!state || !Array.isArray(state.queue) || state.queue.length === 0) return null;
      const entry = normalizeIncomingDispatchEntry(agentId, state.queue.shift());
      if (!entry) return null;
      state.dispatchingQueueEntry = entry;
      return entry;
    },
    requeueDispatchContractFront: async (agentId, entry) => {
      const state = dispatchTargetStateMap.get(agentId);
      if (!state) return false;
      state.queue = Array.isArray(state.queue) ? state.queue : [];
      const normalized = normalizeIncomingDispatchEntry(agentId, entry);
      if (!normalized) return false;
      if (state.dispatchingQueueEntry?.contractId === normalized.contractId) {
        state.dispatchingQueueEntry = null;
      }
      if (state.queue.some((queued) => normalizeIncomingDispatchEntry(agentId, queued)?.contractId === normalized.contractId)) return false;
      state.queue.unshift({
        contractId: normalized.contractId,
        fromAgent: normalized.fromAgent,
      });
      return true;
    },
    getDispatchQueueDepth: (agentId) => {
      const state = dispatchTargetStateMap.get(agentId);
      return Array.isArray(state?.queue) ? state.queue.length : 0;
    },
    enqueueOutgoingDispatchContract: (agentId, contractId, meta = {}) => {
      const state = dispatchOutgoingStateMap.get(agentId) || { outgoingQueue: [] };
      state.outgoingQueue = Array.isArray(state.outgoingQueue) ? state.outgoingQueue : [];
      const entry = {
        contractId,
        targetAgent: meta?.targetAgent || null,
        status: meta?.status || "ready",
        routeEdge: meta?.routeEdge || null,
      };
      const existing = state.outgoingQueue.find((item) => item?.contractId === contractId);
      if (existing) Object.assign(existing, entry);
      else state.outgoingQueue.push(entry);
      dispatchOutgoingStateMap.set(agentId, state);
      return true;
    },
    removeOutgoingDispatchContract: async (agentId, contractId) => {
      const state = dispatchOutgoingStateMap.get(agentId);
      if (!state || !Array.isArray(state.outgoingQueue)) return false;
      const before = state.outgoingQueue.length;
      state.outgoingQueue = state.outgoingQueue.filter((entry) => entry?.contractId !== contractId);
      const changed = state.outgoingQueue.length !== before;
      if (state.outgoingQueue.length === 0) dispatchOutgoingStateMap.delete(agentId);
      return changed;
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
    deleteUnclaimedTrackingSessionForContract: () => ({
      removed: true,
      reason: "mock_cleanup",
    }),
    waitForTrackingContractClaim: async (sessionKey, contractId) => ({
      claimed: true,
      sessionKey,
      contractId,
      source: "mock_waiter",
    }),
  },
});

mock.module("../lib/prompt/role-spec-registry.js", {
  namedExports: {
    getRoleSummary: () => "planner summary",
  },
});

const {
  dispatchRouteExecutionContract,
  onAgentDone,
} = await import("../lib/routing/dispatch/dispatch-graph-policy.js");

const logger = { info() {}, warn() {}, error() {} };
const api = {};

test("retry-suspended non-worker agent must stay busy and must not drain queued work", async () => {
  dispatchTargetStateMap.clear();
  dispatchOutgoingStateMap.clear();
  dispatchSharedCalls.length = 0;

  const agentId = `planner-retry-${Date.now()}`;
  mockGraph = { edges: [{ from: "planner", to: agentId }] };
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
