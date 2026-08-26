// lib/dispatch-graph-policy.js — Graph-driven dispatch policy engine
//
// Reads out-edges from the agent graph after an agent ends and dispatches
// the contract to the next agent(s) based on gate type and status.
// Includes per-agent FIFO queue: if target is busy, contract waits.
//
// Graph routing owns next-hop selection + queueing; dispatch-transport owns the
// actual shared-contract transport.

import { loadGraph, getEdgesFrom, getPipelineEdgesFrom } from "../../agent/agent-graph.js";
import { broadcast } from "../../transport/sse.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import { mutateContractById, readContractSnapshotById } from "../../contract/contracts.js"; // FIX(A2-fanout-depth): read runtime hop counter off the contract at the choke point
import { CONTRACT_STATUS, isActiveContractStatus } from "../../core/runtime-status.js";
import {
  claimDispatchTargetContract,
  dequeueDispatchContract,
  enqueueOutgoingDispatchContract,
  enqueueDispatchContract,
  getDispatchQueueDepth,
  hasDispatchTarget,
  isDispatchTargetBusy,
  listDispatchTargetIds,
  markDispatchTargetDispatching,
  removeOutgoingDispatchContract,
  releaseDispatchTargetContract,
  requeueDispatchContractFront,
  rollbackDispatchTargetDispatch,
  ensureDispatchTargetAvailable,
} from "./dispatch-runtime-state.js";
import { dispatchSendExecutionContract } from "./dispatch-transport.js";
// FIX(A2-fanout-depth): pure runtime hop-counter guard (no topology knowledge, no agentId branches)
import {
  evaluateDispatchGuard,
  readDispatchGuardState,
  nextDispatchGuardState,
} from "./dispatch-depth-guard.js";
import { buildAgentContractSessionKey } from "../../session/session-keys.js";
import {
  deleteUnclaimedTrackingSessionForContract,
  waitForTrackingContractClaim,
} from "../../store/tracker-store.js";
import { hasRuntimeGraphBypassAuthority } from "../runtime-authority.js";
import { withLock } from "../../state.js";

class DispatchClaimTimeoutError extends Error {
  constructor({ contractId, targetAgent, sessionKey, reason = null } = {}) {
    super(`dispatch claim timeout for ${contractId} -> ${targetAgent}`);
    this.name = "DispatchClaimTimeoutError";
    this.contractId = contractId || null;
    this.targetAgent = targetAgent || null;
    this.sessionKey = sessionKey || null;
    this.claimReason = reason || "timeout";
  }
}

function isAgentBusy(agentId) {
  return hasDispatchTarget(agentId) ? isDispatchTargetBusy(agentId) : false;
}

// 上游产物来源 = 把这份合约交出来的那一跳。派工是所有交接的共同收口(传送带的图边解算
// 与动态派工的角色表解算在此汇合),所以上游身份在这里一次登记、随合约走。
// 此前上游由 upstream-package-inflow 反查图入边(getEdgesTo),那等于把「投递授权」当成「产物来源」:
// 动态派工的目标本就不在图上,拿不到上游包;拓扑一改,历史合约的上游也跟着变。
// 指针带 contractId 是因为新约的源产物可能在别的合约名下(合约派生场景)。
function applyUpstreamProducerPointer(contract, targetAgent, fromAgent) {
  if (!fromAgent || fromAgent === targetAgent || !contract?.id) return false;
  const current = Array.isArray(contract.upstreamProducers) ? contract.upstreamProducers : null;
  if (current?.length === 1 && current[0]?.agentId === fromAgent && current[0]?.contractId === contract.id) {
    return false;
  }
  contract.upstreamProducers = [{ agentId: fromAgent, contractId: contract.id }];
  return true;
}

function applySharedContractDispatchMutation(contract, targetAgent, updateContract = null, fromAgent = null) {
  let changed = false;
  if (typeof updateContract === "function") {
    const updateResult = updateContract(contract);
    if (updateResult !== false) {
      changed = true;
    }
  }
  if (applyUpstreamProducerPointer(contract, targetAgent, fromAgent)) {
    changed = true;
  }
  if (contract.assignee !== targetAgent) {
    contract.assignee = targetAgent;
    changed = true;
  }
  if (!isActiveContractStatus(contract.status)) {
    contract.status = CONTRACT_STATUS.PENDING;
    changed = true;
  }
  return changed;
}

