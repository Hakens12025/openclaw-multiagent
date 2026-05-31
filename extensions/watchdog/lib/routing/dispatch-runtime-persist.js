// dispatch-runtime-persist.js — atomic persist/load for dispatch runtime state
//
// Owns the serialization format (QUEUE_STATE_FILE) and the hydration logic.
// Calls emitDispatchRuntimeSnapshot after load.

import { readFile } from "node:fs/promises";

import {
  atomicWriteFile,
  dispatchOutgoingStateMap,
  dispatchTargetStateMap,
  QUEUE_STATE_FILE,
} from "../state.js";
import {
  ensureDispatchOutgoingState,
  ensureDispatchTargetState,
  normalizeIncomingDispatchEntry,
  normalizeOutgoingDispatchEntry,
} from "./dispatch-runtime-normalize.js";
import {
  emitDispatchRuntimeSnapshot,
  flattenQueuedContracts,
} from "./dispatch-runtime-snapshot.js";

let dispatchRuntimePersistChain = Promise.resolve();

export function commitDispatchRuntimeState(logger = null) {
  dispatchRuntimePersistChain = dispatchRuntimePersistChain
    .catch(() => {})
    .then(() => persistDispatchRuntimeState(logger));
  return dispatchRuntimePersistChain;
}

export async function persistDispatchRuntimeState(logger) {
  try {
    const savedTargets = {};
    for (const [id, state] of dispatchTargetStateMap.entries()) {
      savedTargets[id] = {
        busy: state.busy === true,
        healthy: state.healthy !== false,
        dispatching: state.dispatching === true,
        currentContract: state.currentContract || null,
        dispatchingQueueEntry: normalizeIncomingDispatchEntry(id, state.dispatchingQueueEntry),
        lastSeen: state.lastSeen || null,
        queue: Array.isArray(state.queue) ? state.queue : [],
      };
    }
    const savedOutgoing = {};
    for (const [id, state] of dispatchOutgoingStateMap.entries()) {
      const outgoingQueue = Array.isArray(state.outgoingQueue) ? state.outgoingQueue : [];
      if (outgoingQueue.length > 0) {
        savedOutgoing[id] = { outgoingQueue };
      }
    }
    await atomicWriteFile(QUEUE_STATE_FILE, JSON.stringify({
      targets: savedTargets,
      outgoing: savedOutgoing,
      savedAt: Date.now(),
    }, null, 2));
  } catch (error) {
    logger?.warn?.(`[dispatch-state] persist failed: ${error.message}`);
  }
}

export async function loadDispatchRuntimeState(logger) {
  let persisted = null;
  try {
    const raw = await readFile(QUEUE_STATE_FILE, "utf8");
    persisted = JSON.parse(raw);
  } catch (err) {
    logger?.warn?.(`[dispatch-state] failed to load persisted state: ${err.message}`);
  }

  for (const state of dispatchTargetStateMap.values()) {
    state.busy = false;
    state.dispatching = false;
    state.currentContract = null;
    state.dispatchingQueueEntry = null;
    state.queue = [];
    delete state.outgoingQueue;
  }
  dispatchOutgoingStateMap.clear();

  const targetEntries = persisted?.targets && typeof persisted.targets === "object"
    ? Object.entries(persisted.targets)
    : [];

  for (const [agentId, savedState] of targetEntries) {
    const state = ensureDispatchTargetState(agentId);
    state.healthy = savedState?.healthy !== false;
    state.lastSeen = savedState?.lastSeen || state.lastSeen || Date.now();
    const savedLease = normalizeIncomingDispatchEntry(agentId, savedState?.dispatchingQueueEntry);
    state.queue = Array.isArray(savedState?.queue)
      ? savedState.queue
          .map((entry) => (typeof entry === "string" ? { contractId: entry } : entry))
          .filter((entry) => entry?.contractId)
      : [];
    if (savedLease && !state.queue.some((entry) => normalizeIncomingDispatchEntry(agentId, entry)?.contractId === savedLease.contractId)) {
      state.queue.unshift(savedLease);
      logger?.warn?.(`[dispatch-state] restored dispatching queue lease ${savedLease.contractId} for ${agentId}`);
    }
    state.dispatchingQueueEntry = null;
    delete state.outgoingQueue;
  }
  const outgoingEntries = persisted?.outgoing && typeof persisted.outgoing === "object"
    ? Object.entries(persisted.outgoing)
    : [];

  for (const [sourceAgentId, savedState] of outgoingEntries) {
    const state = ensureDispatchOutgoingState(sourceAgentId);
    state.outgoingQueue = Array.isArray(savedState?.outgoingQueue)
      ? savedState.outgoingQueue
          .map((entry) => normalizeOutgoingDispatchEntry(sourceAgentId, entry?.contractId, entry))
          .filter(Boolean)
      : [];
  }

  const recovered = flattenQueuedContracts();
  if (recovered.length > 0) {
    logger?.info?.(`[dispatch-state] restored ${recovered.length} queued contract(s)`);
  }
  emitDispatchRuntimeSnapshot();
}
