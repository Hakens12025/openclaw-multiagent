// dispatch-runtime-normalize.js — pure normalization helpers for dispatch state
//
// All functions are pure (no side effects, no Map mutations).
// This is a leaf module: it does not import from other routing modules.

import {
  dispatchOutgoingStateMap,
  dispatchTargetStateMap,
} from "../state.js";
import {
  AGENT_ROLE,
  getAgentIdentitySnapshot,
  listRuntimeAgentIds,
} from "../agent/agent-identity.js";

export function createDispatchTargetState() {
  return {
    busy: false,
    healthy: true,
    dispatching: false,
    lastSeen: Date.now(),
    currentContract: null,
    dispatchingQueueEntry: null,
    queue: [],
  };
}

export function normalizeIncomingDispatchEntry(targetAgentId, entry) {
  const source = typeof entry === "string"
    ? { contractId: entry }
    : (entry && typeof entry === "object" ? entry : {});
  const normalizedContractId = typeof source.contractId === "string" && source.contractId.trim()
    ? source.contractId.trim()
    : null;
  if (!normalizedContractId) return null;
  const fromAgent = typeof source.fromAgent === "string" && source.fromAgent.trim()
    ? source.fromAgent.trim()
    : null;
  return {
    contractId: normalizedContractId,
    fromAgent,
    targetAgent: targetAgentId,
  };
}

export function ensureDispatchTargetState(agentId) {
  if (!dispatchTargetStateMap.has(agentId)) {
    dispatchTargetStateMap.set(agentId, createDispatchTargetState());
  }
  const state = dispatchTargetStateMap.get(agentId);
  if (!Array.isArray(state.queue)) {
    state.queue = [];
  }
  delete state.outgoingQueue;
  state.dispatchingQueueEntry = normalizeIncomingDispatchEntry(agentId, state.dispatchingQueueEntry);
  return state;
}

export function ensureDispatchOutgoingState(sourceAgentId) {
  if (!dispatchOutgoingStateMap.has(sourceAgentId)) {
    dispatchOutgoingStateMap.set(sourceAgentId, { outgoingQueue: [] });
  }
  const state = dispatchOutgoingStateMap.get(sourceAgentId);
  if (!Array.isArray(state.outgoingQueue)) {
    state.outgoingQueue = [];
  }
  return state;
}

export function collectDispatchRuntimeTargetIds() {
  const dispatchRoles = new Set([
    AGENT_ROLE.PLANNER,
    AGENT_ROLE.EXECUTOR,
    AGENT_ROLE.RESEARCHER,
    AGENT_ROLE.REVIEWER,
    AGENT_ROLE.AGENT,
  ]);
  return listRuntimeAgentIds().filter((agentId) => {
    const snapshot = getAgentIdentitySnapshot(agentId);
    return snapshot.plane === "runtime"
      && snapshot.mainViewVisible !== false
      && dispatchRoles.has(snapshot.role);
  });
}

export function removeQueuedContract(state, contractId) {
  if (!state || !Array.isArray(state.queue) || !contractId) return false;
  const before = state.queue.length;
  state.queue = state.queue.filter((entry) => {
    if (typeof entry === "string") return entry !== contractId;
    return entry?.contractId !== contractId;
  });
  return state.queue.length !== before;
}

export function clearDispatchingQueueEntry(state, contractId = null) {
  if (!state?.dispatchingQueueEntry) return false;
  if (contractId && state.dispatchingQueueEntry.contractId !== contractId) return false;
  state.dispatchingQueueEntry = null;
  return true;
}

export function removeOutgoingQueuedContract(state, contractId) {
  if (!state || !Array.isArray(state.outgoingQueue) || !contractId) return false;
  const before = state.outgoingQueue.length;
  state.outgoingQueue = state.outgoingQueue.filter((entry) => entry?.contractId !== contractId);
  return state.outgoingQueue.length !== before;
}

export function isIdleDispatchState(state) {
  return state
    && state.busy !== true
    && state.dispatching !== true
    && !state.currentContract
    && !state.dispatchingQueueEntry
    && (!Array.isArray(state.queue) || state.queue.length === 0);
}

export function normalizeOutgoingDispatchEntry(sourceAgentId, contractId, meta = {}) {
  const normalizedContractId = typeof contractId === "string" && contractId.trim()
    ? contractId.trim()
    : null;
  if (!normalizedContractId) return null;
  const targetAgent = typeof meta?.targetAgent === "string" && meta.targetAgent.trim()
    ? meta.targetAgent.trim()
    : null;
  const status = typeof meta?.status === "string" && meta.status.trim()
    ? meta.status.trim()
    : "ready";
  const routeEdge = meta?.routeEdge && typeof meta.routeEdge === "object"
    ? {
      from: meta.routeEdge.from || sourceAgentId,
      to: meta.routeEdge.to || targetAgent,
      direction: meta.routeEdge.direction || null,
    }
    : null;
  return {
    contractId: normalizedContractId,
    fromAgent: sourceAgentId,
    targetAgent,
    status,
    ...(routeEdge ? { routeEdge } : {}),
  };
}
