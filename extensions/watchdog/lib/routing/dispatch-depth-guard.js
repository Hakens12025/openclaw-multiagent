// lib/routing/dispatch-depth-guard.js — Pure runtime safety counter for dispatch hop depth
//
// The graph still owns *authorization* (graph edge = who may dispatch to whom);
// this module owns nothing about topology. It is a pure, per-contract runtime
// counter whose only job is to guarantee a contract cannot hop forever.
//
// Two agents wired A->B and B->A form a legal 2-cycle in the graph, so the
// edge-authorization check passes on every hop. Per-session loop-detection
// (loop-detection.js) cannot catch the ping-pong either: A and B run in separate
// sessions and each hop's content differs, so no single session ever sees the
// repeat. The only place that sees the whole chain is the contract itself, so the
// counter rides on the contract and is evaluated at the single dispatch choke point.

function normalizeDepth(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(numeric);
  }
  return 0;
}

function normalizeChain(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" && entry.trim() ? entry.trim() : null))
    .filter(Boolean);
}

function readEnvInt(name, fallback) {
  const numeric = Number(process.env[name]);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

// Absolute hop backstop: no contract may traverse more than this many dispatch
// hops. Sits well above the loop-budget ceiling (DEFAULT_LOOP_MAX_ROUNDS=3): a
// legitimate declared loop re-dispatches the SAME contract each round through
// dispatchSharedToAgent, so its depth accumulates — 32 gives ~10x headroom over a
// default 3-round loop while still terminating any undeclared runaway.
export const MAX_DISPATCH_DEPTH = readEnvInt("OPENCLAW_MAX_DISPATCH_DEPTH", 32);

// Tight-cycle backstop: how many times the same agent may already be a hop target
// before the next hop to it is refused. Set to 2x DEFAULT_LOOP_MAX_ROUNDS so a
// legal 3-round loop passes, but a pure A<->B ping-pong (target repeats every other
// hop) is refused around depth 12 — long before the absolute cap.
export const MAX_ORIGIN_CHAIN_REPEAT = readEnvInt("OPENCLAW_MAX_ORIGIN_CHAIN_REPEAT", 6);

export const DISPATCH_GUARD_REASON = Object.freeze({
  MAX_DEPTH: "max_dispatch_depth",
  ORIGIN_CHAIN_CYCLE: "origin_chain_cycle",
});

// Pure read: pull the runtime counter off a contract snapshot, tolerating
// missing/legacy/dirty fields. Never mutates.
export function readDispatchGuardState(contract) {
  return {
    dispatchDepth: normalizeDepth(contract?.dispatchDepth),
    originChain: normalizeChain(contract?.originChain),
  };
}

// Pure evaluation. Given the CURRENT depth/chain and the agent this hop targets,
// decide whether the hop may proceed. No mutation, no I/O.
//
// FIX(A2-fanout-depth/review): a DECLARED loop is already bounded by loop-budget
// (the single authority for loop termination — maxRounds/maxExperiments). Its rounds
// legitimately revisit the same node, so the fixed cycle/depth constants would
// FALSE-BLOCK a legitimately-configured long loop before loop-budget concludes it.
// So a loop-tagged contract is deferred entirely to loop-budget; this guard's real
// job is UNDECLARED runaways (ad-hoc delegate / sessions_send ping-pong) that
// loop-budget does not cover.
export function evaluateDispatchGuard({ dispatchDepth, originChain, targetAgent, isLoopContract = false } = {}) {
  if (isLoopContract) {
    return { allowed: true, reason: null, deferredToLoopBudget: true };
  }
  const depth = normalizeDepth(dispatchDepth);
  const chain = normalizeChain(originChain);

  if (depth >= MAX_DISPATCH_DEPTH) {
    return {
      allowed: false,
      reason: DISPATCH_GUARD_REASON.MAX_DEPTH,
      depth,
      limit: MAX_DISPATCH_DEPTH,
    };
  }

  const target = typeof targetAgent === "string" ? targetAgent.trim() : "";
  if (target) {
    let repeats = 0;
    for (const agentId of chain) {
      if (agentId === target) repeats += 1;
    }
    if (repeats >= MAX_ORIGIN_CHAIN_REPEAT) {
      return {
        allowed: false,
        reason: DISPATCH_GUARD_REASON.ORIGIN_CHAIN_CYCLE,
        repeats,
        limit: MAX_ORIGIN_CHAIN_REPEAT,
        targetAgent: target,
      };
    }
  }

  return { allowed: true, reason: null, depth };
}

// Pure next-state: compute the counter AFTER a real hop to targetAgent. The caller
// writes the returned fields onto the contract inside the same atomic mutation that
// assigns the contract to the target, so dispatchDepth == number of hops taken.
export function nextDispatchGuardState({ dispatchDepth, originChain, targetAgent } = {}) {
  const depth = normalizeDepth(dispatchDepth);
  const chain = normalizeChain(originChain);
  const target = typeof targetAgent === "string" && targetAgent.trim() ? targetAgent.trim() : null;
  return {
    dispatchDepth: depth + 1,
    originChain: target ? [...chain, target] : chain,
  };
}
