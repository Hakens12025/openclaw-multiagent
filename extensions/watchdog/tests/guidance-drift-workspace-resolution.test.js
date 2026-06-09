import test from "node:test";
import assert from "node:assert/strict";

import { composeAgentBinding } from "../lib/effective-profile-composer.js";
import { scanWorkspaceGuidanceDriftForConfig } from "../lib/agent/agent-guidance-drift.js";

test("composeAgentBinding uses top-level workspace when binding workspace is absent", () => {
  const binding = composeAgentBinding({
    config: { agents: { list: [] } },
    agentConfig: {
      id: "drift-agent",
      role: "executor",
      workspace: "~/.openclaw/workspaces/drift-agent",
    },
  });

  assert.equal(binding.workspace.configured, "/Users/hakens/.openclaw/workspaces/drift-agent");
  assert.equal(binding.workspace.effective, "/Users/hakens/.openclaw/workspaces/drift-agent");
});

test("guidance drift scan does not throw when workspace comes from top-level agent config", async () => {
  const scan = await scanWorkspaceGuidanceDriftForConfig({
    agents: {
      list: [
        {
          id: "drift-agent",
          role: "executor",
          workspace: "~/.openclaw/workspaces/drift-agent",
        },
      ],
    },
  }, { label: "test" });

  assert.equal(scan.label, "test");
  assert.equal(scan.perAgent.length, 1);
  assert.equal(scan.perAgent[0].agentId, "drift-agent");
  assert.equal(scan.perAgent[0].error, undefined);
});
