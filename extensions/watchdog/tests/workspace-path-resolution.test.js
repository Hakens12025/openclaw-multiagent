import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { agentWorkspace, resolveWorkspacePath, runtimeAgentConfigs } from "../lib/state.js";
import { registerTestAgent } from "./helpers/register-agent.js";

test.afterEach(() => {
  runtimeAgentConfigs.clear();
});

test("relative paths resolve against the agent workspace", () => {
  const agentId = registerTestAgent(`ws-path-rel-${Date.now()}`);
  assert.equal(
    resolveWorkspacePath("outbox/result.md", agentWorkspace(agentId)),
    join(agentWorkspace(agentId), "outbox", "result.md"),
  );
});

test("ws/output/<basename> is NOT remapped to contract.output (fake-credit seam H4e closed)", () => {
  const agentId = registerTestAgent(`ws-path-noremap-${Date.now()}`);
  const localOutput = join(agentWorkspace(agentId), "output", "TC-999.md");
  // The old alias remap returned contract.output here, awarding commit credit
  // for bytes that never reached the truth file. Now the path stays itself.
  assert.equal(
    resolveWorkspacePath(localOutput, agentWorkspace(agentId)),
    localOutput,
  );
});

test("absolute paths pass through resolved; tilde expands; empty stays empty", () => {
  const agentId = registerTestAgent(`ws-path-abs-${Date.now()}`);
  const workspace = agentWorkspace(agentId);
  assert.equal(resolveWorkspacePath("/tmp/x/../y.md", workspace), "/tmp/y.md");
  assert.equal(
    resolveWorkspacePath("~/.openclaw/workspaces/z/outbox/a.md", workspace),
    join(process.env.HOME, ".openclaw", "workspaces", "z", "outbox", "a.md"),
  );
  assert.equal(resolveWorkspacePath("", workspace), "");
});
