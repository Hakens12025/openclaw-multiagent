// lib/heartbeat-gate.js — passive session actionable-work policy

import { access } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace } from "./state.js";
import { hasConcurrentTrackingSessionForAgent } from "./store/tracker-store.js";
import {
  agentDedupesConcurrentTrackerForHeartbeat,
  agentRequiresContractForHeartbeat,
  getAgentIdentitySnapshot,
} from "./agent/agent-identity.js";
import { hasPendingSignal } from "./runtime/pending-signal-registry.js";

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hasConcurrentAgentTracker(agentId, sessionKey) {
  return hasConcurrentTrackingSessionForAgent(agentId, sessionKey);
}

export async function hasActionableHeartbeatWork(agentId, trackingState, sessionKey) {
  const identity = getAgentIdentitySnapshot(agentId);

  if (identity.plane !== "runtime") {
    return hasPendingSignal(agentId);
  }

  if (identity.gateway) {
    return hasPendingSignal(agentId);
  }

  const ws = agentWorkspace(agentId);
  if (!ws) return true;

  // P6-Phase1: contract-gated actionable-work 从 role 特化迁到 policy。
  // requiresContract 缺省等价于 (role===EXECUTOR||RESEARCHER)；
  // dedupeConcurrentTracker 缺省等价于 (role===EXECUTOR)。行为逐分支等价：
  //   - 去重并发 tracker 的 agent（旧 executor 分支）：检查 contract/inbox 文件。
  //   - 不去重的 contract-gated agent（旧 researcher 分支）：只检查 inbox/contract.json 文件。
  if (agentRequiresContractForHeartbeat(agentId)) {
    if (agentDedupesConcurrentTrackerForHeartbeat(agentId)) {
      if (hasConcurrentAgentTracker(agentId, sessionKey)) {
        return false;
      }
      return Boolean(trackingState?.contract)
        || await fileExists(join(ws, "inbox", "contract.json"));
    }
    return await fileExists(join(ws, "inbox", "contract.json"));
  }

  // Non-gateway/non-executor agents remain permissive.

  return true;
}