function markBusy(agentId, contractId) {
  if (!hasDispatchTarget(agentId)) return false;
  return markDispatchTargetDispatching(agentId, contractId);
}

async function authorizeDispatchEdge(fromAgent, targetAgent, logger, {
  runtimeAuthority = null,
} = {}) {
  if (hasRuntimeGraphBypassAuthority({ fromAgent, targetAgent, runtimeAuthority })) {
    return { ok: true };
  }

  const graph = await loadGraph();
  const edges = getEdgesFrom(graph, fromAgent);
  const authorized = edges.some((edge) => edge?.to === targetAgent);
  if (!authorized) {
    logger?.warn?.(`[dispatch-graph-policy] blocked dispatch without graph edge: ${fromAgent} -> ${targetAgent}`);
    return {
      ok: false,
      action: "unauthorized_explicit_target",
      target: targetAgent,
    };
  }
  return { ok: true };
}

export async function markIdle(agentId, logger = null) {
  if (!hasDispatchTarget(agentId)) return false;
  return releaseDispatchTargetContract({ agentId, logger });
}

// ── Shared contract mutation helper ─────────────────────────────────────────

async function assignContractToAgent(contractId, agentId, logger, updateContract = null, fromAgent = null) {
  return mutateContractById(
    contractId,
    logger,
    (contract) => applySharedContractDispatchMutation(contract, agentId, updateContract, fromAgent),
  );
}

// ── Queue operations ────────────────────────────────────────────────────────

async function enqueueForAgent(agentId, entry, logger) {
  if (!hasDispatchTarget(agentId)) {
    logger?.error?.(`[dispatch-graph-policy] ${agentId} is not a registered dispatch target`);
    return { queued: false, error: "unknown_dispatch_target" };
  }

  // assignee mutation 必须成功，否则目标 agent 扫不到 → fail-closed
  if (entry.contractId) {
    try {
      await assignContractToAgent(entry.contractId, agentId, logger, entry.updateContract || null, entry.fromAgent || null);
    } catch (e) {
      logger?.error?.(`[dispatch-graph-policy] failed to set assignee for ${entry.contractId} → ${agentId}: ${e?.message}, NOT queuing`);
      return { queued: false, error: "assignee_mutation_failed" };
    }
  }
  const queued = enqueueDispatchContract(agentId, entry.contractId, {
    fromAgent: entry.fromAgent || null,
  }, logger);
  if (!queued) {
    return { queued: false, error: "queue_enqueue_failed" };
  }
  broadcast("alert", {
    type: EVENT_TYPE.GRAPH_QUEUE,
    agentId,
    depth: getDispatchQueueDepth(agentId),
    contractId: entry.contractId,
    ts: Date.now(),
  });
  return { queued: true };
}

function queueDepth(agentId) {
  return getDispatchQueueDepth(agentId);
}

// ── Internal dispatch (queue ownership → shared dispatch primitive) ─────────

// 唤醒消息：原始续作指令。上游产物经【包流转】落到本 agent 的 inbox/upstream/<producer>/，
// 并由 contract.json 的 upstreamPackages 指针引导 agent 去读（见 lib/delivery/upstream-package-inflow.js /
// runtime-mailbox.js）。产物不再嵌进 wake —— agent 只读自己 inbox，系统负责搬运。
export function buildWakeMessage(contractId) {
  return `Continue the current contract: ${contractId}.`;
}

