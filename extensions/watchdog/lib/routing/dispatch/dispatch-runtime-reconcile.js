import { dispatchOutgoingStateMap, dispatchTargetStateMap, withLock } from "../../state.js";
import {
  CONTRACT_STATUS,
  isActiveContractStatus,
  isRunningTrackingStatus,
} from "../../core/runtime-status.js";
import { normalizeContractIdentity } from "../../core/normalize.js";
import {
  listSharedContractEntries,
  readCachedContractSnapshotById,
} from "../../store/contract-store.js";
import { listTrackingStates } from "../../store/tracker-store.js";
import {
  buildDispatchRuntimeSnapshot,
  emitDispatchRuntimeSnapshot,
  getDispatchTargetCurrentContract,
  hasDispatchTarget,
  listRuntimeDispatchTargetIds,
  normalizeIncomingDispatchEntry,
  persistDispatchRuntimeState,
} from "./dispatch-runtime-state.js";
import { hasDirectedEdge, loadGraph } from "../../agent/agent-graph.js";

function queueHasContract(state, contractId) {
  const normalizedContractId = normalizeContractIdentity(contractId);
  if (!normalizedContractId) {
    return false;
  }
  const lease = normalizeIncomingDispatchEntry(null, state?.dispatchingQueueEntry);
  if (lease?.contractId === normalizedContractId) {
    return true;
  }
  if (!Array.isArray(state?.queue)) {
    return false;
  }
  return state.queue.some((entry) => {
    const normalizedEntry = normalizeIncomingDispatchEntry(null, entry);
    return normalizedEntry?.contractId === normalizedContractId;
  });
}

function deriveRecoveredQueueOrigin(contract) {
  return contract?.coordination?.caller?.agentId
    || contract?.replyTo?.agentId
    || contract?.upstreamReplyTo?.agentId
    || null;
}

function hasGraphQueueEdge(graph, fromAgent, targetAgent) {
  if (!fromAgent || !targetAgent) {
    return false;
  }
  return hasDirectedEdge(graph, fromAgent, targetAgent);
}

async function canRecoverPendingQueueEntry(contract, targetAgent, logger) {
  const fromAgent = deriveRecoveredQueueOrigin(contract);
  if (!fromAgent || !targetAgent) {
    logger?.info?.(
      `[dispatch-state] skipped orphan pending contract ${contract?.id || "unknown"}: missing graph origin`,
    );
    return { ok: false, fromAgent: null };
  }
  const graph = await loadGraph();
  if (!hasDirectedEdge(graph, fromAgent, targetAgent)) {
    logger?.info?.(
      `[dispatch-state] skipped orphan pending contract ${contract?.id || "unknown"}: no graph edge ${fromAgent} -> ${targetAgent}`,
    );
    return { ok: false, fromAgent };
  }
  return { ok: true, fromAgent };
}

async function shouldKeepQueuedEntry({
  graph,
  targetAgent,
  entry,
  contract,
  logger,
}) {
  if (!contract || !isActiveContractStatus(contract.status) || contract.assignee !== targetAgent) {
    logger?.info?.(
      `[dispatch-state] pruned stale queue entry ${entry.contractId} for ${targetAgent}`,
    );
    return false;
  }

  if (!hasGraphQueueEdge(graph, entry.fromAgent, targetAgent)) {
    logger?.info?.(
      `[dispatch-state] pruned unauthorized queue entry ${entry.contractId}: no graph edge ${entry.fromAgent || "(unknown)"} -> ${targetAgent}`,
    );
    return false;
  }

  return true;
}

async function shouldKeepOutgoingEntry({
  graph,
  sourceAgent,
  entry,
  logger,
}) {
  const contractId = normalizeContractIdentity(entry?.contractId);
  const targetAgent = typeof entry?.targetAgent === "string" && entry.targetAgent.trim()
    ? entry.targetAgent.trim()
    : null;
  if (!contractId || !targetAgent) {
    return false;
  }

  const contract = await readCachedContractSnapshotById(contractId, {
    preferCache: false,
  });
  if (!contract || !isActiveContractStatus(contract.status)) {
    logger?.info?.(
      `[dispatch-state] pruned stale outgoing entry ${contractId} from ${sourceAgent}`,
    );
    return false;
  }

  if (!hasDispatchTarget(targetAgent)) {
    logger?.info?.(
      `[dispatch-state] pruned outgoing entry ${contractId}: unknown target ${targetAgent}`,
    );
    return false;
  }

  const edgeFrom = typeof entry?.routeEdge?.from === "string" && entry.routeEdge.from.trim()
    ? entry.routeEdge.from.trim()
    : sourceAgent;
  const edgeTo = typeof entry?.routeEdge?.to === "string" && entry.routeEdge.to.trim()
    ? entry.routeEdge.to.trim()
    : targetAgent;
  if (!hasGraphQueueEdge(graph, edgeFrom, edgeTo)) {
    logger?.info?.(
      `[dispatch-state] pruned unauthorized outgoing entry ${contractId}: no graph edge ${edgeFrom || "(unknown)"} -> ${edgeTo || "(unknown)"}`,
    );
    return false;
  }

  return true;
}

