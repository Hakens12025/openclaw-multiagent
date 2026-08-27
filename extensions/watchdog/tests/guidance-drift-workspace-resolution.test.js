import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import { composeAgentBinding } from "../lib/effective-profile-composer.js";
import { scanWorkspaceGuidanceDriftForConfig } from "../lib/agent/agent-guidance-drift.js";

// 期望值随 homedir 走:被测的 ~ 展开本来就是相对当前 HOME 的,写死 /Users/<user> 在 CI/别机必红。
const DRIFT_WS = join(homedir(), ".openclaw", "workspaces", "drift-agent");

test("composeAgentBinding uses top-level workspace when binding workspace is absent", () => {
  const binding = composeAgentBinding({
    config: { agents: { list: [] } },
    agentConfig: {
      id: "drift-agent",
      role: "executor",
      workspace: "~/.openclaw/workspaces/drift-agent",
    },
  });

  assert.equal(binding.workspace.configured, DRIFT_WS);
  assert.equal(binding.workspace.effective, DRIFT_WS);
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