async function dispatchSharedToAgent(contractId, fromAgent, targetAgent, api, logger, {
  updateContract = null,
  wakeupFunc = null,
  wakePayload = null,
  buildWakeReason = null,
  broadcastDispatch = true,
  dispatchAlert = null,
  queueEntry = null,
  runtimeAuthority = null,
} = {}) {
  const authorization = await authorizeDispatchEdge(fromAgent, targetAgent, logger, {
    runtimeAuthority,
  });
  if (!authorization.ok) {
    if (queueEntry?.contractId) {
      await requeueDispatchContractFront(targetAgent, queueEntry, logger);
    }
    return {
      dispatched: false,
      queued: false,
      failed: true,
      action: authorization.action,
      target: authorization.target,
    };
  }

  // FIX(A2-fanout-depth): unbounded hop depth + A->B->A ping-pong (each hop is a
  // separate session, so per-session loop-detection can't see it) -> read the runtime
  // hop counter carried on the contract and hard-stop before committing another hop.
  // Graph authorization already passed above ("edge = authorization" is untouched);
  // this is a pure safety counter layered on top, not a topology decision.
  const guardSnapshot = await readContractSnapshotById(contractId);
  const guardState = readDispatchGuardState(guardSnapshot);
  const guardVerdict = evaluateDispatchGuard({
    dispatchDepth: guardState.dispatchDepth,
    originChain: guardState.originChain,
    targetAgent,
  });
  if (!guardVerdict.allowed) {
    logger?.warn?.(
      `[dispatch-graph-policy] dispatch guard blocked ${contractId}: ${fromAgent} -> ${targetAgent} `
      + `(${guardVerdict.reason}, depth=${guardState.dispatchDepth})`,
    );
    broadcast("alert", {
      type: "dispatch_guard_blocked",
      contractId,
      from: fromAgent,
      to: targetAgent,
      reason: guardVerdict.reason,
      dispatchDepth: guardState.dispatchDepth,
      ts: Date.now(),
    });
    // Hard stop: a blocked contract has exhausted its hop budget, so requeuing would
    // only re-trigger the runaway. Queued entries never reach here — depth is stamped
    // at dispatch (below), not at enqueue, so a queued entry carries the same depth it
    // already passed the guard with. Callers observe `failed` and stop routing.
    return {
      dispatched: false,
      queued: false,
      failed: true,
      action: "dispatch_guard_blocked",
      reason: guardVerdict.reason,
      target: targetAgent,
    };
  }

  enqueueOutgoingDispatchContract(fromAgent, contractId, {
    targetAgent,
    status: "dispatching",
    routeEdge: {
      from: fromAgent,
      to: targetAgent,
      direction: null,
    },
  }, logger);

  const targetAvailable = await ensureDispatchTargetAvailable(targetAgent, logger);
  if (!targetAvailable || !hasDispatchTarget(targetAgent)) {
    logger?.error?.(`[dispatch-graph-policy] ${targetAgent} is not a registered dispatch target; refusing ${contractId}`);
    if (queueEntry?.contractId) {
      await requeueDispatchContractFront(targetAgent, queueEntry, logger);
    }
    enqueueOutgoingDispatchContract(fromAgent, contractId, {
      targetAgent,
      status: "blocked",
      routeEdge: {
        from: fromAgent,
        to: targetAgent,
        direction: null,
      },
    }, logger);
    return { dispatched: false, queued: false, failed: true };
  }

  // Atomically check busy state and claim dispatch ownership.
  // withLock serializes concurrent dispatches and reconcile writes targeting the same agent,
  // closing the TOCTOU window between isAgentBusy() and markBusy().
  const claimResult = await withLock(`dispatch-target-claim:${targetAgent}`, async () => {
    if (isAgentBusy(targetAgent)) {
      return { action: "queue", reason: "busy" };
    }
    if (!markBusy(targetAgent, contractId)) {
      return { action: "queue", reason: "claim_lost" };
    }
    return { action: "dispatch" };
  });

  if (claimResult.action === "queue") {
    const depth = queueDepth(targetAgent) + 1;
    const logReason = claimResult.reason === "busy" ? "busy" : "claim lost";
    logger?.info?.(`[dispatch-graph-policy] ${targetAgent} ${logReason} → queuing ${contractId} (depth: ${depth})`);
    const enqueueResult = await enqueueForAgent(targetAgent, {
      contractId,
      fromAgent,
      updateContract,
    }, logger);
    if (enqueueResult?.error) {
      return { dispatched: false, queued: false, failed: true };
    }
    await removeOutgoingDispatchContract(fromAgent, contractId, logger);
    return { dispatched: false, queued: true };
  }
  logger?.info?.(`[dispatch-graph-policy] routing ${contractId}: ${fromAgent} → ${targetAgent}`);
  const targetSessionKey = buildAgentContractSessionKey(targetAgent, contractId);
  let dispatchWake = null;

  try {
    const dispatchResult = await dispatchSendExecutionContract({
      contractId,
      targetAgent,
      from: fromAgent,
      api,
      logger,
      wakeupFunc,
      wakePayload: {
        sessionKey: buildAgentContractSessionKey(targetAgent, contractId),
        ...(wakePayload && typeof wakePayload === "object" ? wakePayload : {}),
      },
      buildWakeReason: buildWakeReason || (() => buildWakeMessage(contractId)),
      broadcastDispatch,
      dispatchAlert,
      runtimeAuthority,
      updateContract(contract) {
        // FIX(A2-fanout-depth): stamp the hop counter + origin chain exactly once per
        // real hop (dispatch branch only, never on enqueue), so dispatchDepth equals
        // the number of hops actually taken.
        const nextGuard = nextDispatchGuardState({
          dispatchDepth: contract?.dispatchDepth,
          originChain: contract?.originChain,
          targetAgent,
        });
        contract.dispatchDepth = nextGuard.dispatchDepth;
        contract.originChain = nextGuard.originChain;
        applySharedContractDispatchMutation(contract, targetAgent, updateContract, fromAgent);
        return true;
      },
    });
    if (dispatchResult?.ok === false) {
      throw new Error(dispatchResult.blockReason || "shared dispatch failed");
    }
    dispatchWake = dispatchResult?.wake;

    const claim = await waitForTrackingContractClaim(targetSessionKey, contractId, 1500);
    if (!claim?.claimed) {
      deleteUnclaimedTrackingSessionForContract({
        sessionKey: targetSessionKey,
        contractId,
        agentId: targetAgent,
        reason: "dispatch_claim_timeout",
      });
      broadcast("alert", {
        type: "dispatch_claim_timeout",
        contractId,
        agentId: targetAgent,
        sessionKey: targetSessionKey,
        reason: claim?.reason || "timeout",
        ts: Date.now(),
      });
      throw new DispatchClaimTimeoutError({
        contractId,
        targetAgent,
        sessionKey: targetSessionKey,
        reason: claim?.reason || "timeout",
      });
    }

    await claimDispatchTargetContract({ contractId, agentId: targetAgent, logger });

    broadcast("graph_dispatch", {
      from: fromAgent,
      to: targetAgent,
      contractId,
      ts: Date.now(),
    });
  } catch (e) {
    logger?.warn?.(`[dispatch-graph-policy] dispatch failed for ${contractId} → ${targetAgent}: ${e?.message}, rolling back busy`);
    rollbackDispatchTargetDispatch(targetAgent);
    if (queueEntry?.contractId) {
      await requeueDispatchContractFront(targetAgent, queueEntry, logger);
    }
    enqueueOutgoingDispatchContract(fromAgent, contractId, {
      targetAgent,
      status: "blocked",
      routeEdge: {
        from: fromAgent,
        to: targetAgent,
        direction: null,
      },
    }, logger);
    return {
      dispatched: false,
      queued: false,
      failed: true,
      claimed: e instanceof DispatchClaimTimeoutError ? false : undefined,
      claimReason: e instanceof DispatchClaimTimeoutError ? e.claimReason : undefined,
    };
  }

  await removeOutgoingDispatchContract(fromAgent, contractId, logger);
  return {
    dispatched: true,
    queued: false,
    claimed: true,
    wake: dispatchWake,
  };
}

