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
import { mutateContractSnapshot, getContractPath, readContractSnapshotById } from "../contracts.js";
import { CONTRACT_STATUS, isActiveContractStatus } from "../core/runtime-status.js";
import {
  advanceDispatchRoundRobinCursor,
  claimDispatchTargetContract,
  dequeueDispatchContract,
  enqueueDispatchContract,
  getDispatchQueueDepth,
  hasDispatchTarget,
  isDispatchTargetBusy,
  listDispatchTargetIds,
  markDispatchTargetDispatching,
  releaseDispatchTargetContract,
  rollbackDispatchTargetDispatch,
  ensureDispatchTargetAvailable,
} from "./dispatch-runtime-state.js";
import { dispatchSendExecutionContract } from "./dispatch-transport.js";
import { getAgentRole } from "../agent/agent-identity.js";
import { getDispatchInstruction, getRoleSummary } from "../role-spec-registry.js";
import { buildAgentContractSessionKey } from "../session-keys.js";
import { waitForTrackingContractClaim } from "../store/tracker-store.js";

const GATE = Object.freeze({
  ON_COMPLETE: "on-complete",
  ON_FAIL: "on-fail",
  FAN_OUT: "fan-out",
  ROUND_ROBIN: "round-robin",
  DEFAULT: "default",
});

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

async function buildWakeMessage(contractId, targetAgent) {
  const role = getAgentRole(targetAgent);
  const summary = getRoleSummary(role);
  const instruction = getDispatchInstruction(role);

  // Read contract to inject task + output path into wake message
  let task = "";
  let output = "";
  try {
    const contract = await readContractSnapshotById(contractId);
    task = contract?.task || "";
    output = contract?.output || "";
  } catch {}

  return [
    `${summary}`,
    `你收到了合约 ${contractId}。`,
    "",
    task ? `任务：${task}` : "",
    output ? `输出路径：${output}` : "",
    "",
    instruction,
  ].filter(Boolean).join("\n");
}

