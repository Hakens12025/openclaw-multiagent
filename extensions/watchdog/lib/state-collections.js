// state-collections.js — Shared mutable state containers

export const sseClients = new Set();
export const taskHistory = [];
export const tracker = new Map();           // sessionKey → TrackingState
export const dispatchChain = new Map();     // targetAgent → {originAgentId, originSessionKey, ts}
export const intervalHandles = [];
export const dispatchTargetStateMap = new Map(); // targetAgent → { busy, healthy, dispatching, lastSeen, currentContract, queue }
export const agentCards = new Map();        // agentId → card JSON
export const runtimeAgentConfigs = new Map(); // agentId → normalized config snapshot
export const qqTypingIntervals = new Map(); // contractId → intervalHandle
export const ignoredHeartbeatSessions = new Set(); // sessionKey set

// Mutable Config (set at register time)
export const cfg = {
  hooksToken: "",
  gatewayPort: 18789,
  qqAppId: "",
  qqClientSecret: "",
  agentTimeout: 1800000,
  gatewayToken: "",
};

// API reference (set at gateway_start, used by dequeue follow-up)
export let apiRef = null;
export function setApiRef(api) { apiRef = api; }
