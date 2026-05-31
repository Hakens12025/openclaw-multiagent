// dispatch-runtime-state.js — dispatch runtime state operations (ops layer)
//
// Owns: state mutation primitives (sync, ensure, mark, claim, release,
//       enqueue, dequeue, requeue, remove, reset, clear).
//
// Re-exports from sub-modules so all callers keep working unchanged:
//   - dispatch-runtime-normalize.js  (pure normalization helpers)
//   - dispatch-runtime-snapshot.js   (snapshot construction + SSE emit)
//   - dispatch-runtime-persist.js    (persist / load)

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  dispatchOutgoingStateMap,
  dispatchTargetStateMap,
  OC,
} from "../state.js";
import {
  registerRuntimeAgents,
  listRuntimeAgentIds,
} from "../agent/agent-identity.js";

import {
  collectDispatchRuntimeTargetIds,
  clearDispatchingQueueEntry,
  ensureDispatchOutgoingState,
  ensureDispatchTargetState,
  isIdleDispatchState,
  normalizeIncomingDispatchEntry,
  normalizeOutgoingDispatchEntry,
  removeOutgoingQueuedContract,
  removeQueuedContract,
} from "./dispatch-runtime-normalize.js";
import {
  buildDispatchRuntimeSnapshot,
  emitDispatchRuntimeSnapshot,
  summarizeDispatchContractFlow,
} from "./dispatch-runtime-snapshot.js";
import {
  commitDispatchRuntimeState,
} from "./dispatch-runtime-persist.js";

// Re-export everything callers use from sub-modules ──────────────────────────
export { normalizeIncomingDispatchEntry } from "./dispatch-runtime-normalize.js";
export {
  summarizeDispatchContractFlow,
  buildDispatchRuntimeSnapshot,
  emitDispatchRuntimeSnapshot,
} from "./dispatch-runtime-snapshot.js";
export {
  commitDispatchRuntimeState,
  persistDispatchRuntimeState,
  loadDispatchRuntimeState,
} from "./dispatch-runtime-persist.js";

// ── Runtime agent hydration ──────────────────────────────────────────────────

async function ensureRuntimeAgentsLoaded(logger) {
  if (listRuntimeAgentIds().length > 0) {
    return;
  }

  try {
    const raw = await readFile(join(OC, "openclaw.json"), "utf8");
    const config = JSON.parse(raw);
    if (config && typeof config === "object") {
      registerRuntimeAgents(config);
      logger?.info?.("[dispatch-state] hydrated runtime agents from openclaw.json");
    }
  } catch (error) {
    logger?.warn?.(`[dispatch-state] failed to hydrate runtime agents: ${error.message}`);
  }
}

// ── Public ops ───────────────────────────────────────────────────────────────

export function listRuntimeDispatchTargetIds() {
  return collectDispatchRuntimeTargetIds();
}

export async function ensureDispatchTargetAvailable(agentId, logger) {
  const normalizedAgentId = typeof agentId === "string" && agentId.trim()
    ? agentId.trim()
    : null;
  if (!normalizedAgentId) {
    return false;
  }

  await ensureRuntimeAgentsLoaded(logger);
  if (collectDispatchRuntimeTargetIds().includes(normalizedAgentId)) {
    ensureDispatchTargetState(normalizedAgentId);
    logger?.info?.(`[dispatch-state] registered runtime roster target ${normalizedAgentId}`);
    return true;
  }

  return false;
}

export async function syncDispatchTargets(targetIds, logger) {
  const targetSet = new Set(Array.isArray(targetIds) ? targetIds.filter(Boolean) : []);

  for (const agentId of targetSet) {
    ensureDispatchTargetState(agentId);
  }

  for (const [agentId, state] of [...dispatchTargetStateMap.entries()]) {
    const hasQueuedWork = Boolean(state?.dispatchingQueueEntry) || (Array.isArray(state?.queue) && state.queue.length > 0);
    delete state.outgoingQueue;
    if (!targetSet.has(agentId) && !state?.busy && !state?.dispatching && !hasQueuedWork) {
      dispatchTargetStateMap.delete(agentId);
      logger?.info?.(`[dispatch-state] pruned idle target ${agentId}`);
    }
  }
}

