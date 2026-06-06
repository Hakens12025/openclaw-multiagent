/**
 * dispatch-graph-policy.test.js — Unit tests for lib/routing/dispatch-graph-policy.js
 *
 * Tests busy tracking, FIFO queuing, contract dispatch, and graph-edge routing.
 * Uses node:test mock.module to replace I/O dependencies with controlled stubs.
 *
 * Run: node --experimental-test-module-mocks --test tests/dispatch-graph-policy.test.js
 */

import { describe, test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// ── Mock setup (must come before importing the module under test) ───────────

// Controlled graph state — tests mutate this before calling router functions
let mockGraph = { edges: [] };
const dispatchTargetStateMap = new Map();
const dispatchOutgoingStateMap = new Map();
let claimWaitResult = { claimed: true, contractId: "DEFAULT", source: "mock_waiter" };
let dispatchTransportResult = { ok: true };
let rejectDispatchingClaimForAgent = null;
const outgoingWriteCalls = [];
const requeueCalls = [];
const unclaimedTrackingCleanupCalls = [];

function normalizeIncomingDispatchEntry(agentId, entry) {
  const source = typeof entry === "string" ? { contractId: entry } : (entry && typeof entry === "object" ? entry : {});
  if (!source.contractId) return null;
  return {
    contractId: source.contractId,
    fromAgent: source.fromAgent || null,
    targetAgent: agentId,
  };
}

mock.module("../lib/agent/agent-graph.js", {
  namedExports: {
    loadGraph: async () => mockGraph,
    detectCycles: () => [],
    hasDirectedEdge: (graph, from, to) =>
      (graph?.edges || []).some((edge) => edge.from === from && edge.to === to),
    getEdgesFrom: (graph, nodeId) =>
      (graph?.edges || []).filter((e) => e.from === nodeId),
    getEdgesTo: (graph, nodeId) =>
      (graph?.edges || []).filter((e) => e.to === nodeId),
  },
});

mock.module("../lib/state.js", {
  namedExports: {
    dispatchTargetStateMap,
    OC: "/tmp/openclaw-test",
    QUEUE_STATE_FILE: "/tmp/openclaw-test/queue-state.json",
    atomicWriteFile: async () => {},
    withLock: async (_key, fn) => fn(),
  },
});

const dispatchRuntimeStateExports = {
  listDispatchTargetIds: () => [...dispatchTargetStateMap.keys()],
  hasDispatchTarget: (agentId) => dispatchTargetStateMap.has(agentId),
  ensureDispatchTargetAvailable: async (agentId) => dispatchTargetStateMap.has(agentId),
  isDispatchTargetBusy: (agentId) => {
    const state = dispatchTargetStateMap.get(agentId);
    return Boolean(state?.busy || state?.dispatching);
  },
  markDispatchTargetDispatching: (agentId, contractId) => {
    if (agentId === rejectDispatchingClaimForAgent) {
      return false;
    }
    const state = dispatchTargetStateMap.get(agentId);
    if (!state) return false;
    if (state.busy || state.dispatching || state.currentContract) return false;
    state.dispatching = true;
    state.currentContract = contractId;
    return true;
  },
  rollbackDispatchTargetDispatch: (agentId) => {
    const state = dispatchTargetStateMap.get(agentId);
    if (!state) return false;
    state.dispatching = false;
    if (!state.busy) {
      state.currentContract = null;
    }
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
  enqueueDispatchContract: (agentId, contractId, meta = {}) => {
    const state = dispatchTargetStateMap.get(agentId);
    if (!state) return false;
    state.queue = Array.isArray(state.queue) ? state.queue : [];
    const existingLease = normalizeIncomingDispatchEntry(agentId, state.dispatchingQueueEntry);
    const exists = existingLease?.contractId === contractId || state.queue.some((entry) => (
      normalizeIncomingDispatchEntry(agentId, entry)?.contractId === contractId
    ));
    if (!exists) {
      state.queue.push({
        contractId,
        fromAgent: meta?.fromAgent || null,
      });
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
    requeueCalls.push({ agentId, entry });
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
    outgoingWriteCalls.push({
      agentId,
      contractId,
      targetAgent: meta?.targetAgent || null,
      status: meta?.status || "ready",
    });
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
};

mock.module("../lib/routing/dispatch-runtime-state.js", {
  namedExports: dispatchRuntimeStateExports,
});

mock.module("../lib/agent/agent-identity.js", {
  namedExports: {
    getAgentRole: (agentId) => {
      if (agentId === "controller") return "bridge";
      if (String(agentId || "").startsWith("worker")) return "executor";
      return "planner";
    },
  },
});

mock.module("../lib/role-spec-registry.js", {
  namedExports: {
    getRoleSummary: () => "planner summary",
  },
});

mock.module("../lib/store/tracker-store.js", {
  namedExports: {
    waitForTrackingContractClaim: async () => claimWaitResult,
    deleteUnclaimedTrackingSessionForContract: (payload) => {
      unclaimedTrackingCleanupCalls.push(payload);
      return {
        removed: true,
        reason: payload?.reason || "mock_cleanup",
      };
    },
  },
});

const dispatchSharedCalls = [];
mock.module("../lib/routing/dispatch-transport.js", {
  namedExports: {
    dispatchSendExecutionContract: async (...args) => {
      dispatchSharedCalls.push(args);
      return dispatchTransportResult;
    },
  },
});

const broadcastCalls = [];
mock.module("../lib/transport/sse.js", {
  namedExports: {
    broadcast: (...args) => {
      broadcastCalls.push(args);
    },
  },
});

let mutateCallback = null;
mock.module("../lib/contracts.js", {
  namedExports: {
    mutateContractSnapshot: async (_path, _logger, fn) => {
      // Call fn with a dummy contract so assignee logic runs
      const dummy = { assignee: null, status: "draft" };
      mutateCallback = fn;
      fn(dummy);
      return { contract: dummy };
    },
    getContractPath: (id) => `/tmp/fake-contracts/${id}/contract.json`,
    readContractSnapshotById: async (id) => ({
      id,
      task: `task:${id}`,
      output: `/tmp/${id}.md`,
    }),
  },
});

// ── Import module under test (after mocks are registered) ───────────────────

const {
  drainIdleDispatchTargets,
  markIdle,
  onAgentDone,
  routeAfterAgentEnd,
  resolveRouteAfterAgentEndTarget,
  dispatchRouteExecutionContract,
  dispatchResolveFirstHop,
} = await import("../lib/routing/dispatch-graph-policy.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

const logger = { info() {}, warn() {}, error() {} };
const api = {};

function resetState() {
  dispatchTargetStateMap.clear();
  dispatchOutgoingStateMap.clear();
  mockGraph = { edges: [] };
  dispatchSharedCalls.length = 0;
  broadcastCalls.length = 0;
  outgoingWriteCalls.length = 0;
  requeueCalls.length = 0;
  unclaimedTrackingCleanupCalls.length = 0;
  mutateCallback = null;
  claimWaitResult = { claimed: true, contractId: "DEFAULT", source: "mock_waiter" };
  dispatchTransportResult = { ok: true };
  rejectDispatchingClaimForAgent = null;
}

function registerDispatchTarget(agentId, overrides = {}) {
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("graph topology routing", () => {
  test("dispatch graph policy imports without error and exports expected functions", () => {
    assert.equal(typeof drainIdleDispatchTargets, "function");
    assert.equal(typeof markIdle, "function");
    assert.equal(typeof onAgentDone, "function");
    assert.equal(typeof routeAfterAgentEnd, "function");
    assert.equal(typeof dispatchRouteExecutionContract, "function");
    assert.equal(typeof dispatchResolveFirstHop, "function");
  });

  test("dispatch graph policy no longer declares local busy or queue owners", async () => {
    const source = await readFile(
      new URL("../lib/routing/dispatch-graph-policy.js", import.meta.url),
      "utf8",
    );

    assert.doesNotMatch(source, /const busyAgents = new Map/);
    assert.doesNotMatch(source, /const agentQueues = new Map/);
    assert.doesNotMatch(source, /const roundRobinIndex = new Map/);
    assert.doesNotMatch(source, /const GATE\b/);
    assert.doesNotMatch(source, /\.gate\b/);
    assert.match(source, /from "\.\/dispatch-runtime-state\.js"/);
  });
});

describe("markIdle", () => {
  beforeEach(resetState);

  test("releases dispatch target state to canonical idle", async () => {
    dispatchTargetStateMap.set("w1", {
      busy: true,
      dispatching: true,
      currentContract: "C-001",
      healthy: true,
      lastSeen: Date.now(),
      queue: [],
    });

    await markIdle("w1");

    const state = dispatchTargetStateMap.get("w1");
    assert.equal(state.busy, false);
    assert.equal(state.dispatching, false);
    assert.equal(state.currentContract, null);
  });

  test("is a no-op for unknown agents (no throw)", async () => {
    // Non-pool agent that was never tracked — should not throw
    await markIdle("unknown-agent");
    assert.equal(dispatchTargetStateMap.has("unknown-agent"), false);
  });
});

describe("drainIdleDispatchTargets", () => {
  beforeEach(resetState);

  test("dispatches recovered queued work for idle targets", async () => {
    mockGraph = { edges: [{ from: "controller", to: "planner" }] };
    registerDispatchTarget("planner", {
      busy: false,
      dispatching: false,
      currentContract: null,
      queue: [{ contractId: "TC-RECOVERED-1", fromAgent: "controller" }],
    });

    await drainIdleDispatchTargets(api, logger);

    assert.equal(dispatchSharedCalls.length, 1);
    assert.equal(dispatchSharedCalls[0][0]?.contractId, "TC-RECOVERED-1");
    const state = dispatchTargetStateMap.get("planner");
    assert.equal(state.busy, true);
    assert.equal(state.currentContract, "TC-RECOVERED-1");
    assert.deepEqual(state.queue, []);
  });

  test("keeps recovered queue entry when dispatch claim fails", async () => {
    mockGraph = { edges: [{ from: "controller", to: "planner" }] };
    registerDispatchTarget("planner", {
      busy: false,
      dispatching: false,
      currentContract: null,
      queue: [
        { contractId: "TC-RECOVERED-CLAIM-MISS", fromAgent: "controller" },
        { contractId: "TC-RECOVERED-NEXT", fromAgent: "controller" },
      ],
    });
    claimWaitResult = {
      claimed: false,
      contractId: "TC-RECOVERED-CLAIM-MISS",
      reason: "timeout",
    };

    await drainIdleDispatchTargets(api, logger);

    const state = dispatchTargetStateMap.get("planner");
    assert.equal(dispatchSharedCalls.length, 1);
    assert.equal(state.busy, false);
    assert.equal(state.dispatching, false);
    assert.equal(state.currentContract, null);
    assert.deepEqual(state.queue, [
      { contractId: "TC-RECOVERED-CLAIM-MISS", fromAgent: "controller" },
      { contractId: "TC-RECOVERED-NEXT", fromAgent: "controller" },
    ]);
  });

  test("keeps recovered queue entry when topology authorization is removed before drain", async () => {
    mockGraph = { edges: [] };
    registerDispatchTarget("planner", {
      busy: false,
      dispatching: false,
      currentContract: null,
      queue: [
        { contractId: "TC-RECOVERED-NO-EDGE", fromAgent: "controller" },
        { contractId: "TC-RECOVERED-NEXT", fromAgent: "controller" },
      ],
    });

    await drainIdleDispatchTargets(api, logger);

    const state = dispatchTargetStateMap.get("planner");
    assert.equal(dispatchSharedCalls.length, 0);
    assert.equal(state.busy, false);
    assert.equal(state.dispatching, false);
    assert.equal(state.currentContract, null);
    assert.deepEqual(state.queue, [
      { contractId: "TC-RECOVERED-NO-EDGE", fromAgent: "controller" },
      { contractId: "TC-RECOVERED-NEXT", fromAgent: "controller" },
    ]);
    assert.deepEqual(requeueCalls, [{
      agentId: "planner",
      entry: { contractId: "TC-RECOVERED-NO-EDGE", fromAgent: "controller", targetAgent: "planner" },
    }]);
  });

  test("concurrent recovered drains lease one queued contract once", async () => {
    mockGraph = { edges: [{ from: "controller", to: "planner" }] };
    registerDispatchTarget("planner", {
      busy: false,
      dispatching: false,
      currentContract: null,
      queue: [{ contractId: "TC-RECOVERED-LEASE", fromAgent: "controller" }],
    });

    await Promise.all([
      drainIdleDispatchTargets(api, logger),
      drainIdleDispatchTargets(api, logger),
    ]);

    const state = dispatchTargetStateMap.get("planner");
    assert.equal(dispatchSharedCalls.length, 1);
    assert.equal(state.busy, true);
    assert.equal(state.currentContract, "TC-RECOVERED-LEASE");
    assert.equal(state.dispatchingQueueEntry, null);
    assert.deepEqual(state.queue, []);
  });
});

describe("dispatchResolveFirstHop", () => {
  beforeEach(resetState);

  test("returns null when no edges exist", async () => {
    mockGraph = { edges: [] };
    const result = await dispatchResolveFirstHop("planner");
    assert.equal(result, null);
  });

  test("returns single edge target without reading display labels", async () => {
    mockGraph = {
      edges: [
        { from: "planner", to: "worker-a", label: "handoff" },
      ],
    };
    const result = await dispatchResolveFirstHop("planner");
    assert.equal(result, "worker-a");
  });

  test("returns null for ambiguous first-hop topology instead of preferring a labeled edge", async () => {
    mockGraph = {
      edges: [
        { from: "planner", to: "worker-x", label: "primary" },
        { from: "planner", to: "worker-y", label: "fallback" },
      ],
    };
    const result = await dispatchResolveFirstHop("planner");
    assert.equal(result, null);
  });

  test("prefers explicit dispatch owner graph when provided", async () => {
    mockGraph = {
      edges: [
        { from: "controller", to: "planner" },
        { from: "worker2", to: "reviewer" },
      ],
    };
    const result = await dispatchResolveFirstHop("controller", {
      dispatchOwnerAgentId: "worker2",
    });
    assert.equal(result, "reviewer");
  });

  test("ignores edges from other agents", async () => {
    mockGraph = {
      edges: [
        { from: "other-agent", to: "worker-a" },
      ],
    };
    const result = await dispatchResolveFirstHop("planner");
    assert.equal(result, null);
  });

  test("non-topology options do not skip planner when graph is controller -> planner -> worker", async () => {
    mockGraph = {
      edges: [
        { from: "controller", to: "planner" },
        { from: "planner", to: "worker" },
      ],
    };
    const result = await dispatchResolveFirstHop("controller", {
      metadata: { requestedTarget: "worker" },
    });
    assert.equal(result, "planner");
  });

  test("non-topology options still resolve the graph first hop", async () => {
    mockGraph = {
      edges: [
        { from: "controller", to: "planner" },
      ],
    };
    const result = await dispatchResolveFirstHop("controller", {
      metadata: { requestedTarget: "worker" },
    });
    assert.equal(result, "planner");
  });
});

describe("topology matrix", () => {
  beforeEach(resetState);

  test("follows a four-node chain without skipping intermediate agents", async () => {
    registerDispatchTarget("planner");
    registerDispatchTarget("worker");
    registerDispatchTarget("worker2");
    mockGraph = {
      edges: [
        { from: "controller", to: "planner" },
        { from: "planner", to: "worker" },
        { from: "worker", to: "worker2" },
      ],
    };

    assert.equal(await dispatchResolveFirstHop("controller"), "planner");

    const first = await routeAfterAgentEnd("controller", "C-MATRIX-CHAIN", { api, logger });
    const second = await routeAfterAgentEnd("planner", "C-MATRIX-CHAIN", { api, logger });
    const third = await routeAfterAgentEnd("worker", "C-MATRIX-CHAIN", { api, logger });

    assert.deepEqual(
      [first.target, second.target, third.target],
      ["planner", "worker", "worker2"],
    );
    assert.deepEqual(
      dispatchSharedCalls.map((call) => call[0]?.targetAgent),
      ["planner", "worker", "worker2"],
    );
  });

  test("supports a direct bridge-to-worker topology when the graph says so", async () => {
    registerDispatchTarget("worker");
    mockGraph = {
      edges: [
        { from: "controller", to: "worker" },
      ],
    };

    assert.equal(await dispatchResolveFirstHop("controller"), "worker");

    const result = await routeAfterAgentEnd("controller", "C-MATRIX-DIRECT", { api, logger });

    assert.equal(result.routed, true);
    assert.equal(result.target, "worker");
    assert.deepEqual(
      dispatchSharedCalls.map((call) => call[0]?.targetAgent),
      ["worker"],
    );
  });

  test("supports renamed agent ids and does not depend on role-shaped names", async () => {
    registerDispatchTarget("analyst-alpha");
    registerDispatchTarget("maker-beta");
    mockGraph = {
      edges: [
        { from: "frontdesk", to: "analyst-alpha" },
        { from: "analyst-alpha", to: "maker-beta" },
      ],
    };

    assert.equal(await dispatchResolveFirstHop("frontdesk"), "analyst-alpha");

    const first = await routeAfterAgentEnd("frontdesk", "C-MATRIX-NAMED", { api, logger });
    const second = await routeAfterAgentEnd("analyst-alpha", "C-MATRIX-NAMED", { api, logger });

    assert.deepEqual([first.target, second.target], ["analyst-alpha", "maker-beta"]);
    assert.deepEqual(
      dispatchSharedCalls.map((call) => call[0]?.targetAgent),
      ["analyst-alpha", "maker-beta"],
    );
  });

  test("ignores unrelated subgraphs while resolving the current source", async () => {
    registerDispatchTarget("worker");
    mockGraph = {
      edges: [
        { from: "controller", to: "worker" },
        { from: "loop-a", to: "loop-b" },
        { from: "loop-b", to: "loop-a" },
      ],
    };

    const result = await routeAfterAgentEnd("controller", "C-MATRIX-SUBGRAPH", { api, logger });

    assert.equal(result.routed, true);
    assert.equal(result.target, "worker");
    assert.deepEqual(
      dispatchSharedCalls.map((call) => call[0]?.targetAgent),
      ["worker"],
    );
  });

  test("treats changed topology with multiple out-edges as ambiguous instead of guessing", async () => {
    registerDispatchTarget("planner");
    registerDispatchTarget("worker");
    mockGraph = {
      edges: [
        { from: "controller", to: "planner" },
        { from: "controller", to: "worker" },
      ],
    };

    assert.equal(await dispatchResolveFirstHop("controller"), null);

    const result = await routeAfterAgentEnd("controller", "C-MATRIX-AMBIGUOUS", { api, logger });

    assert.equal(result.routed, false);
    assert.equal(result.action, "ambiguous_runtime_transition");
    assert.equal(dispatchSharedCalls.length, 0);
  });
});

describe("dispatch claim confirm", () => {
  beforeEach(resetState);

  test("dispatchRouteExecutionContract does not report dispatched when exact session never claims the contract", async () => {
    mockGraph = { edges: [{ from: "controller", to: "planner-target" }] };
    registerDispatchTarget("planner-target");
    claimWaitResult = {
      claimed: false,
      contractId: "C-CLAIM-MISS",
      reason: "timeout",
    };

    const result = await dispatchRouteExecutionContract(
      "C-CLAIM-MISS",
      "controller",
      "planner-target",
      api,
      logger,
    );

    assert.equal(result.dispatched, false);
    assert.equal(result.failed, true);
    assert.equal(result.claimed, false);
    assert.equal(result.claimReason, "timeout");
    assert.deepEqual(unclaimedTrackingCleanupCalls, [{
      sessionKey: "agent:planner-target:contract:C-CLAIM-MISS",
      contractId: "C-CLAIM-MISS",
      agentId: "planner-target",
      reason: "dispatch_claim_timeout",
    }]);
    assert.ok(
      broadcastCalls.some((call) => (
        call[0] === "alert"
        && call[1]?.type === "dispatch_claim_timeout"
        && call[1]?.contractId === "C-CLAIM-MISS"
      )),
      "claim timeout should emit runtime-visible diagnostics",
    );
  });
});

describe("dispatchRouteExecutionContract", () => {
  beforeEach(resetState);

  test("dispatches to idle non-pool agent", async () => {
    mockGraph = { edges: [{ from: "external", to: "planner" }] };
    dispatchTargetStateMap.set("planner", {
      busy: false,
      dispatching: false,
      currentContract: null,
      healthy: true,
      lastSeen: Date.now(),
      queue: [],
    });
    const result = await dispatchRouteExecutionContract("C-100", "external", "planner", api, logger);
    assert.equal(result.dispatched, true);
    assert.equal(result.queued, false);
    assert.equal(dispatchSharedCalls.length, 1);
    assert.equal(dispatchSharedCalls[0][0]?.targetAgent, "planner");
  });

  test("preserves wake diagnostics from transport on successful dispatch", async () => {
    mockGraph = { edges: [{ from: "external", to: "planner" }] };
    registerDispatchTarget("planner");
    dispatchTransportResult = {
      ok: true,
      wake: {
        ok: true,
        mode: "heartbeat",
        targetAgent: "planner",
      },
    };

    const result = await dispatchRouteExecutionContract("C-WAKE", "external", "planner", api, logger);

    assert.equal(result.dispatched, true);
    assert.deepEqual(result.wake, {
      ok: true,
      mode: "heartbeat",
      targetAgent: "planner",
    });
  });

  test("dispatches to idle pool agent", async () => {
    mockGraph = { edges: [{ from: "planner", to: "w1" }] };
    dispatchTargetStateMap.set("w1", {
      busy: false,
      dispatching: false,
      currentContract: null,
      healthy: true,
      lastSeen: Date.now(),
      queue: [],
    });

    const result = await dispatchRouteExecutionContract("C-200", "planner", "w1", api, logger);
    assert.equal(result.dispatched, true);
    assert.equal(result.queued, false);
    assert.equal(result.claimed, true);

    // After claim-confirm, target should be canonical busy instead of transient dispatching.
    const ws = dispatchTargetStateMap.get("w1");
    assert.equal(ws.busy, true);
    assert.equal(ws.dispatching, false);
    assert.equal(ws.currentContract, "C-200");
  });

  test("queues when pool agent is busy", async () => {
    mockGraph = { edges: [{ from: "planner", to: "w1" }] };
    dispatchTargetStateMap.set("w1", {
      busy: true,
      dispatching: false,
      currentContract: "C-EXISTING",
      healthy: true,
      lastSeen: Date.now(),
      queue: [],
    });

    const result = await dispatchRouteExecutionContract("C-300", "planner", "w1", api, logger);
    assert.equal(result.dispatched, false);
    assert.equal(result.queued, true);
  });

  test("queues when pool agent is dispatching", async () => {
    mockGraph = { edges: [{ from: "planner", to: "w1" }] };
    dispatchTargetStateMap.set("w1", {
      busy: false,
      dispatching: true,
      currentContract: "C-EXISTING",
      healthy: true,
      lastSeen: Date.now(),
      queue: [],
    });

    const result = await dispatchRouteExecutionContract("C-400", "planner", "w1", api, logger);
    assert.equal(result.dispatched, false);
    assert.equal(result.queued, true);
  });

  test("queues instead of dispatching when the target dispatch claim is lost", async () => {
    mockGraph = { edges: [{ from: "planner", to: "w1" }] };
    registerDispatchTarget("w1");
    rejectDispatchingClaimForAgent = "w1";

    const result = await dispatchRouteExecutionContract("C-CLAIM-RACE", "planner", "w1", api, logger);

    assert.equal(result.dispatched, false);
    assert.equal(result.queued, true);
    assert.equal(dispatchSharedCalls.length, 0);
    assert.deepEqual(dispatchTargetStateMap.get("w1").queue, [{
      contractId: "C-CLAIM-RACE",
      fromAgent: "planner",
    }]);
  });

  test("forwards custom wakeupFunc through formal dispatch path", async () => {
    mockGraph = { edges: [{ from: "system", to: "worker-loop" }] };
    registerDispatchTarget("worker-loop");
    const wakeupFunc = async () => ({ ok: true, mode: "test" });

    await dispatchRouteExecutionContract(
      "C-401",
      "system",
      "worker-loop",
      null,
      logger,
      { wakeupFunc },
    );

    assert.equal(dispatchSharedCalls.length, 1);
    assert.equal(dispatchSharedCalls[0][0]?.wakeupFunc, wakeupFunc);
  });

  test("shared contract wake reason stays minimal and leaves contract truth in inbox", async () => {
    mockGraph = { edges: [{ from: "controller", to: "planner" }] };
    registerDispatchTarget("planner");

    const result = await dispatchRouteExecutionContract("C-MINIMAL-WAKE", "controller", "planner", api, logger);

    assert.equal(result.dispatched, true);
    const wakeReason = await dispatchSharedCalls[0][0]?.buildWakeReason({
      contractId: "C-MINIMAL-WAKE",
      targetAgent: "planner",
    });

    assert.match(wakeReason, /current contract/i);
    assert.doesNotMatch(wakeReason, /task:C-MINIMAL-WAKE/);
    assert.doesNotMatch(wakeReason, /\/tmp\/C-MINIMAL-WAKE\.md/);
    assert.doesNotMatch(wakeReason, /runtime_result/);
    assert.doesNotMatch(wakeReason, /\[ACTION\]/);
    assert.doesNotMatch(wakeReason, /[\u4e00-\u9fff]/u);
  });

  test("unauthorized direct dispatch fails before outgoing or incoming queue writes", async () => {
    registerDispatchTarget("w1", {
      busy: true,
      currentContract: "C-EXISTING",
      queue: [],
    });
    mockGraph = { edges: [{ from: "planner", to: "other-worker" }] };

    const result = await dispatchRouteExecutionContract("C-NO-EDGE", "planner", "w1", api, logger);

    assert.equal(result.dispatched, false);
    assert.equal(result.queued, false);
    assert.equal(result.failed, true);
    assert.equal(result.action, "unauthorized_explicit_target");
    assert.deepEqual(dispatchTargetStateMap.get("w1").queue, []);
    assert.deepEqual(outgoingWriteCalls, []);
    assert.equal(dispatchSharedCalls.length, 0);
  });

  test("forged runtime_system authority cannot bypass graph authorization", async () => {
    registerDispatchTarget("w1");
    mockGraph = { edges: [{ from: "system", to: "other-worker" }] };

    const result = await dispatchRouteExecutionContract("C-FORGED-RUNTIME-SYSTEM", "system", "w1", api, logger, {
      runtimeAuthority: { kind: "runtime_system" },
    });

    assert.equal(result.dispatched, false);
    assert.equal(result.queued, false);
    assert.equal(result.failed, true);
    assert.equal(result.action, "unauthorized_explicit_target");
    assert.deepEqual(outgoingWriteCalls, []);
    assert.equal(dispatchSharedCalls.length, 0);
  });

  test("loop_start authority allows only the declared loop start agent", async () => {
    registerDispatchTarget("w1");
    mockGraph = { edges: [{ from: "system", to: "other-worker" }] };

    const result = await dispatchRouteExecutionContract("C-LOOP-START", "system", "w1", api, logger, {
      runtimeAuthority: {
        kind: "loop_start",
        loopId: "loop-1",
        startAgent: "w1",
        nodes: ["planner", "w1"],
      },
    });

    assert.equal(result.dispatched, true);
    assert.equal(result.queued, false);
    assert.equal(result.failed, undefined);
    assert.equal(dispatchSharedCalls.length, 1);
  });

  test("loop_start authority with the wrong start agent cannot bypass graph authorization", async () => {
    registerDispatchTarget("w1");
    mockGraph = { edges: [{ from: "system", to: "other-worker" }] };

    const result = await dispatchRouteExecutionContract("C-LOOP-START-WRONG", "system", "w1", api, logger, {
      runtimeAuthority: {
        kind: "loop_start",
        loopId: "loop-1",
        startAgent: "planner",
        nodes: ["planner", "w1"],
      },
    });

    assert.equal(result.dispatched, false);
    assert.equal(result.queued, false);
    assert.equal(result.failed, true);
    assert.equal(result.action, "unauthorized_explicit_target");
    assert.deepEqual(outgoingWriteCalls, []);
    assert.equal(dispatchSharedCalls.length, 0);
  });
});

describe("onAgentDone", () => {
  beforeEach(resetState);

  test("marks agent idle and drains queue (dedicated agent)", async () => {
    mockGraph = { edges: [{ from: "planner", to: `drain-test-${Date.now()}` }] };
    // Use a unique agent ID to avoid internal queue residue from other tests
    const agentId = mockGraph.edges[0].to;
    dispatchTargetStateMap.set(agentId, {
      busy: false,
      dispatching: true,
      currentContract: "C-OLD",
      healthy: true,
      lastSeen: Date.now(),
      queue: [],
    });

    // Enqueue a contract behind the busy agent
    const r1 = await dispatchRouteExecutionContract("C-DRAIN", "planner", agentId, api, logger);
    assert.equal(r1.queued, true);

    // Simulate agent done — should release + dispatch queued contract
    dispatchSharedCalls.length = 0;
    await onAgentDone(agentId, api, logger);

    const ws = dispatchTargetStateMap.get(agentId);
    // After drain + claim-confirm, the worker should be busy on the next contract.
    assert.equal(ws.busy, true);
    assert.equal(ws.dispatching, false);
    assert.equal(ws.currentContract, "C-DRAIN");
    assert.equal(dispatchSharedCalls.length, 1);
  });

  test("marks idle with no queue — no dispatch (dedicated agent)", async () => {
    const agentId = `idle-test-${Date.now()}`;
    dispatchTargetStateMap.set(agentId, {
      busy: false,
      dispatching: true,
      currentContract: "C-OLD",
      healthy: true,
      lastSeen: Date.now(),
      queue: [],
    });

    dispatchSharedCalls.length = 0;
    await onAgentDone(agentId, api, logger);

    const ws = dispatchTargetStateMap.get(agentId);
    assert.equal(ws.busy, false);
    assert.equal(ws.dispatching, false);
    assert.equal(ws.currentContract, null);
    assert.equal(dispatchSharedCalls.length, 0);
  });

  test("keeps drained queue entry when dispatch claim fails", async () => {
    const agentId = `drain-claim-fail-${Date.now()}`;
    mockGraph = { edges: [{ from: "controller", to: agentId }] };
    registerDispatchTarget(agentId, {
      busy: false,
      dispatching: false,
      currentContract: null,
      queue: [
        { contractId: "C-DRAIN-CLAIM-MISS", fromAgent: "controller" },
        { contractId: "C-DRAIN-NEXT", fromAgent: "controller" },
      ],
    });
    claimWaitResult = {
      claimed: false,
      contractId: "C-DRAIN-CLAIM-MISS",
      reason: "timeout",
    };

    await onAgentDone(agentId, api, logger);

    const state = dispatchTargetStateMap.get(agentId);
    assert.equal(dispatchSharedCalls.length, 1);
    assert.equal(state.busy, false);
    assert.equal(state.dispatching, false);
    assert.equal(state.currentContract, null);
    assert.deepEqual(state.queue, [
      { contractId: "C-DRAIN-CLAIM-MISS", fromAgent: "controller" },
      { contractId: "C-DRAIN-NEXT", fromAgent: "controller" },
    ]);
    assert.deepEqual(requeueCalls, [
      {
        agentId,
        entry: { contractId: "C-DRAIN-CLAIM-MISS", fromAgent: "controller", targetAgent: agentId },
      },
    ]);
  });
});

describe("routeAfterAgentEnd", () => {
  beforeEach(resetState);

  test("returns terminal when no edges exist", async () => {
    mockGraph = { edges: [] };
    const result = await routeAfterAgentEnd("agent-a", "C-500", { status: "completed", api, logger });
    assert.equal(result.routed, false);
    assert.equal(result.action, "terminal");
  });

  test("dispatches on single out-edge", async () => {
    registerDispatchTarget("agent-b");
    mockGraph = {
      edges: [{ from: "agent-a", to: "agent-b" }],
    };
    const result = await routeAfterAgentEnd("agent-a", "C-600", { status: "completed", api, logger });
    assert.equal(result.routed, true);
    assert.equal(result.action, "dispatched");
    assert.equal(result.target, "agent-b");
    assert.deepEqual(outgoingWriteCalls, [
      {
        agentId: "agent-a",
        contractId: "C-600",
        targetAgent: "agent-b",
        status: "dispatching",
      },
    ]);
  });

  test("single edge dispatch ignores display labels", async () => {
    registerDispatchTarget("agent-ok");
    mockGraph = {
      edges: [
        { from: "agent-a", to: "agent-ok", label: "handoff" },
      ],
    };
    const result = await routeAfterAgentEnd("agent-a", "C-700", { status: "failed", api, logger });
    assert.equal(result.routed, true);
    assert.equal(result.target, "agent-ok");
  });

  test("multiple labeled edges are ambiguous topology, not status branches", async () => {
    registerDispatchTarget("agent-ok");
    registerDispatchTarget("agent-err");
    mockGraph = {
      edges: [
        { from: "agent-a", to: "agent-ok", label: "success path" },
        { from: "agent-a", to: "agent-err", label: "failure path" },
      ],
    };
    const completed = await resolveRouteAfterAgentEndTarget("agent-a", { status: "completed" });
    const failed = await resolveRouteAfterAgentEndTarget("agent-a", { status: "failed" });

    assert.deepEqual(completed, { routable: false, action: "ambiguous_runtime_transition", target: null });
    assert.deepEqual(failed, { routable: false, action: "ambiguous_runtime_transition", target: null });
  });

  test("single outgoing edge routes regardless of terminal status", async () => {
    registerDispatchTarget("agent-err");
    mockGraph = {
      edges: [
        { from: "agent-a", to: "agent-err", label: "next" },
      ],
    };
    const result = await routeAfterAgentEnd("agent-a", "C-850", { status: "completed", api, logger });
    assert.equal(result.routed, true);
  });

  test("multiple same-label edges stay ambiguous topology", async () => {
    mockGraph = {
      edges: [
        { from: "agent-a", to: "agent-b", label: "parallel" },
        { from: "agent-a", to: "agent-c", label: "parallel" },
      ],
    };
    const result = await routeAfterAgentEnd("agent-a", "C-900", { status: "completed", api, logger });
    assert.equal(result.routed, false);
    assert.equal(result.action, "ambiguous_runtime_transition");
  });

  test("explicit target cannot bypass graph authorization", async () => {
    registerDispatchTarget("agent-c");
    mockGraph = {
      edges: [
        { from: "agent-a", to: "agent-b" },
      ],
    };

    const resolved = await resolveRouteAfterAgentEndTarget("agent-a", {
      status: "completed",
      targetAgent: "agent-c",
    });
    const result = await routeAfterAgentEnd("agent-a", "C-EXPLICIT-BYPASS", {
      status: "completed",
      targetAgent: "agent-c",
      api,
      logger,
    });

    assert.deepEqual(resolved, {
      routable: false,
      action: "unauthorized_explicit_target",
      target: "agent-c",
    });
    assert.equal(result.routed, false);
    assert.equal(result.action, "unauthorized_explicit_target");
    assert.equal(dispatchSharedCalls.length, 0);
  });

  test("explicit target is accepted when it matches a graph edge", async () => {
    registerDispatchTarget("agent-b");
    mockGraph = {
      edges: [
        { from: "agent-a", to: "agent-b" },
        { from: "agent-a", to: "agent-c" },
      ],
    };

    const result = await routeAfterAgentEnd("agent-a", "C-EXPLICIT-AUTHORIZED", {
      status: "completed",
      targetAgent: "agent-b",
      api,
      logger,
    });

    assert.equal(result.routed, true);
    assert.equal(result.target, "agent-b");
    assert.deepEqual(
      dispatchSharedCalls.map((call) => call[0]?.targetAgent),
      ["agent-b"],
    );
  });

  test("multiple worker edges stay ambiguous topology", async () => {
    registerDispatchTarget("w1");
    registerDispatchTarget("w2");
    registerDispatchTarget("w3");
    mockGraph = {
      edges: [
        { from: "agent-a", to: "w1", label: "candidate" },
        { from: "agent-a", to: "w2", label: "candidate" },
        { from: "agent-a", to: "w3", label: "candidate" },
      ],
    };

    const result = await routeAfterAgentEnd("agent-a", "C-RR", { status: "completed", api, logger });
    assert.equal(result.routed, false);
    assert.equal(result.action, "ambiguous_runtime_transition");
    assert.equal(dispatchSharedCalls.length, 0);
  });

  test("unlabeled and labeled edges keep multiple-edge ambiguity", async () => {
    registerDispatchTarget("agent-default");
    registerDispatchTarget("agent-other");
    mockGraph = {
      edges: [
        { from: "agent-a", to: "agent-default", label: "default" },
        { from: "agent-a", to: "agent-other" },
      ],
    };
    const result = await routeAfterAgentEnd("agent-a", "C-DF", { status: "completed", api, logger });
    assert.equal(result.routed, false);
    assert.equal(result.action, "ambiguous_runtime_transition");
  });

  test("queues contract when target is busy", async () => {
    dispatchTargetStateMap.set("agent-b", {
      busy: true,
      dispatching: false,
      currentContract: "C-PREV",
      healthy: true,
      lastSeen: Date.now(),
      queue: [],
    });
    mockGraph = {
      edges: [{ from: "agent-a", to: "agent-b" }],
    };

    const result = await routeAfterAgentEnd("agent-a", "C-Q", { status: "completed", api, logger });
    assert.equal(result.routed, true);
    assert.equal(result.action, "queued");
    assert.equal(result.target, "agent-b");
    assert.deepEqual(outgoingWriteCalls, [
      {
        agentId: "agent-a",
        contractId: "C-Q",
        targetAgent: "agent-b",
        status: "dispatching",
      },
    ]);
  });
});
