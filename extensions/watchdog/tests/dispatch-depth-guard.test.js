/**
 * dispatch-depth-guard.test.js — Unit tests for lib/routing/dispatch-depth-guard.js
 *
 * Pure module: no I/O, no mocks. Verifies the depth cap, the A<->B ping-pong
 * cycle backstop, headroom for a legal directed cycle in the graph, field
 * normalization, and next-state purity. Uses arbitrary agent ids only
 * (no hardcoded topology).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_DISPATCH_DEPTH,
  MAX_ORIGIN_CHAIN_REPEAT,
  DISPATCH_GUARD_REASON,
  readDispatchGuardState,
  evaluateDispatchGuard,
  nextDispatchGuardState,
} from "../lib/routing/dispatch/dispatch-depth-guard.js";

// Replay a chain of hops, returning where (if anywhere) the guard first blocks.
function replayHops(pickTarget) {
  let state = { dispatchDepth: 0, originChain: [] };
  for (let i = 0; i < MAX_DISPATCH_DEPTH * 4; i += 1) {
    const targetAgent = pickTarget(i);
    const verdict = evaluateDispatchGuard({ ...state, targetAgent });
    if (!verdict.allowed) {
      return { blocked: true, verdict, depthAtBlock: state.dispatchDepth, state };
    }
    state = nextDispatchGuardState({ ...state, targetAgent });
  }
  return { blocked: false, verdict: null, depthAtBlock: state.dispatchDepth, state };
}

describe("evaluateDispatchGuard", () => {
  test("allows a fresh contract (depth 0, empty chain)", () => {
    const verdict = evaluateDispatchGuard({ dispatchDepth: 0, originChain: [], targetAgent: "alpha" });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reason, null);
  });

  test("allows a hop below the depth cap", () => {
    const verdict = evaluateDispatchGuard({
      dispatchDepth: MAX_DISPATCH_DEPTH - 1,
      originChain: ["a", "b", "c"],
      targetAgent: "d",
    });
    assert.equal(verdict.allowed, true);
  });

  test("blocks once depth reaches MAX_DISPATCH_DEPTH", () => {
    const verdict = evaluateDispatchGuard({
      dispatchDepth: MAX_DISPATCH_DEPTH,
      originChain: [],
      targetAgent: "z",
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, DISPATCH_GUARD_REASON.MAX_DEPTH);
    assert.equal(verdict.limit, MAX_DISPATCH_DEPTH);
  });

  test("a distinct-target chain runs to exactly the depth cap and no further", () => {
    // Every target unique -> the cycle backstop can never fire, so the depth cap is
    // the sole stop. This proves the absolute hop ceiling terminates a runaway.
    const result = replayHops((i) => `agent-${i}`);
    assert.equal(result.blocked, true);
    assert.equal(result.verdict.reason, DISPATCH_GUARD_REASON.MAX_DEPTH);
    assert.equal(result.depthAtBlock, MAX_DISPATCH_DEPTH);
  });

  test("an A<->B ping-pong is stopped by the cycle backstop before the depth cap", () => {
    const twoNodeLoop = ["alpha", "beta"];
    const result = replayHops((i) => twoNodeLoop[i % 2]);
    assert.equal(result.blocked, true);
    assert.equal(result.verdict.reason, DISPATCH_GUARD_REASON.ORIGIN_CHAIN_CYCLE);
    assert.equal(result.verdict.repeats, MAX_ORIGIN_CHAIN_REPEAT);
    assert.ok(
      result.depthAtBlock < MAX_DISPATCH_DEPTH,
      `ping-pong should trip before depth cap, tripped at ${result.depthAtBlock}`,
    );
  });

  test("does not block a legal two-node directed cycle traversed 3 times", () => {
    // 带环图是合法拓扑(前端也要能识别环)。一个 2 节点环走 3 圈 = 每个节点被投 3 次,
    // 3 < MAX_ORIGIN_CHAIN_REPEAT,守卫必须让路——它只截未声明的失控链。
    let state = { dispatchDepth: 0, originChain: [] };
    const loop = ["planner", "worker"];
    for (let round = 0; round < 3; round += 1) {
      for (const targetAgent of loop) {
        const verdict = evaluateDispatchGuard({ ...state, targetAgent });
        assert.equal(verdict.allowed, true, `round ${round} -> ${targetAgent} must stay allowed`);
        state = nextDispatchGuardState({ ...state, targetAgent });
      }
    }
    assert.equal(state.originChain.filter((a) => a === "planner").length, 3);
    assert.equal(state.originChain.filter((a) => a === "worker").length, 3);
  });

  test("the documented two-tier split (32 backstop / 6 tight-cycle) holds only for k<=5 cycles", () => {
    // 锁定 dispatch-depth-guard.js 阈值注释里的两个数,防止注释与代码再次错位一圈:
    // ① 判据是"到达次数"不是"圈数":repeats>=6 才拒 = 第 7 次到达时拒,所以 k<=5 的环
    //    恰好走满 MAX_ORIGIN_CHAIN_REPEAT 个完整圈(A<->B 即 12 跳)才被截。
    // ② k>=6 的环先撞 MAX_DISPATCH_DEPTH,环重复计数根本轮不到——"32 兜底、6 管紧环"
    //    是短环语义,不是全域语义。
    for (const k of [2, 3, 4, 5]) {
      const cycle = Array.from({ length: k }, (_, i) => `node-${k}-${i}`);
      const result = replayHops((i) => cycle[i % k]);
      assert.equal(result.blocked, true, `k=${k} must block`);
      assert.equal(result.verdict.reason, DISPATCH_GUARD_REASON.ORIGIN_CHAIN_CYCLE, `k=${k} is cycle-bound`);
      assert.equal(
        result.depthAtBlock,
        MAX_ORIGIN_CHAIN_REPEAT * k,
        `k=${k} must complete exactly ${MAX_ORIGIN_CHAIN_REPEAT} full laps before the block`,
      );
    }
    for (const k of [6, 8, 16]) {
      const cycle = Array.from({ length: k }, (_, i) => `node-${k}-${i}`);
      const result = replayHops((i) => cycle[i % k]);
      assert.equal(result.blocked, true, `k=${k} must block`);
      assert.equal(result.verdict.reason, DISPATCH_GUARD_REASON.MAX_DEPTH, `k=${k} is depth-bound, not cycle-bound`);
      assert.equal(result.depthAtBlock, MAX_DISPATCH_DEPTH, `k=${k}`);
    }
  });

  test("has no let-off lane: an unknown extra flag cannot buy a pass past the depth cap", () => {
    // 回路退役(2026-08-18):此处曾有 isLoopContract 让位分支——带 loopId 的合约整条
    // 让给 loop-budget,守卫对它恒放行。回路面消失后本模块是跳数唯一权威,不再有让位口:
    // 无论调用方多传什么,超限就是拒绝。
    const verdict = evaluateDispatchGuard({
      dispatchDepth: MAX_DISPATCH_DEPTH + 50,
      originChain: Array.from({ length: 40 }, () => "planner"),
      targetAgent: "planner",
      isLoopContract: true,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, DISPATCH_GUARD_REASON.MAX_DEPTH);
    assert.equal(verdict.deferredToLoopBudget, undefined);
  });

  test("ignores an empty/blank targetAgent for the cycle check", () => {
    const verdict = evaluateDispatchGuard({
      dispatchDepth: 1,
      originChain: ["x", "x", "x", "x", "x", "x"],
      targetAgent: "   ",
    });
    assert.equal(verdict.allowed, true);
  });
});

describe("readDispatchGuardState", () => {
  test("defaults missing fields to depth 0 / empty chain", () => {
    assert.deepEqual(readDispatchGuardState(null), { dispatchDepth: 0, originChain: [] });
    assert.deepEqual(readDispatchGuardState({}), { dispatchDepth: 0, originChain: [] });
  });

  test("passes through valid fields", () => {
    assert.deepEqual(
      readDispatchGuardState({ dispatchDepth: 5, originChain: ["x", "y"] }),
      { dispatchDepth: 5, originChain: ["x", "y"] },
    );
  });

  test("sanitizes negative depth, non-array chain, and blank entries", () => {
    assert.deepEqual(
      readDispatchGuardState({ dispatchDepth: -3, originChain: "nope" }),
      { dispatchDepth: 0, originChain: [] },
    );
    assert.deepEqual(
      readDispatchGuardState({ dispatchDepth: 2.9, originChain: ["a", "", null, " b "] }),
      { dispatchDepth: 2, originChain: ["a", "b"] },
    );
  });
});

describe("nextDispatchGuardState", () => {
  test("increments depth and appends the target", () => {
    const next = nextDispatchGuardState({ dispatchDepth: 1, originChain: ["a"], targetAgent: "b" });
    assert.deepEqual(next, { dispatchDepth: 2, originChain: ["a", "b"] });
  });

  test("is pure — does not mutate the input chain", () => {
    const input = { dispatchDepth: 1, originChain: ["a"], targetAgent: "b" };
    nextDispatchGuardState(input);
    assert.deepEqual(input.originChain, ["a"]);
  });

  test("still advances depth when target is missing (chain unchanged)", () => {
    const next = nextDispatchGuardState({ dispatchDepth: 0, originChain: ["a"], targetAgent: null });
    assert.deepEqual(next, { dispatchDepth: 1, originChain: ["a"] });
  });
});