export async function syncDispatchTargetsFromRuntime(logger) {
  await ensureRuntimeAgentsLoaded(logger);
  const targets = collectDispatchRuntimeTargetIds();
  await syncDispatchTargets(targets, logger);
  logger?.info?.(`[dispatch-state] runtime targets: ${listDispatchTargetIds().join(", ") || "(none)"}`);
}

export function listDispatchTargetIds() {
  return [...dispatchTargetStateMap.keys()];
}

export function hasDispatchTarget(agentId) {
  return dispatchTargetStateMap.has(agentId);
}

export function isDispatchTargetBusy(agentId) {
  const state = dispatchTargetStateMap.get(agentId);
  return Boolean(state?.busy || state?.dispatching);
}

export function getDispatchTargetCurrentContract(agentId) {
  const state = dispatchTargetStateMap.get(agentId);
  const contractId = typeof state?.currentContract === "string"
    ? state.currentContract.trim()
    : "";
  return contractId || null;
}

export function markDispatchTargetDispatching(agentId, contractId) {
  const state = dispatchTargetStateMap.get(agentId);
  if (!state) return false;
  if (state.busy === true || state.dispatching === true || state.currentContract) {
    return false;
  }
  state.dispatching = true;
  state.currentContract = contractId;
  state.lastSeen = Date.now();
  emitDispatchRuntimeSnapshot();
  return true;
}

export function rollbackDispatchTargetDispatch(agentId) {
  const state = dispatchTargetStateMap.get(agentId);
  if (!state) return false;
  state.dispatching = false;
  if (!state.busy) {
    state.currentContract = null;
  }
  state.lastSeen = Date.now();
  emitDispatchRuntimeSnapshot();
  return true;
}

export async function claimDispatchTargetContract({ contractId, agentId, logger }) {
  if (!hasDispatchTarget(agentId)) {
    logger?.warn?.(`[dispatch-state] refused claim for unknown target ${agentId}`);
    return false;
  }
  const state = ensureDispatchTargetState(agentId);
  removeQueuedContract(state, contractId);
  clearDispatchingQueueEntry(state, contractId);

  state.busy = true;
  state.dispatching = false;
  state.currentContract = contractId;
  state.lastSeen = Date.now();

  emitDispatchRuntimeSnapshot();
  await commitDispatchRuntimeState(logger);
  return true;
}

export async function releaseDispatchTargetContract({ agentId, logger }) {
  const state = dispatchTargetStateMap.get(agentId);
  if (!state) return false;

  state.busy = false;
  state.dispatching = false;
  state.currentContract = null;
  state.dispatchingQueueEntry = null;
  state.lastSeen = Date.now();
  logger?.info?.(`[dispatch-state] ${agentId} released`);
  emitDispatchRuntimeSnapshot();
  await commitDispatchRuntimeState(logger);
  return true;
}

