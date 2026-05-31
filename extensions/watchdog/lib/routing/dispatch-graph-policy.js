// lib/dispatch-graph-policy.js — Graph-driven dispatch policy engine
//
// Reads out-edges from the agent graph after an agent ends and dispatches
// the contract to the next agent(s) based on gate type and status.
// Includes per-agent FIFO queue: if target is busy, contract waits.
//
// Graph routing owns next-hop selection + queueing; dispatch-transport owns the
// actual shared-contract transport.

import { loadGraph, getEdgesFrom } from "../agent/agent-graph.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { mutateContractSnapshot, getContractPath } from "../contracts.js";
import { CONTRACT_STATUS, isActiveContractStatus } from "../core/runtime-status.js";
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
import { buildAgentContractSessionKey } from "../session-keys.js";
import {
  deleteUnclaimedTrackingSessionForContract,
  waitForTrackingContractClaim,
} from "../store/tracker-store.js";
import { hasRuntimeGraphBypassAuthority } from "./runtime-authority.js";
import { withLock } from "../state.js";

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

function applySharedContractDispatchMutation(contract, targetAgent, updateContract = null) {
  let changed = false;
  if (typeof updateContract === "function") {
    const updateResult = updateContract(contract);
    if (updateResult !== false) {
      changed = true;
    }
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

async function assignContractToAgent(contractId, agentId, logger, updateContract = null) {
  return mutateContractSnapshot(
    getContractPath(contractId),
    logger,
    (contract) => applySharedContractDispatchMutation(contract, agentId, updateContract),
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
      await assignContractToAgent(entry.contractId, agentId, logger, entry.updateContract || null);
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
// 并由 contract.json 的 upstreamPackages 指针引导 agent 去读（见 artifact-store.js /
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
        return applySharedContractDispatchMutation(contract, targetAgent, updateContract);
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
  const edges = getEdgesFrom(graph, agentId);

  if (targetAgent) {
    const authorized = edges.some((edge) => edge?.to === targetAgent);
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

  if (!edges || edges.length === 0) {
    return { routable: false, action: "terminal", target: null };
  }

  if (edges.length === 1) {
    return { routable: true, action: "single_edge", target: edges[0].to };
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
  const edges = getEdgesFrom(graph, graphSourceAgentId);

  if (!edges || edges.length === 0) {
    return null;
  }

  return edges.length === 1 ? edges[0].to : null;
}
