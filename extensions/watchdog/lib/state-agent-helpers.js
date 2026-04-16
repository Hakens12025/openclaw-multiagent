// state-agent-helpers.js — Agent identity and workspace helpers
import { join, resolve } from "node:path";
import { HOME } from "./state-paths.js";
import { runtimeAgentConfigs } from "./state-collections.js";
import { AGENT_ROLE, AGENT_WORKSPACE_OVERRIDES } from "./agent/agent-metadata.js";

function expandHomePath(filePath) {
  return typeof filePath === "string" && filePath.trim()
    ? filePath.trim().replace(/^~(?=\/|$)/, HOME)
    : null;
}

export const isWorker = (agentId) => {
  const normalizedAgentId = typeof agentId === "string" ? agentId.trim() : "";
  if (!normalizedAgentId) return false;
  const configuredRole = runtimeAgentConfigs.get(normalizedAgentId)?.role;
  if (configuredRole) return configuredRole === AGENT_ROLE.EXECUTOR;
  return normalizedAgentId.startsWith("worker-");
};

export function agentWorkspace(agentId) {
  const configuredWorkspace = expandHomePath(runtimeAgentConfigs.get(agentId)?.workspace);
  if (configuredWorkspace) {
    return resolve(configuredWorkspace);
  }

  const dir = AGENT_WORKSPACE_OVERRIDES[agentId] || `workspaces/${agentId}`;
  return join(HOME, ".openclaw", dir);
}
