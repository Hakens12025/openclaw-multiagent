// lib/heartbeat-gate.js — passive session actionable-work policy

import { access } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace } from "./state.js";
import { hasConcurrentTrackingSessionForAgent } from "./store/tracker-store.js";
import {
  AGENT_ROLE,
  getAgentIdentitySnapshot,
} from "./agent/agent-identity.js";
import { listArtifactLaneBindingsForRole } from "./artifact-lane-registry.js";

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

  if (identity.gateway) {
    // Gateway agents are always actionable: they may have user messages
    // (injected by framework, not via inbox files) or pending deliveries.
    // Cost of a false positive is minimal (HEARTBEAT_OK reply).
    return true;
  }

  const ws = agentWorkspace(agentId);
  if (!ws) return true;

  if (identity.role === AGENT_ROLE.EXECUTOR) {
    if (hasConcurrentAgentTracker(agentId, sessionKey)) {
      return false;
    }
    return Boolean(trackingState?.contract)
      || Boolean(trackingState?.artifactContext)
      || await fileExists(join(ws, "inbox", "contract.json"));
  }

  if (identity.role === AGENT_ROLE.RESEARCHER) {
    return await fileExists(join(ws, "inbox", "contract.json"));
  }

  if (identity.role === AGENT_ROLE.REVIEWER) {
    const artifactBindings = listArtifactLaneBindingsForRole(identity.role);
    const hasArtifactInbox = (await Promise.all(
      artifactBindings.map((binding) => fileExists(join(ws, "inbox", binding.fileName))),
    )).some(Boolean);
    return Boolean(trackingState?.artifactContext)
      || hasArtifactInbox;
  }

  // Non-gateway/non-executor agents remain permissive.

  return true;
}
