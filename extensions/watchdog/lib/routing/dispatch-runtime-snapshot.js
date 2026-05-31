// dispatch-runtime-snapshot.js — snapshot construction + SSE emission
//
// Reads dispatchTargetStateMap / dispatchOutgoingStateMap (shared state from
// state.js) and projects a serializable runtime snapshot.  No mutations here.

import { dispatchOutgoingStateMap, dispatchTargetStateMap } from "../state.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  normalizeIncomingDispatchEntry,
  normalizeOutgoingDispatchEntry,
} from "./dispatch-runtime-normalize.js";

export function flattenQueuedContracts() {
  const queue = [];
  for (const [targetAgentId, state] of dispatchTargetStateMap.entries()) {
    if (!Array.isArray(state?.queue)) continue;
    for (const entry of state.queue) {
      const normalizedEntry = normalizeIncomingDispatchEntry(targetAgentId, entry);
      if (normalizedEntry) {
        queue.push(normalizedEntry);
      }
    }
  }
  return queue;
}

export function buildOutgoingBySourceSnapshot() {
  const outgoingBySource = {};
  for (const [sourceAgentId, state] of dispatchOutgoingStateMap.entries()) {
    const outgoingQueue = Array.isArray(state?.outgoingQueue) ? state.outgoingQueue : [];
    const normalizedOutgoing = outgoingQueue
      .map((entry) => normalizeOutgoingDispatchEntry(sourceAgentId, entry?.contractId, entry))
      .filter(Boolean);
    if (normalizedOutgoing.length === 0) continue;
    outgoingBySource[sourceAgentId] = normalizedOutgoing;
  }
  return outgoingBySource;
}

export function summarizeDispatchContractFlow(runtimeSnapshot = null) {
  const targetStates = runtimeSnapshot?.targets && typeof runtimeSnapshot.targets === "object"
    ? Object.values(runtimeSnapshot.targets)
    : [...dispatchTargetStateMap.values()];
  const hasCanonicalOutgoingProjection = runtimeSnapshot?.outgoingBySource
    && typeof runtimeSnapshot.outgoingBySource === "object";
  const outgoingStates = hasCanonicalOutgoingProjection
    ? Object.values(runtimeSnapshot.outgoingBySource)
    : (
        runtimeSnapshot
          ? []
          : [...dispatchOutgoingStateMap.values()].map((state) => state?.outgoingQueue || [])
      );
  const summary = targetStates.reduce((next, state) => {
    const incomingQueue = Array.isArray(state?.queue) ? state.queue : [];
    next.incomingQueued += incomingQueue.length;
    next.running += state?.currentContract ? 1 : 0;
    return next;
  }, {
    incomingQueued: 0,
    outgoingQueued: 0,
    running: 0,
    blockedOutgoing: 0,
  });
  for (const outgoingQueue of outgoingStates) {
    const queue = Array.isArray(outgoingQueue) ? outgoingQueue : [];
    summary.outgoingQueued += queue.length;
    summary.blockedOutgoing += queue.filter((entry) => entry?.status === "blocked").length;
  }
  return summary;
}

export function buildDispatchRuntimeSnapshot() {
  const targets = {};
  for (const [id, state] of dispatchTargetStateMap.entries()) {
    targets[id] = {
      busy: state.busy,
      healthy: state.healthy,
      dispatching: state.dispatching,
      currentContract: state.currentContract,
      dispatchingQueueEntry: normalizeIncomingDispatchEntry(id, state.dispatchingQueueEntry),
      lastSeen: state.lastSeen || null,
      queue: Array.isArray(state.queue)
        ? state.queue
          .map((entry) => normalizeIncomingDispatchEntry(id, entry))
          .filter(Boolean)
        : [],
    };
  }
  const outgoingBySource = buildOutgoingBySourceSnapshot();
  return {
    targets,
    outgoingBySource,
    queue: flattenQueuedContracts(),
    contractFlow: summarizeDispatchContractFlow({ targets, outgoingBySource }),
    ts: Date.now(),
  };
}

export function emitDispatchRuntimeSnapshot() {
  broadcast("alert", {
    type: EVENT_TYPE.DISPATCH_RUNTIME_STATE,
    ...buildDispatchRuntimeSnapshot(),
  });
}
