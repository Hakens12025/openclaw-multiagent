import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import * as beforeToolCallHook from "../hooks/before-tool-call.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { agentWorkspace, runtimeAgentConfigs } from "../lib/state.js";
import { clearTrackingStore } from "../lib/store/tracker-store.js";

const logger = { info() {}, warn() {}, error() {} };

function hook() {
  const handlers = new Map();
  beforeToolCallHook.register({ on: (e, h) => handlers.set(e, h) }, logger);
  return handlers.get("before_tool_call");
}

test.afterEach(() => {
  runtimeAgentConfigs.clear();
  clearTrackingStore();
});

// ── B2: operator may only change the system via CLI-system, never raw write/edit on code ──
test("operator is BLOCKED from editing code outside its own workspace (CLI-system only)", async () => {
  registerRuntimeAgents({
    agents: { list: [{ id: "operator", role: "agent", workspace: "~/.openclaw/workspaces/operator", model: { primary: "demo/op" } }] },
  });
  const handler = hook();
  const result = await handler(
    { toolName: "edit", params: { file_path: "/Users/hakens/.openclaw/extensions/watchdog/lib/state.js", oldText: "a", newText: "b" } },
    { agentId: "operator", sessionKey: "agent:operator:main" },
  );
  assert.equal(result?.block, true, "operator must not edit code files directly");
  assert.match(result?.blockReason || "", /CLI-system|admin surface|meta-agent/u);
});

test("operator is BLOCKED from writing platform config outside its workspace", async () => {
  registerRuntimeAgents({
    agents: { list: [{ id: "operator", role: "agent", workspace: "~/.openclaw/workspaces/operator", model: { primary: "demo/op" } }] },
  });
  const handler = hook();
  const result = await handler(
    { toolName: "write", params: { file_path: "/Users/hakens/.openclaw/skills/some-skill/SKILL.md", content: "x" } },
    { agentId: "operator", sessionKey: "agent:operator:main" },
  );
  assert.equal(result?.block, true);
});

test("operator MAY write scratch inside its own workspace", async () => {
  registerRuntimeAgents({
    agents: { list: [{ id: "operator", role: "agent", workspace: "~/.openclaw/workspaces/operator", model: { primary: "demo/op" } }] },
  });
  const handler = hook();
  const scratch = join(agentWorkspace("operator"), "scratch", "notes.md");
  const result = await handler(
    { toolName: "write", params: { file_path: scratch, content: "thinking out loud" } },
    { agentId: "operator", sessionKey: "agent:operator:main" },
  );
  assert.equal(result?.block, undefined, "operator scratch inside its own workspace stays allowed");
});

test("the operator code guard is operator-specific (a non-operator agent is not subject to it)", async () => {
  registerRuntimeAgents({
    agents: { list: [{ id: "worker-free", role: "executor", workspace: "~/.openclaw/workspaces/worker-free", model: { primary: "demo/w" } }] },
  });
  const handler = hook();
  const result = await handler(
    { toolName: "edit", params: { file_path: "/Users/hakens/some-external-project/main.js", oldText: "a", newText: "b" } },
    { agentId: "worker-free", sessionKey: "agent:worker-free:main" },
  );
  assert.equal(result?.block, undefined, "executor (unrestricted) is not blocked by the operator-only code guard");
});
