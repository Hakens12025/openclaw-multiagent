import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  dispatchTargetStateMap,
  atomicWriteFile,
  QUEUE_STATE_FILE,
  OC,
  agentWorkspace,
} from "../state.js";
import {
  AGENT_ROLE,
  getRuntimeAgentConfig,
  listRuntimeAgentIds,
  registerRuntimeAgents,
} from "../agent/agent-identity.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";

function createDispatchTargetState() {
  return {
    busy: false,
    healthy: true,
    dispatching: false,
    lastSeen: Date.now(),
    currentContract: null,
    queue: [],
    roundRobinCursor: 0,
  };
}

function ensureDispatchTargetState(agentId) {
  if (!dispatchTargetStateMap.has(agentId)) {
    dispatchTargetStateMap.set(agentId, createDispatchTargetState());
  }
  const state = dispatchTargetStateMap.get(agentId);
  if (!Array.isArray(state.queue)) {
    state.queue = [];
  }
  if (!Number.isInteger(state.roundRobinCursor) || state.roundRobinCursor < 0) {
    state.roundRobinCursor = 0;
  }
  return state;
}

function collectDispatchRuntimeTargetIds() {
  const dispatchRoles = new Set([
    AGENT_ROLE.PLANNER,
    AGENT_ROLE.EXECUTOR,
    AGENT_ROLE.RESEARCHER,
    AGENT_ROLE.REVIEWER,
    AGENT_ROLE.AGENT,
  ]);
  return listRuntimeAgentIds().filter((agentId) => {
    const role = getRuntimeAgentConfig(agentId)?.role || null;
    return dispatchRoles.has(role);
  });
}

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

export async function ensureDispatchTargetAvailable(agentId, logger) {
  const normalizedAgentId = typeof agentId === "string" && agentId.trim()
    ? agentId.trim()
    : null;
  if (!normalizedAgentId) {
    return false;
  }
  if (hasDispatchTarget(normalizedAgentId)) {
    return true;
  }

  await ensureRuntimeAgentsLoaded(logger);
  if (hasDispatchTarget(normalizedAgentId)) {
    return true;
  }

  try {
    await access(agentWorkspace(normalizedAgentId));
    ensureDispatchTargetState(normalizedAgentId);
    logger?.info?.(`[dispatch-state] dynamically registered workspace target ${normalizedAgentId}`);
    return true;
  } catch {
    return false;
  }
}

function removeQueuedContract(state, contractId) {
  if (!state || !Array.isArray(state.queue) || !contractId) return false;
  const before = state.queue.length;
  state.queue = state.queue.filter((entry) => {
    if (typeof entry === "string") return entry !== contractId;
    return entry?.contractId !== contractId;
  });
  return state.queue.length !== before;
}

function flattenQueuedContracts() {
  const queue = [];
  for (const [, state] of dispatchTargetStateMap.entries()) {
    if (!Array.isArray(state?.queue)) continue;
    for (const entry of state.queue) {
      if (typeof entry === "string") {
        queue.push(entry);
        continue;
      }
      if (entry?.contractId) {
        queue.push(entry.contractId);
      }
    }
  }
  return queue;
}