async function pruneOutgoingQueueState({
  graph,
  sourceAgent,
  state,
  logger,
}) {
  const preservedOutgoingQueue = [];
  const seenOutgoingContracts = new Set();
  let changed = false;
  for (const entry of Array.isArray(state?.outgoingQueue) ? state.outgoingQueue : []) {
    const contractId = normalizeContractIdentity(entry?.contractId);
    if (!contractId || seenOutgoingContracts.has(contractId)) {
      changed = true;
      continue;
    }
    const keepOutgoing = await shouldKeepOutgoingEntry({
      graph,
      sourceAgent,
      entry,
      logger,
    });
    if (!keepOutgoing) {
      changed = true;
      continue;
    }
    seenOutgoingContracts.add(contractId);
    preservedOutgoingQueue.push(entry);
  }
  if (JSON.stringify(preservedOutgoingQueue) !== JSON.stringify(Array.isArray(state?.outgoingQueue) ? state.outgoingQueue : [])) {
    state.outgoingQueue = preservedOutgoingQueue;
    changed = true;
  }
  return changed;
}

export async function reconcileDispatchRuntimeTruth(logger) {
  return withLock("dispatch-runtime:reconcile-truth", async () => {
    const graph = await loadGraph();
    const trackedCurrentContracts = new Map();
    for (const trackingState of listTrackingStates()) {
      const agentId = typeof trackingState?.agentId === "string" && trackingState.agentId.trim()
        ? trackingState.agentId.trim()
        : null;
      const contractId = typeof trackingState?.contract?.id === "string" && trackingState.contract.id.trim()
        ? trackingState.contract.id.trim()
        : null;
      if (
        !agentId
        || !contractId
        || isRunningTrackingStatus(trackingState?.status) !== true
        || isActiveContractStatus(trackingState?.contract?.status) !== true
      ) {
        continue;
      }
      trackedCurrentContracts.set(agentId, contractId);
    }

    let changed = false;
    const activeRuntimeTargetIds = new Set(listRuntimeDispatchTargetIds());
    for (const agentId of [...dispatchTargetStateMap.keys()]) {
      if (!activeRuntimeTargetIds.has(agentId)) {
        dispatchTargetStateMap.delete(agentId);
        logger?.info?.(`[dispatch-state] pruned non-roster dispatch target ${agentId}`);
        changed = true;
      }
    }

    for (const [agentId, state] of dispatchTargetStateMap.entries()) {
      const normalizedLease = normalizeIncomingDispatchEntry(agentId, state.dispatchingQueueEntry);
      if (normalizedLease) {
        const leaseContract = await readCachedContractSnapshotById(normalizedLease.contractId, {
          preferCache: false,
        });
        const keepLease = await shouldKeepQueuedEntry({
          graph,
          targetAgent: agentId,
          entry: normalizedLease,
          contract: leaseContract,
          logger,
        });
        if (!keepLease) {
          state.dispatchingQueueEntry = null;
          changed = true;
        } else {
          state.dispatchingQueueEntry = normalizedLease;
        }
      } else if (state.dispatchingQueueEntry) {
        state.dispatchingQueueEntry = null;
        changed = true;
      }

      const preservedQueue = [];
      const seenQueuedContracts = new Set();
      if (state.dispatchingQueueEntry) {
        seenQueuedContracts.add(normalizeContractIdentity(state.dispatchingQueueEntry.contractId));
      }
      for (const entry of Array.isArray(state.queue) ? state.queue : []) {
        const normalizedEntry = normalizeIncomingDispatchEntry(agentId, entry);
        if (!normalizedEntry) {
          changed = true;
          continue;
        }
        const normalizedContractId = normalizeContractIdentity(normalizedEntry.contractId);
        if (seenQueuedContracts.has(normalizedContractId)) {
          changed = true;
          continue;
        }

        const contract = await readCachedContractSnapshotById(normalizedEntry.contractId, {
          preferCache: false,
        });
        const keepQueued = await shouldKeepQueuedEntry({
          graph,
          targetAgent: agentId,
          entry: normalizedEntry,
          contract,
          logger,
        });
        if (!keepQueued) {
          changed = true;
          continue;
        }

        seenQueuedContracts.add(normalizedContractId);
        preservedQueue.push(normalizedEntry);
      }

      if (JSON.stringify(preservedQueue) !== JSON.stringify(Array.isArray(state.queue) ? state.queue : [])) {
        state.queue = preservedQueue;
        changed = true;
      }

      if (Array.isArray(state.outgoingQueue) && state.outgoingQueue.length > 0) {
        delete state.outgoingQueue;
        changed = true;
      } else if ("outgoingQueue" in state) {
        delete state.outgoingQueue;
      }

      const trackedContractId = trackedCurrentContracts.get(agentId) || null;
      if (trackedContractId) {
        if (
          state.busy !== true
          || state.dispatching !== false
          || normalizeContractIdentity(state.currentContract) !== normalizeContractIdentity(trackedContractId)
        ) {
          state.busy = true;
          state.dispatching = false;
          state.currentContract = trackedContractId;
          state.lastSeen = Date.now();
          changed = true;
        }
        continue;
      }

      const currentContractId = normalizeContractIdentity(getDispatchTargetCurrentContract(agentId));
      if (!currentContractId) {
        if (state.busy || state.dispatching) {
          state.busy = false;
          state.dispatching = false;
          state.lastSeen = Date.now();
          changed = true;
        }
        continue;
      }

      const currentContract = await readCachedContractSnapshotById(currentContractId, {
        preferCache: false,
      });
      if (!currentContract || !isActiveContractStatus(currentContract.status) || currentContract.assignee !== agentId) {
        logger?.info?.(
          `[dispatch-state] cleared stale current contract ${currentContractId} for ${agentId}`,
        );
        state.busy = false;
        state.dispatching = false;
        state.currentContract = null;
        state.lastSeen = Date.now();
        changed = true;
      }
    }

    for (const [sourceAgent, state] of [...dispatchOutgoingStateMap.entries()]) {
      if (await pruneOutgoingQueueState({ graph, sourceAgent, state, logger })) {
        changed = true;
      }
      if (!Array.isArray(state?.outgoingQueue) || state.outgoingQueue.length === 0) {
        dispatchOutgoingStateMap.delete(sourceAgent);
      }
    }

    const sharedEntries = await listSharedContractEntries();
    const pendingEntries = [...sharedEntries]
      .filter((entry) => entry?.contract?.status === CONTRACT_STATUS.PENDING)
      .sort((left, right) =>
        (Number(left.contract?.createdAt) || 0) - (Number(right.contract?.createdAt) || 0));

    for (const entry of pendingEntries) {
      const contract = entry.contract;
      const contractId = typeof contract?.id === "string" && contract.id.trim()
        ? contract.id.trim()
        : null;
      const agentId = typeof contract?.assignee === "string" && contract.assignee.trim()
        ? contract.assignee.trim()
        : null;
      if (!contractId || !agentId || !hasDispatchTarget(agentId)) {
        continue;
      }

      const state = dispatchTargetStateMap.get(agentId);
      if (!state) {
        continue;
      }
      if (
        normalizeContractIdentity(state.currentContract) === normalizeContractIdentity(contractId)
        || queueHasContract(state, contractId)
      ) {
        continue;
      }

      const recovery = await canRecoverPendingQueueEntry(contract, agentId, logger);
      if (!recovery.ok) {
        continue;
      }

      state.queue.push({
        contractId,
        fromAgent: recovery.fromAgent,
      });
      logger?.info?.(`[dispatch-state] recovered orphan pending contract ${contractId} for ${agentId}`);
      changed = true;
    }

    for (const [agentId2, state] of dispatchTargetStateMap.entries()) {
      const dedupedQueue = [];
      const seenQueuedContracts = new Set();
      const normalizedLease = normalizeIncomingDispatchEntry(agentId2, state.dispatchingQueueEntry);
      if (normalizedLease) {
        seenQueuedContracts.add(normalizeContractIdentity(normalizedLease.contractId));
      }
      for (const entry of Array.isArray(state.queue) ? state.queue : []) {
        const normalizedEntry = normalizeIncomingDispatchEntry(agentId2, entry);
        if (!normalizedEntry) {
          changed = true;
          continue;
        }
        const normalizedContractId = normalizeContractIdentity(normalizedEntry.contractId);
        if (seenQueuedContracts.has(normalizedContractId)) {
          changed = true;
          continue;
        }
        seenQueuedContracts.add(normalizedContractId);
        dedupedQueue.push(normalizedEntry);
      }
      if (JSON.stringify(dedupedQueue) !== JSON.stringify(Array.isArray(state.queue) ? state.queue : [])) {
        state.queue = dedupedQueue;
        changed = true;
      }
    }

    if (changed) {
      emitDispatchRuntimeSnapshot();
      await persistDispatchRuntimeState(logger);
    }

    return {
      changed,
      queue: buildDispatchRuntimeSnapshot().queue,
    };
  });
}
