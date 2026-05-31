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
import { listArtifactLaneBindingsForRole } from "./artifact-lane-registry.js";
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
  //   - 去重并发 tracker 的 agent（旧 executor 分支）：检查 contract/artifactContext/inbox 文件。
  //   - 不去重的 contract-gated agent（旧 researcher 分支）：只检查 inbox/contract.json 文件。
  if (agentRequiresContractForHeartbeat(agentId)) {
    if (agentDedupesConcurrentTrackerForHeartbeat(agentId)) {
      if (hasConcurrentAgentTracker(agentId, sessionKey)) {
        return false;
      }
      return Boolean(trackingState?.contract)
        || Boolean(trackingState?.artifactContext)
        || await fileExists(join(ws, "inbox", "contract.json"));
    }
    return await fileExists(join(ws, "inbox", "contract.json"));
  }

  // Agents with artifact lane bindings (resolved via capability preset skills)
  // have actionable work only when an artifact inbox payload or active artifact
  // context is present. This covers any role whose preset includes "review-findings".
  const artifactBindings = listArtifactLaneBindingsForRole(identity.role);
  if (artifactBindings.length > 0) {
    const hasArtifactInbox = (await Promise.all(
      artifactBindings.map((binding) => fileExists(join(ws, "inbox", binding.fileName))),
    )).some(Boolean);
    // A bound contract is actionable work regardless of artifact bindings.
    // Loop reviewer stage gets a contract (not a flat artifact-inbox file), so without
    // this an artifact-lane role with a live contract was misclassified as idle →
    // its agent_end got skipped → the loop never advanced past the reviewer stage.
    return Boolean(trackingState?.contract)
      || Boolean(trackingState?.artifactContext)
      || hasArtifactInbox;
  }

  // Non-gateway/non-executor agents remain permissive.

  return true;
}
