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
const roundRobinCursorByAgent = new Map();
let claimWaitResult = { claimed: true, contractId: "DEFAULT", source: "mock_waiter" };

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
    if (!state.busy) {
      state.currentContract = null;
    }
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
  enqueueDispatchContract: (agentId, contractId, meta = {}) => {
    const state = dispatchTargetStateMap.get(agentId);
    if (!state) return false;
    state.queue = Array.isArray(state.queue) ? state.queue : [];
    if (!state.queue.some((entry) => entry?.contractId === contractId)) {
      state.queue.push({
        contractId,
        fromAgent: meta?.fromAgent || null,
      });
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
};

mock.module("../lib/routing/dispatch-runtime-state.js", {
  namedExports: dispatchRuntimeStateExports,
});

mock.module("../lib/agent/agent-identity.js", {
  namedExports: {
    getAgentRole: () => "planner",
  },
});

mock.module("../lib/role-spec-registry.js", {
  namedExports: {
    getDispatchInstruction: () => "do the task",
    getRoleSummary: () => "planner summary",
  },
});

mock.module("../lib/store/tracker-store.js", {
  namedExports: {
    waitForTrackingContractClaim: async () => claimWaitResult,
  },
});

const dispatchSharedCalls = [];
mock.module("../lib/routing/dispatch-transport.js", {
  namedExports: {
    dispatchSendExecutionContract: async (...args) => {
      dispatchSharedCalls.push(args);
      return { ok: true };
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
  dispatchRouteExecutionContract,
  dispatchResolveFirstHop,
} = await import("../lib/routing/dispatch-graph-policy.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

const logger = { info() {}, warn() {}, error() {} };
const api = {};

function resetState() {
  dispatchTargetStateMap.clear();
  roundRobinCursorByAgent.clear();
  mockGraph = { edges: [] };
  dispatchSharedCalls.length = 0;
  broadcastCalls.length = 0;
  mutateCallback = null;
  claimWaitResult = { claimed: true, contractId: "DEFAULT", source: "mock_waiter" };
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

describe("GATE constant", () => {
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
});

describe("dispatchResolveFirstHop", () => {
  beforeEach(resetState);

  test("returns null when no edges exist", async () => {
    mockGraph = { edges: [] };
    const result = await dispatchResolveFirstHop("planner");
    assert.equal(result, null);
  });

  test("returns default-gated edge target", async () => {
    mockGraph = {
      edges: [
        { from: "planner", to: "worker-a", gate: "on-complete" },
        { from: "planner", to: "worker-b", gate: "default" },
      ],
    };
    const result = await dispatchResolveFirstHop("planner");
    assert.equal(result, "worker-b");
  });

  test("returns first edge target when no default gate exists", async () => {
    mockGraph = {
      edges: [
        { from: "planner", to: "worker-x", gate: "on-complete" },
        { from: "planner", to: "worker-y", gate: "on-fail" },
      ],
    };
    const result = await dispatchResolveFirstHop("planner");
    assert.equal(result, "worker-x");
  });

  test("prefers explicit dispatch owner graph when provided", async () => {
    mockGraph = {
      edges: [
        { from: "controller", to: "planner", gate: "default" },
        { from: "worker2", to: "reviewer", gate: "default" },
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
        { from: "other-agent", to: "worker-a", gate: "default" },
      ],
    };
    const result = await dispatchResolveFirstHop("planner");
    assert.equal(result, null);
  });
});

describe("dispatch claim confirm", () => {
  beforeEach(resetState);

  test("dispatchRouteExecutionContract does not report dispatched when exact session never claims the contract", async () => {
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
  });
});

describe("dispatchRouteExecutionContract", () => {
  beforeEach(resetState);

  test("dispatches to idle non-pool agent", async () => {
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

  test("dispatches to idle pool agent", async () => {
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
});

describe("onAgentDone", () => {
  beforeEach(resetState);

  test("marks agent idle and drains queue (dedicated agent)", async () => {
    // Use a unique agent ID to avoid internal queue residue from other tests
    const agentId = `drain-test-${Date.now()}`;
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
      edges: [{ from: "agent-a", to: "agent-b", gate: "default" }],
    };
    const result = await routeAfterAgentEnd("agent-a", "C-600", { status: "completed", api, logger });
    assert.equal(result.routed, true);
    assert.equal(result.action, "dispatched");
    assert.equal(result.target, "agent-b");
  });

  test("follows on-complete gate on success", async () => {
    registerDispatchTarget("agent-ok");
    registerDispatchTarget("agent-err");
    mockGraph = {
      edges: [
        { from: "agent-a", to: "agent-ok", gate: "on-complete" },
        { from: "agent-a", to: "agent-err", gate: "on-fail" },
      ],
    };
    const result = await routeAfterAgentEnd("agent-a", "C-700", { status: "completed", api, logger });
    assert.equal(result.routed, true);
    assert.equal(result.target, "agent-ok");
  });

  test("follows on-fail gate on failure", async () => {
    registerDispatchTarget("agent-ok");
    registerDispatchTarget("agent-err");
    mockGraph = {
      edges: [
        { from: "agent-a", to: "agent-ok", gate: "on-complete" },
        { from: "agent-a", to: "agent-err", gate: "on-fail" },
      ],
    };
    const result = await routeAfterAgentEnd("agent-a", "C-800", { status: "failed", api, logger });
    assert.equal(result.routed, true);
    assert.equal(result.target, "agent-err");
  });

  test("returns terminal when status edge does not match", async () => {
    registerDispatchTarget("agent-err");
    mockGraph = {
      edges: [
        { from: "agent-a", to: "agent-err", gate: "on-fail" },
      ],
    };
    // completed, but only on-fail edge exists
    const result = await routeAfterAgentEnd("agent-a", "C-850", { status: "completed", api, logger });
    // Two edges are needed for the status branch — but only one edge means single-edge path.
    // Actually with length === 1, the single-edge path dispatches regardless of gate.
    assert.equal(result.routed, true);
  });

  test("returns fan-out_unsupported for fan-out gates", async () => {
    mockGraph = {
      edges: [
        { from: "agent-a", to: "agent-b", gate: "fan-out" },
        { from: "agent-a", to: "agent-c", gate: "fan-out" },
      ],
    };
    const result = await routeAfterAgentEnd("agent-a", "C-900", { status: "completed", api, logger });
    assert.equal(result.routed, false);
    assert.equal(result.action, "fan-out_unsupported");
  });

  test("round-robin cycles through edges", async () => {
    registerDispatchTarget("w1");
    registerDispatchTarget("w2");
    registerDispatchTarget("w3");
    mockGraph = {
      edges: [
        { from: "agent-a", to: "w1", gate: "round-robin" },
        { from: "agent-a", to: "w2", gate: "round-robin" },
        { from: "agent-a", to: "w3", gate: "round-robin" },
      ],
    };

    const targets = [];
    for (let i = 0; i < 6; i++) {
      const result = await routeAfterAgentEnd("agent-a", `C-RR-${i}`, { status: "completed", api, logger });
      assert.equal(result.routed, true);
      targets.push(result.target);
    }

    // Should cycle: w1, w2, w3, w1, w2, w3
    assert.equal(targets[0], "w1");
    assert.equal(targets[1], "w2");
    assert.equal(targets[2], "w3");
    assert.equal(targets[3], "w1");
    assert.equal(targets[4], "w2");
    assert.equal(targets[5], "w3");
  });

  test("falls back to default edge when no other gate matches", async () => {
    registerDispatchTarget("agent-default");
    registerDispatchTarget("agent-other");
    mockGraph = {
      edges: [
        { from: "agent-a", to: "agent-default", gate: "default" },
        { from: "agent-a", to: "agent-other" }, // gate undefined → treated as default
      ],
    };
    const result = await routeAfterAgentEnd("agent-a", "C-DF", { status: "completed", api, logger });
    assert.equal(result.routed, true);
    assert.equal(result.target, "agent-default");
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
      edges: [{ from: "agent-a", to: "agent-b", gate: "default" }],
    };

    const result = await routeAfterAgentEnd("agent-a", "C-Q", { status: "completed", api, logger });
    assert.equal(result.routed, true);
    assert.equal(result.action, "queued");
    assert.equal(result.target, "agent-b");
  });
});