export async function removeDispatchContract(contractId, logger = null) {
  const normalized = typeof contractId === "string" && contractId.trim() ? contractId.trim() : null;
  if (!normalized) {
    return {
      removedFromQueues: 0,
      clearedDispatching: 0,
      clearedIdleCurrent: 0,
      releasedBusyCurrent: 0,
      changed: false,
    };
  }

  let removedFromQueues = 0;
  let clearedDispatching = 0;
  let clearedIdleCurrent = 0;
  let releasedBusyCurrent = 0;

  for (const [agentId, state] of dispatchTargetStateMap.entries()) {
    if (removeQueuedContract(state, normalized)) {
      removedFromQueues += 1;
      logger?.info?.(`[dispatch-state] removed queued ${normalized} from ${agentId}`);
    }
    if (clearDispatchingQueueEntry(state, normalized)) {
      removedFromQueues += 1;
      logger?.info?.(`[dispatch-state] removed dispatching queue lease ${normalized} from ${agentId}`);
    }
    delete state.outgoingQueue;
    if (state?.currentContract !== normalized) {
      continue;
    }
    if (state.dispatching === true) {
      state.dispatching = false;
      if (state.busy !== true) {
        state.currentContract = null;
      }
      state.lastSeen = Date.now();
      clearedDispatching += 1;
      logger?.info?.(`[dispatch-state] cleared dispatching ${normalized} from ${agentId}`);
      continue;
    }
    if (state.busy === true) {
      state.busy = false;
      state.dispatching = false;
      state.currentContract = null;
      state.lastSeen = Date.now();
      releasedBusyCurrent += 1;
      logger?.info?.(`[dispatch-state] released busy current ${normalized} from ${agentId}`);
      continue;
    }
    if (state.busy !== true) {
      state.currentContract = null;
      state.lastSeen = Date.now();
      clearedIdleCurrent += 1;
      logger?.info?.(`[dispatch-state] cleared idle current ${normalized} from ${agentId}`);
    }
  }
  for (const [sourceAgentId, state] of dispatchOutgoingStateMap.entries()) {
    if (removeOutgoingQueuedContract(state, normalized)) {
      removedFromQueues += 1;
      logger?.info?.(`[dispatch-state] removed outgoing queued ${normalized} from ${sourceAgentId}`);
      if (isIdleDispatchState(state)) {
        dispatchOutgoingStateMap.delete(sourceAgentId);
      }
    }
  }

  const changed = removedFromQueues > 0
    || clearedDispatching > 0
    || clearedIdleCurrent > 0
    || releasedBusyCurrent > 0;
  if (changed) {
    emitDispatchRuntimeSnapshot();
    await commitDispatchRuntimeState(logger);
  }

  return {
    removedFromQueues,
    clearedDispatching,
    clearedIdleCurrent,
    releasedBusyCurrent,
    changed,
  };
}

export function enqueueDispatchContract(agentId, contractId, meta = {}, logger) {
  const normalized = typeof contractId === "string" && contractId.trim() ? contractId.trim() : null;
  if (!normalized || !hasDispatchTarget(agentId)) {
    return false;
  }

  const state = ensureDispatchTargetState(agentId);
  const existingLease = normalizeIncomingDispatchEntry(agentId, state.dispatchingQueueEntry);
  const exists = existingLease?.contractId === normalized || state.queue.some((entry) => (
    typeof entry === "string" ? entry === normalized : entry?.contractId === normalized
  ));
  if (!exists) {
    state.queue.push({
      contractId: normalized,
      ...(meta && typeof meta === "object" ? meta : {}),
    });
    logger?.info?.(`[dispatch-state] queued ${normalized} for ${agentId} (depth: ${state.queue.length})`);
    emitDispatchRuntimeSnapshot();
    void commitDispatchRuntimeState(logger);
  }
  return true;
}

export function enqueueOutgoingDispatchContract(agentId, contractId, meta = {}, logger) {
  const sourceAgentId = typeof agentId === "string" && agentId.trim() ? agentId.trim() : null;
  if (!sourceAgentId) {
    return false;
  }
  const entry = normalizeOutgoingDispatchEntry(sourceAgentId, contractId, meta);
  if (!entry) {
    return false;
  }

  const state = ensureDispatchOutgoingState(sourceAgentId);
  const existing = state.outgoingQueue.find((item) => item?.contractId === entry.contractId);
  if (existing) {
    Object.assign(existing, entry);
    emitDispatchRuntimeSnapshot();
    void commitDispatchRuntimeState(logger);
    return true;
  }

  state.outgoingQueue.push(entry);
  logger?.info?.(`[dispatch-state] outgoing queued ${entry.contractId} from ${sourceAgentId} to ${entry.targetAgent || "(unknown)"}`);
  emitDispatchRuntimeSnapshot();
  void commitDispatchRuntimeState(logger);
  return true;
}

