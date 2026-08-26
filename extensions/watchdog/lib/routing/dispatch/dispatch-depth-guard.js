// lib/routing/dispatch/dispatch-depth-guard.js — Pure runtime safety counter for dispatch hop depth
//
// The graph still owns *authorization* (graph edge = who may dispatch to whom);
// this module owns nothing about topology. It is a pure, per-contract runtime
// counter whose only job is to guarantee a contract cannot hop forever.
//
// Two agents wired A->B and B->A form a legal 2-cycle in the graph, so the
// edge-authorization check passes on every hop. Per-session execution hard-stop
// (execution-hard-stop-registry.js) cannot catch the ping-pong either: A and B run in separate
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

// 阈值依据(2026-08-18 回路运行时退役后重述):此前两个数值挂在
// DEFAULT_LOOP_MAX_ROUNDS=3 的 ~10x / 2x 上,但那条依据从来没有真正生效过——
// 带 loopId 的合约当时在本函数开头就被整条让位给 loop-budget,这个守卫压根评不到它们。
// 回路面退役后本模块是共享合约跳数的唯一权威,依据改为图拓扑本身:
//
// Absolute hop backstop: 一份合约总共可走的跳数上限。手写图管线的节点数以个位计,
// 32 跳远高于任何可信的声明式拓扑(含带环图的若干圈),同时保证失控链在有界步数内终止。
export const MAX_DISPATCH_DEPTH = readEnvInt("OPENCLAW_MAX_DISPATCH_DEPTH", 32);

// Tight-cycle backstop: 同一个 agent 已经作为跳目标出现过多少次之后,下一跳拒绝再投给它。
// 判据是"到达次数"而非"圈数":repeats>=6 才拒,即第 7 次到达该节点时拒,
// 前 6 圈已经完整走完。离线重放(纯函数直调 evaluate/nextState)实测 k=2/3/4/5 的环
// 都恰好走满 6 圈才停 —— 纯 A<->B 乒乓即 hops=12(=6 圈)被拒。
//
// 两级上限的分工只在 k<=5 成立:k>=6 的环先撞 32 跳绝对上限,环重复计数根本用不上
// (实测 k=6 停在 32 跳≈5.3 圈、k=8≈4 圈)。所以"32 兜底、6 管紧环"是短环语义,
// 不是全域语义。
//
// 数值维持 32/6 不变,但依据不再是"本守卫只评未声明链路":2026-08-18 回路运行时退役前,
// 带 loopId 的合约在调用方整条让位给 loop-budget,声明式管线是退役后才首次进入本守卫作用域,
// 那条旧依据已随退役作废。现在的依据只有一条 —— 这两个数是共享合约跳数的唯一权威(见上方"阈值依据"段),
// 现网全部可观测的截断行为都由它们产生,改值即改现网行为,要改先量。
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
export function evaluateDispatchGuard({ dispatchDepth, originChain, targetAgent } = {}) {
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
