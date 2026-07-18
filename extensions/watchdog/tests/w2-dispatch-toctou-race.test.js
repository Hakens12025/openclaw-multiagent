/**
 * w2-dispatch-toctou-race.test.js
 * Bug: dispatch-graph-policy.js:212-295
 *   isAgentBusy() 与 markBusy() 之间无 withLock 保护。
 *   并发 dispatch 与 reconcile(持 "dispatch-runtime:reconcile-truth" 锁)
 *   可在 await 间隙交错,导致同一合约被双重派发。
 *
 * 策略:
 *   1. 验证 fix 后 withLock("dispatch-target-claim:<agent>") 被调用(结构验证)
 *   2. 模拟并发场景:注入延迟使 await 间隙显现,验证同一 contract 只 dispatch 一次
 *
 * Run: node --experimental-test-module-mocks --test tests/w2-dispatch-toctou-race.test.js
 *
 * RED:  fix 前 withLock 未被调用,并发可能双重 dispatch
 * GREEN: fix 后 withLock 被调用,且并发场景 transport 调用 ≤1
 */

import { describe, test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ── State ────────────────────────────────────────────────────────────────────

let mockGraph = { edges: [] };
const dispatchTargetStateMap = new Map();
const dispatchOutgoingStateMap = new Map();
let claimWaitResult = { claimed: true };
let dispatchTransportResult = { ok: true };
const requeueCalls = [];
const dispatchSharedCalls = [];
const unclaimedTrackingCleanupCalls = [];
const withLockCalls = [];

function normalizeEntry(agentId, entry) {
  const src = typeof entry === "string" ? { contractId: entry } : (entry || {});
  if (!src.contractId) return null;
  return { contractId: src.contractId, fromAgent: src.fromAgent || null, targetAgent: agentId };
}

// ── withLock spy: records calls, then executes fn immediately ────────────────
const withLockSpy = async (key, fn) => {
  withLockCalls.push(key);
  return fn();
};

mock.module("../lib/agent/agent-graph.js", {
  namedExports: {
    loadGraph: async () => mockGraph,
    getEdgesFrom: (graph, nodeId) => (graph?.edges || []).filter((e) => e.from === nodeId),
    // buildWakeMessage 现读上游产物，依赖 getEdgesTo；mock 需提供该导出
    getEdgesTo: (graph, nodeId) => (graph?.edges || []).filter((e) => e.to === nodeId),
  },
});

mock.module("../lib/state.js", {
  namedExports: {
    dispatchTargetStateMap,
    OC: "/tmp/openclaw-test",
    QUEUE_STATE_FILE: "/tmp/openclaw-test/queue-state.json",
    atomicWriteFile: async () => {},
    withLock: withLockSpy,
  },
});

mock.module("../lib/routing/dispatch-runtime-state.js", {
  namedExports: {
    listDispatchTargetIds: () => [...dispatchTargetStateMap.keys()],
    hasDispatchTarget: (agentId) => dispatchTargetStateMap.has(agentId),
    ensureDispatchTargetAvailable: async (agentId) => dispatchTargetStateMap.has(agentId),
    isDispatchTargetBusy: (agentId) => {
      const s = dispatchTargetStateMap.get(agentId);
      return Boolean(s?.busy || s?.dispatching);
    },
    markDispatchTargetDispatching: (agentId, contractId) => {
      const s = dispatchTargetStateMap.get(agentId);
      if (!s) return false;
      if (s.busy || s.dispatching || s.currentContract) return false;
      s.dispatching = true;
      s.currentContract = contractId;
      return true;
    },
    rollbackDispatchTargetDispatch: (agentId) => {
      const s = dispatchTargetStateMap.get(agentId);
      if (!s) return false;
      s.dispatching = false;
      if (!s.busy) s.currentContract = null;
      return true;
    },
    claimDispatchTargetContract: async ({ contractId, agentId }) => {
      const s = dispatchTargetStateMap.get(agentId);
      if (!s) return false;
      s.queue = Array.isArray(s.queue)
        ? s.queue.filter((e) => normalizeEntry(agentId, e)?.contractId !== contractId)
        : [];
      s.busy = true;
      s.dispatching = false;
      s.currentContract = contractId;
      return true;
    },
    releaseDispatchTargetContract: async ({ agentId }) => {
      const s = dispatchTargetStateMap.get(agentId);
      if (!s) return false;
      s.busy = false;
      s.dispatching = false;
      s.currentContract = null;
      s.dispatchingQueueEntry = null;
      return true;
    },
    enqueueDispatchContract: (agentId, contractId, meta = {}) => {
      const s = dispatchTargetStateMap.get(agentId);
      if (!s) return false;
      s.queue = Array.isArray(s.queue) ? s.queue : [];
      const exists = s.queue.some((e) => normalizeEntry(agentId, e)?.contractId === contractId);
      if (!exists) s.queue.push({ contractId, fromAgent: meta?.fromAgent || null });
      return true;
    },
    dequeueDispatchContract: (agentId) => {
      const s = dispatchTargetStateMap.get(agentId);
      if (s?.dispatchingQueueEntry) return null;
      if (!s || !Array.isArray(s.queue) || s.queue.length === 0) return null;
      const entry = normalizeEntry(agentId, s.queue.shift());
      if (!entry) return null;
      s.dispatchingQueueEntry = entry;
      return entry;
    },
    requeueDispatchContractFront: async (agentId, entry) => {
      requeueCalls.push({ agentId, entry });
      const s = dispatchTargetStateMap.get(agentId);
      if (!s) return false;
      s.queue = Array.isArray(s.queue) ? s.queue : [];
      const normalized = normalizeEntry(agentId, entry);
      if (!normalized) return false;
      if (s.dispatchingQueueEntry?.contractId === normalized.contractId) {
        s.dispatchingQueueEntry = null;
      }
      if (s.queue.some((e) => normalizeEntry(agentId, e)?.contractId === normalized.contractId)) {
        return false;
      }
      s.queue.unshift({ contractId: normalized.contractId, fromAgent: normalized.fromAgent });
      return true;
    },
    getDispatchQueueDepth: (agentId) => {
      const s = dispatchTargetStateMap.get(agentId);
      return Array.isArray(s?.queue) ? s.queue.length : 0;
    },
    enqueueOutgoingDispatchContract: (agentId, contractId, meta = {}) => {
      const s = dispatchOutgoingStateMap.get(agentId) || { outgoingQueue: [] };
      s.outgoingQueue = Array.isArray(s.outgoingQueue) ? s.outgoingQueue : [];
      const entry = {
        contractId,
        targetAgent: meta?.targetAgent || null,
        status: meta?.status || "ready",
        routeEdge: meta?.routeEdge || null,
      };
      const existing = s.outgoingQueue.find((item) => item?.contractId === contractId);
      if (existing) Object.assign(existing, entry);
      else s.outgoingQueue.push(entry);
      dispatchOutgoingStateMap.set(agentId, s);
      return true;
    },
    removeOutgoingDispatchContract: async (agentId, contractId) => {
      const s = dispatchOutgoingStateMap.get(agentId);
      if (!s || !Array.isArray(s.outgoingQueue)) return false;
      s.outgoingQueue = s.outgoingQueue.filter((e) => e?.contractId !== contractId);
      if (s.outgoingQueue.length === 0) dispatchOutgoingStateMap.delete(agentId);
      return true;
    },
  },
});

mock.module("../lib/store/tracker-store.js", {
  namedExports: {
    waitForTrackingContractClaim: async () => claimWaitResult,
    deleteUnclaimedTrackingSessionForContract: (payload) => {
      unclaimedTrackingCleanupCalls.push(payload);
      return { removed: true };
    },
  },
});

mock.module("../lib/routing/dispatch-transport.js", {
  namedExports: {
    dispatchSendExecutionContract: async (...args) => {
      dispatchSharedCalls.push(args);
      return dispatchTransportResult;
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
      const dummy = { assignee: null, status: "draft" };
      fn(dummy);
      return { contract: dummy };
    },
    getContractPath: (id) => `/tmp/fake-contracts/${id}/contract.json`,
    readContractSnapshotById: async (id) => ({ id }), // FIX(A2-fanout-depth): dispatch path now reads the contract's hop counter
  },
});

mock.module("../lib/routing/runtime-authority.js", {
  namedExports: {
    hasRuntimeGraphBypassAuthority: () => false,
  },
});

mock.module("../lib/session-keys.js", {
  namedExports: {
    buildAgentContractSessionKey: (agentId, contractId) => `agent:${agentId}:contract:${contractId}`,
  },
});

// ── Import module under test ─────────────────────────────────────────────────

const { dispatchRouteExecutionContract } = await import(
  "../lib/routing/dispatch-graph-policy.js"
);

// ── Helpers ─────────────────────────────────────────────────────────────────

const logger = { info() {}, warn() {}, error() {} };
const api = {};

function resetState() {
  dispatchTargetStateMap.clear();
  dispatchOutgoingStateMap.clear();
  mockGraph = { edges: [] };
  dispatchSharedCalls.length = 0;
  requeueCalls.length = 0;
  unclaimedTrackingCleanupCalls.length = 0;
  withLockCalls.length = 0;
  claimWaitResult = { claimed: true };
  dispatchTransportResult = { ok: true };
}

function registerTarget(agentId, overrides = {}) {
  dispatchTargetStateMap.set(agentId, {
    busy: false,
    dispatching: false,
    currentContract: null,
    healthy: true,
    lastSeen: Date.now(),
    queue: [],
    ...overrides,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("dispatch-graph-policy TOCTOU: isAgentBusy+markBusy must be atomic", () => {
  beforeEach(resetState);

  test("(RED before fix) dispatch acquires per-agent claim lock", async () => {
    // This is the structural test: after fix, withLock must be called with
    // a per-agent claim key before the isAgentBusy+markBusy sequence.
    // Before fix: withLock is never called in dispatchSharedToAgent → test fails.
    // After fix: withLock("dispatch-target-claim:worker-lock") appears in withLockCalls.
    mockGraph = { edges: [{ from: "controller", to: "worker-lock" }] };
    registerTarget("worker-lock");

    await dispatchRouteExecutionContract("C-LOCK-1", "controller", "worker-lock", api, logger);

    const claimLockCalled = withLockCalls.some((key) =>
      typeof key === "string" && key.includes("worker-lock"),
    );

    assert.ok(
      claimLockCalled,
      `withLock was never called with a per-agent key containing "worker-lock". ` +
      `Calls recorded: ${JSON.stringify(withLockCalls)}. ` +
      `Fix: wrap isAgentBusy+markBusy in withLock("dispatch-target-claim:<targetAgent>").`,
    );
  });

  test("concurrent dispatch of different contracts: exactly one dispatched, one queued", async () => {
    mockGraph = { edges: [{ from: "controller", to: "worker-conc" }] };
    registerTarget("worker-conc");

    const [r1, r2] = await Promise.all([
      dispatchRouteExecutionContract("C-CONC-A", "controller", "worker-conc", api, logger),
      dispatchRouteExecutionContract("C-CONC-B", "controller", "worker-conc", api, logger),
    ]);

    const dispatched = [r1, r2].filter((r) => r.dispatched === true);
    const queued = [r1, r2].filter((r) => r.queued === true);

    assert.equal(dispatched.length, 1, `Expected exactly 1 dispatched, got ${dispatched.length}`);
    assert.equal(queued.length, 1, `Expected exactly 1 queued, got ${queued.length}`);
    assert.equal(dispatchSharedCalls.length, 1, `Transport should be called exactly once`);
  });

  test("busy agent: concurrent dispatches both queue without transport call", async () => {
    mockGraph = { edges: [{ from: "controller", to: "worker-busy" }] };
    registerTarget("worker-busy", { busy: true, currentContract: "C-OLD" });

    const [r1, r2] = await Promise.all([
      dispatchRouteExecutionContract("C-NEW-1", "controller", "worker-busy", api, logger),
      dispatchRouteExecutionContract("C-NEW-2", "controller", "worker-busy", api, logger),
    ]);

    assert.equal(r1.dispatched, false);
    assert.equal(r2.dispatched, false);
    assert.equal(r1.queued, true);
    assert.equal(r2.queued, true);
    assert.equal(dispatchSharedCalls.length, 0, "Transport must not be called when agent is busy");
  });
});
