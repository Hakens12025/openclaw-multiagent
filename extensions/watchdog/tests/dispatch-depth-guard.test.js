/**
 * dispatch-depth-guard.test.js — Unit tests for lib/routing/dispatch-depth-guard.js
 *
 * Pure module: no I/O, no mocks. Verifies the depth cap, the A<->B ping-pong
 * cycle backstop, non-interference with a legal declared loop, field normalization,
 * and next-state purity. Uses arbitrary agent ids only (no hardcoded topology).
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
} from "../lib/routing/dispatch-depth-guard.js";

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

  test("does not block a legal 3-round two-node loop (each node visited 3x)", () => {
    // A declared loop re-dispatches the same contract each round; with
    // DEFAULT_LOOP_MAX_ROUNDS=3 each node is targeted 3 times. 3 < MAX_ORIGIN_CHAIN_REPEAT,
    // so the guard stays out of the way — loop-budget owns loop termination.
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

  test("defers a declared-loop contract to loop-budget (never false-blocks a long loop)", () => {
    // A 2-node loop with many rounds would trip both the cycle repeat and the depth cap,
    // but a declared loop is bounded by loop-budget — the guard must stand down for it.
    const verdict = evaluateDispatchGuard({
      dispatchDepth: MAX_DISPATCH_DEPTH + 50,
      originChain: Array.from({ length: 40 }, () => "planner"), // 40 repeats >> MAX_ORIGIN_CHAIN_REPEAT
      targetAgent: "planner",
      isLoopContract: true,
    });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reason, null);
    assert.equal(verdict.deferredToLoopBudget, true);
  });

  test("still guards an UNDECLARED chain (isLoopContract false) at the depth cap", () => {
    const verdict = evaluateDispatchGuard({
      dispatchDepth: MAX_DISPATCH_DEPTH,
      originChain: [],
      targetAgent: "z",
      isLoopContract: false,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, DISPATCH_GUARD_REASON.MAX_DEPTH);
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