export async function removeOutgoingDispatchContract(agentId, contractId, logger = null) {
  const sourceAgentId = typeof agentId === "string" && agentId.trim() ? agentId.trim() : null;
  const normalized = typeof contractId === "string" && contractId.trim() ? contractId.trim() : null;
  if (!sourceAgentId || !normalized) {
    return false;
  }
  const outgoingState = dispatchOutgoingStateMap.get(sourceAgentId);
  const outgoingChanged = removeOutgoingQueuedContract(outgoingState, normalized);
  if (outgoingChanged) {
    if (isIdleDispatchState(outgoingState)) {
      dispatchOutgoingStateMap.delete(sourceAgentId);
    }
  }
  const state = dispatchTargetStateMap.get(sourceAgentId);
  if (state?.outgoingQueue) delete state.outgoingQueue;
  const anyChanged = outgoingChanged;
  if (anyChanged) {
    emitDispatchRuntimeSnapshot();
    await commitDispatchRuntimeState(logger);
  }
  return anyChanged;
}

export async function dequeueDispatchContract(agentId, logger = null) {
  const state = dispatchTargetStateMap.get(agentId);
  if (state?.dispatchingQueueEntry) {
    return null;
  }
  if (!state || !Array.isArray(state.queue) || state.queue.length === 0) return null;
  const entry = normalizeIncomingDispatchEntry(agentId, state.queue.shift());
  if (!entry) return null;
  state.dispatchingQueueEntry = entry;
  emitDispatchRuntimeSnapshot();
  await commitDispatchRuntimeState(logger);
  return entry;
}

export async function requeueDispatchContractFront(agentId, entry, logger = null) {
  const normalizedEntry = normalizeIncomingDispatchEntry(agentId, entry);
  if (!normalizedEntry || !hasDispatchTarget(agentId)) {
    return false;
  }

  const state = ensureDispatchTargetState(agentId);
  clearDispatchingQueueEntry(state, normalizedEntry.contractId);
  if (state.queue.some((queued) => {
    const normalizedQueued = normalizeIncomingDispatchEntry(agentId, queued);
    return normalizedQueued?.contractId === normalizedEntry.contractId;
  })) {
    return false;
  }

  state.queue.unshift({
    contractId: normalizedEntry.contractId,
    fromAgent: normalizedEntry.fromAgent,
  });
  emitDispatchRuntimeSnapshot();
  await commitDispatchRuntimeState(logger);
  return true;
}

export function getDispatchQueueDepth(agentId) {
  const state = dispatchTargetStateMap.get(agentId);
  return Array.isArray(state?.queue) ? state.queue.length : 0;
}

export function resetAllDispatchStates() {
  for (const [, state] of dispatchTargetStateMap) {
    state.busy = false;
    state.dispatching = false;
    state.currentContract = null;
    state.dispatchingQueueEntry = null;
    state.queue = [];
    delete state.outgoingQueue;
  }
  dispatchOutgoingStateMap.clear();
  emitDispatchRuntimeSnapshot();
}

export async function clearDispatchQueue(logger = null) {
  let count = 0;
  for (const [, state] of dispatchTargetStateMap) {
    if (Array.isArray(state.queue)) {
      count += state.queue.length;
      state.queue = [];
    }
    if (state.dispatchingQueueEntry) {
      count += 1;
      state.dispatchingQueueEntry = null;
    }
    delete state.outgoingQueue;
  }
  for (const [, state] of dispatchOutgoingStateMap) {
    if (Array.isArray(state.outgoingQueue)) {
      count += state.outgoingQueue.length;
    }
  }
  dispatchOutgoingStateMap.clear();
  if (count > 0) {
    emitDispatchRuntimeSnapshot();
    await commitDispatchRuntimeState(logger);
  }
  return count;
}
