import { dispatchTargetStateMap, withLock } from "../state.js";
import {
  CONTRACT_STATUS,
  isActiveContractStatus,
  isRunningTrackingStatus,
} from "../core/runtime-status.js";
import { normalizeContractIdentity } from "../core/normalize.js";
import {
  listSharedContractEntries,
  readCachedContractSnapshotById,
} from "../store/contract-store.js";
import { listTrackingStates } from "../store/tracker-store.js";
import {
  buildDispatchRuntimeSnapshot,
  emitDispatchRuntimeSnapshot,
  getDispatchTargetCurrentContract,
  hasDispatchTarget,
  persistDispatchRuntimeState,
} from "./dispatch-runtime-state.js";

function normalizeDispatchQueueEntry(entry) {
  if (typeof entry === "string") {
    const contractId = typeof entry === "string" && entry.trim() ? entry.trim() : null;
    return contractId ? { contractId, fromAgent: null } : null;
  }

  const contractId = typeof entry?.contractId === "string" && entry.contractId.trim()
    ? entry.contractId.trim()
    : null;
  if (!contractId) {
    return null;
  }

  return {
    contractId,
    fromAgent: typeof entry?.fromAgent === "string" && entry.fromAgent.trim()
      ? entry.fromAgent.trim()
      : null,
  };
}

function queueHasContract(state, contractId) {
  const normalizedContractId = normalizeContractIdentity(contractId);
  if (!normalizedContractId || !Array.isArray(state?.queue)) {
    return false;
  }
  return state.queue.some((entry) => {
    const normalizedEntry = normalizeDispatchQueueEntry(entry);
    return normalizedEntry?.contractId === normalizedContractId;
  });
}

function deriveRecoveredQueueOrigin(contract) {
  return contract?.coordination?.caller?.agentId
    || contract?.replyTo?.agentId
    || contract?.upstreamReplyTo?.agentId
    || null;
}

export async function reconcileDispatchRuntimeTruth(logger) {
  return withLock("dispatch-runtime:reconcile-truth", async () => {
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
    for (const [agentId, state] of dispatchTargetStateMap.entries()) {
      const preservedQueue = [];
      const seenQueuedContracts = new Set();
      for (const entry of Array.isArray(state.queue) ? state.queue : []) {
        const normalizedEntry = normalizeDispatchQueueEntry(entry);
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
        if (!contract || !isActiveContractStatus(contract.status) || contract.assignee !== agentId) {
          logger?.info?.(
            `[dispatch-state] pruned stale queue entry ${normalizedEntry.contractId} for ${agentId}`,
          );
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

      state.queue.push({
        contractId,
        fromAgent: deriveRecoveredQueueOrigin(contract),
      });
      logger?.info?.(`[dispatch-state] recovered orphan pending contract ${contractId} for ${agentId}`);
      changed = true;
    }

    for (const [, state] of dispatchTargetStateMap.entries()) {
      const dedupedQueue = [];
      const seenQueuedContracts = new Set();
      for (const entry of Array.isArray(state.queue) ? state.queue : []) {
        const normalizedEntry = normalizeDispatchQueueEntry(entry);
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
