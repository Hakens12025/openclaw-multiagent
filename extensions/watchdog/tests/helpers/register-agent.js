// tests/helpers/register-agent.js — shared runtime-agent registration for tests.
// The register + afterEach-clear pair is repeated ~130× across tests/; new
// tests should import this instead of minting copy #131.
import { registerRuntimeAgents } from "../../lib/agent/agent-identity.js";

export function registerTestAgent(agentId, { role = "executor" } = {}) {
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role,
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });
  return agentId;
}