export async function syncDispatchTargets(targetIds, logger) {
  const targetSet = new Set(Array.isArray(targetIds) ? targetIds.filter(Boolean) : []);

  for (const agentId of targetSet) {
    ensureDispatchTargetState(agentId);
  }

  for (const [agentId, state] of [...dispatchTargetStateMap.entries()]) {
    const hasQueuedWork = Array.isArray(state?.queue) && state.queue.length > 0;
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

export function buildDispatchRuntimeSnapshot() {
  const targets = {};
  for (const [id, state] of dispatchTargetStateMap.entries()) {
    targets[id] = {
      busy: state.busy,
      healthy: state.healthy,
      dispatching: state.dispatching,
      currentContract: state.currentContract,
      lastSeen: state.lastSeen || null,
      queue: Array.isArray(state.queue)
        ? state.queue
          .map((entry) => (typeof entry === "string" ? entry : entry?.contractId || null))
          .filter(Boolean)
        : [],
    };
  }
  return {
    targets,
    queue: flattenQueuedContracts(),
    ts: Date.now(),
  };
}

export function emitDispatchRuntimeSnapshot() {
  broadcast("alert", {
    type: EVENT_TYPE.DISPATCH_RUNTIME_STATE,
    ...buildDispatchRuntimeSnapshot(),
  });
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
  const state = ensureDispatchTargetState(agentId);
  removeQueuedContract(state, contractId);

  state.busy = true;
  state.dispatching = false;
  state.currentContract = contractId;
  state.lastSeen = Date.now();

  emitDispatchRuntimeSnapshot();
  await persistDispatchRuntimeState(logger);
  return true;
}

export async function releaseDispatchTargetContract({ agentId, logger }) {
  const state = dispatchTargetStateMap.get(agentId);
  if (!state) return false;

  state.busy = false;
  state.dispatching = false;
  state.currentContract = null;
  state.lastSeen = Date.now();
  logger?.info?.(`[dispatch-state] ${agentId} released`);
  emitDispatchRuntimeSnapshot();
  await persistDispatchRuntimeState(logger);
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

  const changed = removedFromQueues > 0
    || clearedDispatching > 0
    || clearedIdleCurrent > 0
    || releasedBusyCurrent > 0;
  if (changed) {
    emitDispatchRuntimeSnapshot();
    await persistDispatchRuntimeState(logger);
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
  const exists = state.queue.some((entry) => (
    typeof entry === "string" ? entry === normalized : entry?.contractId === normalized
  ));
  if (!exists) {
    state.queue.push({
      contractId: normalized,
      ...(meta && typeof meta === "object" ? meta : {}),
    });
    logger?.info?.(`[dispatch-state] queued ${normalized} for ${agentId} (depth: ${state.queue.length})`);
    emitDispatchRuntimeSnapshot();
    void persistDispatchRuntimeState(logger);
  }
  return true;
}

export function dequeueDispatchContract(agentId) {
  const state = dispatchTargetStateMap.get(agentId);
  if (!state || !Array.isArray(state.queue) || state.queue.length === 0) return null;
  const entry = state.queue.shift();
  emitDispatchRuntimeSnapshot();
  return typeof entry === "string"
    ? { contractId: entry, fromAgent: null }
    : entry;
}

export function getDispatchQueueDepth(agentId) {
  const state = dispatchTargetStateMap.get(agentId);
  return Array.isArray(state?.queue) ? state.queue.length : 0;
}

export function advanceDispatchRoundRobinCursor(agentId, modulo) {
  const state = ensureDispatchTargetState(agentId);
  const normalizedModulo = Number.isInteger(modulo) && modulo > 0 ? modulo : 1;
  const current = state.roundRobinCursor % normalizedModulo;
  state.roundRobinCursor = current + 1;
  return current;
}

export function queuePendingDispatchContract(agentId, contractId, meta = {}, logger) {
  const normalized = typeof contractId === "string" && contractId.trim() ? contractId.trim() : null;
  if (!normalized) {
    return { queued: false, reason: "invalid_contract_id" };
  }
  if (!hasDispatchTarget(agentId)) {
    return { queued: false, reason: "unknown_dispatch_target" };
  }
  const state = ensureDispatchTargetState(agentId);
  const before = getDispatchQueueDepth(agentId);
  const queued = enqueueDispatchContract(agentId, normalized, meta, logger);
  const after = getDispatchQueueDepth(agentId);
  return {
    queued,
    reason: !queued
      ? "queue_failed"
      : after > before
        ? "enqueued"
        : "already_scheduled",
  };
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
        lastSeen: state.lastSeen || null,
        queue: Array.isArray(state.queue) ? state.queue : [],
        roundRobinCursor: Number.isInteger(state.roundRobinCursor) ? state.roundRobinCursor : 0,
      };
    }
    await atomicWriteFile(QUEUE_STATE_FILE, JSON.stringify({
      targets: savedTargets,
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
  } catch {}

  for (const state of dispatchTargetStateMap.values()) {
    state.busy = false;
    state.dispatching = false;
    state.currentContract = null;
    state.queue = [];
    state.roundRobinCursor = 0;
  }

  const targetEntries = persisted?.targets && typeof persisted.targets === "object"
    ? Object.entries(persisted.targets)
    : [];

  for (const [agentId, savedState] of targetEntries) {
    const state = ensureDispatchTargetState(agentId);
    state.healthy = savedState?.healthy !== false;
    state.lastSeen = savedState?.lastSeen || state.lastSeen || Date.now();
    state.roundRobinCursor = Number.isInteger(savedState?.roundRobinCursor)
      ? savedState.roundRobinCursor
      : 0;
    state.queue = Array.isArray(savedState?.queue)
      ? savedState.queue
          .map((entry) => (typeof entry === "string" ? { contractId: entry } : entry))
          .filter((entry) => entry?.contractId)
      : [];
  }

  const recovered = flattenQueuedContracts();
  if (recovered.length > 0) {
    logger?.info?.(`[dispatch-state] restored ${recovered.length} queued contract(s)`);
  }
  emitDispatchRuntimeSnapshot();
}

export function resetAllDispatchStates() {
  for (const [, state] of dispatchTargetStateMap) {
    state.busy = false;
    state.dispatching = false;
    state.currentContract = null;
    state.roundRobinCursor = 0;
  }
  emitDispatchRuntimeSnapshot();
}

export function clearDispatchQueue() {
  let count = 0;
  for (const [, state] of dispatchTargetStateMap) {
    if (Array.isArray(state.queue)) {
      count += state.queue.length;
      state.queue = [];
    }
  }
  emitDispatchRuntimeSnapshot();
  return count;
}
