// Re-export facade — keeps all callers stable after god-object split.
// Implementation lives in:
//   agent-binding-store-read.js    (normalizeStoredAgentModelRef, readStoredAgentBinding)
//   agent-binding-store-write.js   (writeStoredAgentBinding)
// Normalize helpers (normalizeStoredAgentConfig, normalizeStoredAgentBindings) stay here.

import { normalizeRecord, uniqueStrings } from "../core/normalize.js";
import { readStoredAgentBinding } from "./agent-binding-store-read.js";
import { writeStoredAgentBinding } from "./agent-binding-store-write.js";

export { normalizeStoredAgentModelRef, readStoredAgentBinding } from "./agent-binding-store-read.js";
export { writeStoredAgentBinding } from "./agent-binding-store-write.js";

export function normalizeStoredAgentConfig(agentConfig, config = null) {
  const normalized = {
    ...normalizeRecord(agentConfig),
  };
  writeStoredAgentBinding(normalized, readStoredAgentBinding(normalized), { config });
  return normalized;
}

export function normalizeStoredAgentBindings(config) {
  const source = normalizeRecord(config);
  const agents = Array.isArray(source?.agents?.list) ? source.agents.list : null;
  if (!agents) {
    return false;
  }

  let changed = false;
  source.agents.list = agents.map((agentConfig) => {
    const previous = JSON.stringify(agentConfig);
    const next = normalizeStoredAgentConfig(agentConfig, source);
    if (previous !== JSON.stringify(next)) {
      changed = true;
    }
    return next;
  });
  return changed;
}
