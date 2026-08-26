/**
 * agent-group-dispatch-redline.test.js — AgentGroup 宏的红线锁定。
 *
 * 红线（不可违）：
 *   ① 组内边是显式 EdgeSpec 带 groupId，经既有 graph 授权（无边即拒）——
 *      没有 group-internal 免授权暗门。
 *   ② 不造新 transport：展开的边走既有 dispatch（dispatchRouteExecutionContract），
 *      dispatcher 完全感知不到「这条边来自 group」——只看 EdgeSpec。
 *   ③ 成员态推进与出组判定是纯函数：aggregate 等齐 / race 先得，均无 IO、可单测。
 *
 * 复用 dispatch-graph-policy.test.js 的 mock 骨架：mock.module 替 IO，受控 graph。
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { expandAgentGroup } from "../lib/agent/agent-group-spec.js";
import {
  normalizeGroupSessionEntry,
  applyMemberCompletion,
  isGroupAggregateSatisfied,
  pickGroupRaceWinner,
} from "../lib/agent/group-session-normalize.js";

// ── 受控 graph + dispatch runtime mock（与 dispatch-graph-policy.test.js 同骨架）──

let mockGraph = { edges: [] };
const dispatchTargetStateMap = new Map();
const dispatchOutgoingStateMap = new Map();
const dispatchSharedCalls = [];
const loadGraphCalls = [];
let claimWaitResult = { claimed: true, contractId: "DEFAULT", source: "mock" };

function normalizeIncoming(agentId, entry) {
  const src = typeof entry === "string" ? { contractId: entry } : (entry && typeof entry === "object" ? entry : {});
  if (!src.contractId) return null;
  return { contractId: src.contractId, fromAgent: src.fromAgent || null, targetAgent: agentId };
}

const { mock } = await import("node:test");

mock.module("../lib/agent/agent-graph.js", {
  namedExports: {
    // loadGraph 是 dispatcher 唯一的授权真值源 —— 记录每次调用证明 dispatcher
    // 只问 graph，从不读 group。
    loadGraph: async () => { loadGraphCalls.push(Date.now()); return mockGraph; },
    detectCycles: () => [],
    getEdgesFrom: (graph, nodeId) => (graph?.edges || []).filter((e) => e.from === nodeId),
    getEdgesTo: (graph, nodeId) => (graph?.edges || []).filter((e) => e.to === nodeId),
    hasDirectedEdge: (graph, from, to) => (graph?.edges || []).some((e) => e.from === from && e.to === to),
    // 与真实实现同形:标了 pipeline 的边优先,一条都没标时全部边都是候选。
    getPipelineEdgesFrom: (graph, nodeId) => {
      const edges = (graph?.edges || []).filter((e) => e.from === nodeId);
      const marked = edges.filter((e) => e.metadata?.pipeline === true);
      return marked.length > 0 ? marked : edges;
    },
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

mock.module("../lib/routing/dispatch/dispatch-runtime-state.js", {
  namedExports: {
    listDispatchTargetIds: () => [...dispatchTargetStateMap.keys()],
    hasDispatchTarget: (a) => dispatchTargetStateMap.has(a),
    ensureDispatchTargetAvailable: async (a) => dispatchTargetStateMap.has(a),
    isDispatchTargetBusy: (a) => { const s = dispatchTargetStateMap.get(a); return Boolean(s?.busy || s?.dispatching); },
    markDispatchTargetDispatching: (a, c) => {
      const s = dispatchTargetStateMap.get(a);
      if (!s || s.busy || s.dispatching || s.currentContract) return false;
      s.dispatching = true; s.currentContract = c; return true;
    },
    rollbackDispatchTargetDispatch: (a) => { const s = dispatchTargetStateMap.get(a); if (!s) return false; s.dispatching = false; if (!s.busy) s.currentContract = null; return true; },
    claimDispatchTargetContract: async ({ contractId, agentId }) => { const s = dispatchTargetStateMap.get(agentId); if (!s) return false; s.busy = true; s.dispatching = false; s.currentContract = contractId; return true; },
    releaseDispatchTargetContract: async ({ agentId }) => { const s = dispatchTargetStateMap.get(agentId); if (!s) return false; s.busy = false; s.dispatching = false; s.currentContract = null; return true; },
    enqueueDispatchContract: (a, c, meta = {}) => { const s = dispatchTargetStateMap.get(a); if (!s) return false; s.queue = s.queue || []; s.queue.push({ contractId: c, fromAgent: meta?.fromAgent || null }); return true; },
    dequeueDispatchContract: () => null,
    requeueDispatchContractFront: async () => true,
    getDispatchQueueDepth: (a) => (dispatchTargetStateMap.get(a)?.queue?.length || 0),
    enqueueOutgoingDispatchContract: (a, c, meta = {}) => {
      const s = dispatchOutgoingStateMap.get(a) || { outgoingQueue: [] };
      s.outgoingQueue.push({ contractId: c, targetAgent: meta?.targetAgent || null, status: meta?.status || "ready" });
      dispatchOutgoingStateMap.set(a, s); return true;
    },
    removeOutgoingDispatchContract: async () => true,
  },
});

mock.module("../lib/store/tracker-store.js", {
  namedExports: {
    waitForTrackingContractClaim: async () => claimWaitResult,
    deleteUnclaimedTrackingSessionForContract: () => ({ removed: true }),
  },
});

mock.module("../lib/routing/dispatch/dispatch-transport.js", {
  namedExports: {
    dispatchSendExecutionContract: async (...args) => { dispatchSharedCalls.push(args); return { ok: true }; },
  },
});

mock.module("../lib/transport/sse.js", { namedExports: { broadcast: () => {} } });

mock.module("../lib/contract/contracts.js", {
  namedExports: {
    mutateContractSnapshot: async (_p, _l, fn) => { const dummy = { assignee: null, status: "draft" }; fn(dummy); return { contract: dummy }; },
    mutateContractById: async (_id, _l, fn) => { const dummy = { assignee: null, status: "draft" }; fn(dummy); return { contract: dummy }; },
    getContractPath: (id) => `/tmp/fake/${id}/contract.json`,
    readContractSnapshotById: async (id) => ({ id }), // FIX(A2-fanout-depth): dispatch path now reads the contract's hop counter
  },
});

const { dispatchRouteExecutionContract } = await import("../lib/routing/dispatch/dispatch-graph-policy.js");

const logger = { info() {}, warn() {}, error() {} };
const api = {};

function reset() {
  dispatchTargetStateMap.clear();
  dispatchOutgoingStateMap.clear();
  mockGraph = { edges: [] };
  dispatchSharedCalls.length = 0;
  loadGraphCalls.length = 0;
  claimWaitResult = { claimed: true, contractId: "DEFAULT", source: "mock" };
}

function registerTarget(agentId) {
  dispatchTargetStateMap.set(agentId, { busy: false, dispatching: false, currentContract: null, healthy: true, lastSeen: Date.now(), queue: [] });
}

// ── 红线 ① + ②：展开边经既有 graph 授权，无暗门，dispatcher 不读 group ─────────

describe("AgentGroup red line: expanded edges go through existing graph auth", () => {
  beforeEach(reset);

  test("group-internal expanded edge IS authorized once merged into graph (explicit EdgeSpec)", async () => {
    const { edges } = expandAgentGroup({
      id: "review-team",
      members: ["r1", "r2"],
      entry: "r1",
      internalEdges: [{ from: "r1", to: "r2" }],
      outputMode: "passthrough",
    });
    // 展开的边和普通 edge 平等进 graph —— 不另起 loader，不持久化回 graph.json。
    mockGraph = { edges };
    registerTarget("r2");

    const result = await dispatchRouteExecutionContract("C-GROUP-INTERNAL", "r1", "r2", api, logger);

    assert.equal(result.dispatched, true, "声明过的组内边应经 graph 授权放行");
    assert.equal(dispatchSharedCalls.length, 1);
    assert.equal(dispatchSharedCalls[0][0]?.targetAgent, "r2");
    // dispatcher 经 loadGraph 取授权真值（不读 group / groupId）
    assert.ok(loadGraphCalls.length >= 1, "dispatcher 必须经 loadGraph 授权");
  });

  test("RED LINE: two group members WITHOUT a declared internal edge are REJECTED (no group bypass)", async () => {
    // group 有 3 成员，但只声明了 r1→r2 一条内部边。r1→r3 没声明 ⇒ 不存在「同组就免授权」暗门。
    const { edges } = expandAgentGroup({
      id: "g",
      members: ["r1", "r2", "r3"],
      entry: "r1",
      internalEdges: [{ from: "r1", to: "r2" }],
      outputMode: "passthrough",
    });
    mockGraph = { edges };
    registerTarget("r3");

    const result = await dispatchRouteExecutionContract("C-NO-INTERNAL-EDGE", "r1", "r3", api, logger);

    assert.equal(result.dispatched, false, "未声明的组内 hop 不得放行");
    assert.equal(result.failed, true);
    assert.equal(result.action, "unauthorized_explicit_target", "无边即拒，无 group-internal 暗门");
    assert.equal(dispatchSharedCalls.length, 0, "未授权不得触达 transport");
  });

  test("RED LINE: groupId metadata does NOT influence authorization (dispatcher is group-agnostic)", async () => {
    // 构造两条边：声明边 a→b（带 groupId），以及一条仅靠 metadata.groupId 标注但
    // from/to 指向未声明目标的尝试。授权只认 from→to，不认 groupId。
    const { edges } = expandAgentGroup({
      id: "team",
      members: ["a", "b"],
      entry: "a",
      internalEdges: [{ from: "a", to: "b" }],
      outputMode: "aggregate",
    });
    // 确认展开边确实带 groupId（诊断用，不参与授权）
    assert.equal(edges[0].metadata.groupId, "team");
    mockGraph = { edges };
    registerTarget("b");
    registerTarget("c");

    // a→b 授权（有边）
    const ok = await dispatchRouteExecutionContract("C-OK", "a", "b", api, logger);
    assert.equal(ok.dispatched, true);

    // a→c 无边（即便同属一个 group 概念，没声明边就是拒）
    reset();
    mockGraph = { edges };
    registerTarget("c");
    const blocked = await dispatchRouteExecutionContract("C-BLOCK", "a", "c", api, logger);
    assert.equal(blocked.action, "unauthorized_explicit_target");
  });
});

// ── 红线 ③：成员态推进与出组判定（纯函数）────────────────────────────────────

// 注：本文件 mock 了 state.js（withLock/atomicWriteFile no-op），故 group-session-store
// 的 IO 路径在此不可用。三模式语义用 group-session-normalize 纯函数验证（无 IO，
// 不受 mock 影响）；store 的真实 IO round-trip 在 group-session-store.test.js 已覆盖。
describe("AgentGroup member-state advancement (pure)", () => {
  test("aggregate mode: the group only clears once every member completed", () => {
    let session = normalizeGroupSessionEntry({
      id: "GS-nest",
      groupId: "stage-review",
      members: ["rev-a", "rev-b"],
      entryAgentId: "rev-a",
      outputMode: "aggregate",
      round: 2,
    });
    assert.equal(session.round, 2);

    // 成员逐个完成 → 等齐判定推进（aggregate）
    session = applyMemberCompletion(session, "rev-a", { output: { v: 1 } });
    assert.equal(isGroupAggregateSatisfied(session), false, "只完成一个 → 未等齐");
    session = applyMemberCompletion(session, "rev-b", { output: { v: 2 } });
    assert.equal(isGroupAggregateSatisfied(session), true, "全部完成 → 等齐，可走组级出边");
    assert.equal(session.round, 2, "轮次计数贯穿成员推进");
  });

  test("race mode: first completed member wins (GroupSession marks winner, rest cancellable)", () => {
    let session = normalizeGroupSessionEntry({
      id: "GS-race",
      groupId: "fastest-wins",
      members: ["fast", "slow"],
      entryAgentId: "fast",
      outputMode: "race",
    });
    session = applyMemberCompletion(session, "fast", { output: "winner" });
    assert.equal(pickGroupRaceWinner(session), "fast", "先完成者胜出");
    // 其余成员标记 cancelled（advisory；实际取消不造新 transport）
    session = applyMemberCompletion(session, "slow", { status: "cancelled" });
    assert.equal(session.memberStates.slow.status, "cancelled");
    // race 胜者既定后，aggregate 等齐判定仍为 false（race 不等齐，靠先得）
    assert.equal(isGroupAggregateSatisfied(session), false);
  });
});