// ── onAgentDone — drain queue after agent finishes ──────────────────────────

export async function onAgentDone(agentId, api, logger, {
  retainBusy = false,
} = {}) {
  if (retainBusy) {
    return;
  }

  await markIdle(agentId, logger);

  const next = await dequeueDispatchContract(agentId, logger);
  if (!next) return;

  logger?.info?.(`[dispatch-graph-policy] draining queue for ${agentId}: next=${next.contractId} (remaining: ${queueDepth(agentId)})`);
  await dispatchSharedToAgent(next.contractId, next.fromAgent, agentId, api, logger, {
    queueEntry: next,
  });
}

export async function drainIdleDispatchTargets(api, logger) {
  for (const agentId of listDispatchTargetIds()) {
    if (isAgentBusy(agentId)) {
      continue;
    }
    const next = await dequeueDispatchContract(agentId, logger);
    if (!next) {
      continue;
    }
    logger?.info?.(
      `[dispatch-graph-policy] draining recovered queue for ${agentId}: next=${next.contractId} `
      + `(remaining: ${queueDepth(agentId)})`,
    );
    await dispatchSharedToAgent(next.contractId, next.fromAgent, agentId, api, logger, {
      queueEntry: next,
    });
  }
}

// ── routeAfterAgentEnd ──────────────────────────────────────────────────────