async function dispatchSharedToAgent(contractId, fromAgent, targetAgent, api, logger, {
  updateContract = null,
  wakePayload = null,
  buildWakeReason = null,
  broadcastDispatch = true,
  dispatchAlert = null,
} = {}) {
  const targetAvailable = await ensureDispatchTargetAvailable(targetAgent, logger);
  if (!targetAvailable || !hasDispatchTarget(targetAgent)) {
    logger?.error?.(`[dispatch-graph-policy] ${targetAgent} is not a registered dispatch target; refusing ${contractId}`);
    return { dispatched: false, queued: false, failed: true };
  }

  // If target is busy, queue and return
  if (isAgentBusy(targetAgent)) {
    const depth = queueDepth(targetAgent) + 1;
    logger?.info?.(`[dispatch-graph-policy] ${targetAgent} busy → queuing ${contractId} (depth: ${depth})`);
    const enqueueResult = await enqueueForAgent(targetAgent, {
      contractId,
      fromAgent,
      updateContract,
    }, logger);
    if (enqueueResult?.error) {
      return { dispatched: false, queued: false, failed: true };
    }
    return { dispatched: false, queued: true };
  }

  // Mark busy and dispatch via primitives
  markBusy(targetAgent, contractId);
  logger?.info?.(`[dispatch-graph-policy] routing ${contractId}: ${fromAgent} → ${targetAgent}`);
  const targetSessionKey = buildAgentContractSessionKey(targetAgent, contractId);

  try {
    const dispatchResult = await dispatchSendExecutionContract({
      contractId,
      targetAgent,
      from: fromAgent,
      api,
      logger,
      wakePayload: {
        sessionKey: buildAgentContractSessionKey(targetAgent, contractId),
        ...(wakePayload && typeof wakePayload === "object" ? wakePayload : {}),
      },
      buildWakeReason: buildWakeReason || (() => buildWakeMessage(contractId, targetAgent)),
      broadcastDispatch,
      dispatchAlert,
      updateContract(contract) {
        return applySharedContractDispatchMutation(contract, targetAgent, updateContract);
      },
    });
    if (dispatchResult?.ok === false) {
      throw new Error(dispatchResult.blockReason || "shared dispatch failed");
    }

    const claim = await waitForTrackingContractClaim(targetSessionKey, contractId, 1500);
    if (!claim?.claimed) {
      logger?.info?.(
        `[dispatch-graph-policy] claim timeout for ${contractId} → ${targetAgent}; `
        + `treating staged inbox dispatch as accepted`,
      );
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
    return { dispatched: false, queued: false, failed: true };
  }

  return { dispatched: true, queued: false, claimed: true };
}

// ── onAgentDone — drain queue after agent finishes ──────────────────────────

export async function onAgentDone(agentId, api, logger, {
  retainBusy = false,
} = {}) {
  if (retainBusy) {
    return;
  }

  await markIdle(agentId, logger);

  const next = dequeueDispatchContract(agentId);
  if (!next) return;

  logger?.info?.(`[dispatch-graph-policy] draining queue for ${agentId}: next=${next.contractId} (remaining: ${queueDepth(agentId)})`);
  await dispatchSharedToAgent(next.contractId, next.fromAgent, agentId, api, logger);
}

export async function drainIdleDispatchTargets(api, logger) {
  for (const agentId of listDispatchTargetIds()) {
    if (isAgentBusy(agentId)) {
      continue;
    }
    const next = dequeueDispatchContract(agentId);
    if (!next) {
      continue;
    }
    logger?.info?.(
      `[dispatch-graph-policy] draining recovered queue for ${agentId}: next=${next.contractId} `
      + `(remaining: ${queueDepth(agentId)})`,
    );
    await dispatchSharedToAgent(next.contractId, next.fromAgent, agentId, api, logger);
  }
}

// ── routeAfterAgentEnd ──────────────────────────────────────────────────────

export async function resolveRouteAfterAgentEndTarget(agentId, { status, targetAgent = null } = {}) {
  if (targetAgent) {
    return {
      routable: true,
      action: "explicit",
      target: targetAgent,
    };
  }

  const graph = await loadGraph();
  const edges = getEdgesFrom(graph, agentId);

  if (!edges || edges.length === 0) {
    return { routable: false, action: "terminal", target: null };
  }

  // Single out-edge
  if (edges.length === 1) {
    return { routable: true, action: "single_edge", target: edges[0].to };
  }

  // on-complete / on-fail
  const statusEdges = edges.filter(
    (e) => e.gate === GATE.ON_COMPLETE || e.gate === GATE.ON_FAIL
  );
  if (statusEdges.length > 0) {
    const matchGate = status === "failed" ? GATE.ON_FAIL : GATE.ON_COMPLETE;
    const matched = statusEdges.find((e) => e.gate === matchGate);
    if (matched) {
      return { routable: true, action: matchGate, target: matched.to };
    }
    return { routable: false, action: "terminal", target: null };
  }

  // fan-out — not supported
  const fanOutEdges = edges.filter((e) => e.gate === GATE.FAN_OUT);
  if (fanOutEdges.length > 0) {
    return { routable: false, action: "fan-out_unsupported", target: null };
  }

  // round-robin
  const rrEdges = edges.filter((e) => e.gate === GATE.ROUND_ROBIN);
  if (rrEdges.length > 0) {
    const idx = advanceDispatchRoundRobinCursor(agentId, rrEdges.length);
    return { routable: true, action: "round_robin", target: rrEdges[idx]?.to || null };
  }

  // default
  const defaultEdges = edges.filter((e) => !e.gate || e.gate === GATE.DEFAULT);
  if (defaultEdges.length > 0) {
    if (defaultEdges.length > 1) {
      return { routable: false, action: "ambiguous_runtime_transition", target: null };
    }
    return { routable: true, action: "default", target: defaultEdges[0].to };
  }

  return { routable: false, action: "terminal", target: null };
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
    if (resolvedRoute.action === "fan-out_unsupported") {
      logger?.error?.("[dispatch-graph-policy] fan-out gate not supported in current contract model");
    }
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

  const defaultEdge = edges.find((e) => !e.gate || e.gate === GATE.DEFAULT);
  if (defaultEdge) {
    return defaultEdge.to;
  }

  return edges[0].to;
}
