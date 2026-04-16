import { AGENT_ROLE } from "./agent-metadata.js";
import { composeDefaultCapabilityProjection } from "./agent-capability-policy.js";
import { getRoleSummary } from "../role-spec-registry.js";

export function composeAgentCardBase({ agentId, role }) {
  return {
    id: agentId,
    name: `Agent ${agentId}`,
    version: "1.0.0",
    description: getRoleSummary(role),
    url: `/a2a/agents/${agentId}`,
    constraints: {
      serialExecution: role !== AGENT_ROLE.BRIDGE,
      maxConcurrent: role === AGENT_ROLE.BRIDGE ? 4 : 1,
      timeoutSeconds: 1800,
    },
    role,
  };
}

export function composeAgentCardProjection({ agentId, role, skills = [] }) {
  const baseCard = composeAgentCardBase({ agentId, role });
  return {
    ...baseCard,
    capabilities: composeDefaultCapabilityProjection({ role, skills }),
  };
}