export async function resolveRouteAfterAgentEndTarget(agentId, { status, targetAgent = null } = {}) {
  const graph = await loadGraph();

  // 显式目标:授权面,读全部边——FC 派工的广度不该被管线标记收窄。
  if (targetAgent) {
    const authorized = getEdgesFrom(graph, agentId).some((edge) => edge?.to === targetAgent);
    if (!authorized) {
      return {
        routable: false,
        action: "unauthorized_explicit_target",
        target: targetAgent,
      };
    }
    return {
      routable: true,
      action: "explicit",
      target: targetAgent,
    };
  }

  // 无显式目标:平台替 agent 选下一跳,只认管线边,且必须唯一。
  const pipelineEdges = getPipelineEdgesFrom(graph, agentId);

  if (!pipelineEdges || pipelineEdges.length === 0) {
    return { routable: false, action: "terminal", target: null };
  }

  if (pipelineEdges.length === 1) {
    return { routable: true, action: "single_edge", target: pipelineEdges[0].to };
  }

  return { routable: false, action: "ambiguous_runtime_transition", target: null };
}

export async function routeAfterAgentEnd(agentId, contractId, {
  status,
  api,
  logger,
  targetAgent = null,
  updateContract = null,
  wakePayload = null,
  buildWakeReason = null,
  broadcastDispatch = true,
  dispatchAlert = null,
} = {}) {
  const resolvedRoute = await resolveRouteAfterAgentEndTarget(agentId, {
    status,
    targetAgent,
  });

  if (!resolvedRoute.routable || !resolvedRoute.target) {
    return { routed: false, action: resolvedRoute.action, target: resolvedRoute.target || null };
  }

  const result = await dispatchSharedToAgent(
    contractId,
    agentId,
    resolvedRoute.target,
    api,
    logger,
    {
      updateContract,
      wakePayload,
      buildWakeReason,
      broadcastDispatch,
      dispatchAlert,
    },
  );
  if (result.failed) {
    return { routed: false, action: "dispatch_failed", target: resolvedRoute.target };
  }
  await removeOutgoingDispatchContract(agentId, contractId, logger);
  return {
    routed: true,
    action: result.queued ? "queued" : "dispatched",
    target: resolvedRoute.target,
  };
}

// ── dispatchRouteExecutionContract — public entry for ingress ───────────────
// Ingress creates pending contracts directly; dispatch-graph-policy only assigns and wakes.

export async function dispatchRouteExecutionContract(contractId, fromAgent, targetAgent, api, logger, options = {}) {
  return dispatchSharedToAgent(contractId, fromAgent, targetAgent, api, logger, options);
}

// ── dispatchResolveFirstHop ─────────────────────────────────────────────────

export async function dispatchResolveFirstHop(sourceAgentId, {
  dispatchOwnerAgentId = null,
} = {}) {
  const graphSourceAgentId = typeof dispatchOwnerAgentId === "string" && dispatchOwnerAgentId.trim()
    ? dispatchOwnerAgentId.trim()
    : sourceAgentId;
  const graph = await loadGraph();
  // ingress 首跳:外部消息进来时 LLM 还没跑,没人可问,只能靠管线边的唯一性。
  const pipelineEdges = getPipelineEdgesFrom(graph, graphSourceAgentId);

  if (!pipelineEdges || pipelineEdges.length === 0) {
    return null;
  }

  return pipelineEdges.length === 1 ? pipelineEdges[0].to : null;
}
