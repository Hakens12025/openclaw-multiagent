import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import * as beforeToolCallHook from "../hooks/before-tool-call.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { agentWorkspace, runtimeAgentConfigs } from "../lib/state.js";
import { clearTrackingStore, rememberTrackingState } from "../lib/store/tracker-store.js";
import { buildLoopContract } from "../lib/loop/loop-contract-builder.js";

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
    { toolName: "edit", params: { file_path: "~/.openclaw/extensions/watchdog/lib/state.js", oldText: "a", newText: "b" } },
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
    { toolName: "write", params: { file_path: "~/.openclaw/skills/some-skill/SKILL.md", content: "x" } },
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
    { toolName: "edit", params: { file_path: "~/some-external-project/main.js", oldText: "a", newText: "b" } },
    { agentId: "worker-free", sessionKey: "agent:worker-free:main" },
  );
  assert.equal(result?.block, undefined, "executor (unrestricted) is not blocked by the operator-only code guard");
});

// ── workingDir: reviewer may read inside a contract-declared external project root ──
test("reviewer may read inside contract.workingDir (external project root)", async () => {
  const agentId = `reviewer-workingdir-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  const projectRoot = "~/some-external-project";
  registerRuntimeAgents({
    agents: { list: [{ id: agentId, role: "reviewer", workspace: `~/.openclaw/workspaces/${agentId}`, model: { primary: "demo/rev" } }] },
  });
  const trackingState = createTrackingState({ sessionKey, agentId, parentSession: null });
  trackingState.contract = {
    id: "TC-workingdir", assignee: agentId,
    output: join(agentWorkspace(agentId), "output", "TC-workingdir.md"),
    workingDir: projectRoot, status: "running",
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);

  const handler = hook();
  const allowed = await handler(
    { toolName: "read", params: { path: join(projectRoot, "src", "main.js") } },
    { agentId, sessionKey },
  );
  assert.equal(allowed?.block, undefined, "reviewer reads inside declared workingDir are authorized");

  // control: reading a path outside inbox/output/workingDir is still blocked for reviewer
  const blocked = await handler(
    { toolName: "read", params: { path: "~/unrelated/elsewhere.txt" } },
    { agentId, sessionKey },
  );
  assert.equal(blocked?.block, true, "reviewer reads outside contract scope stay blocked");
  assert.match(blocked?.blockReason || "", /读取范围|inbox/u);
});

test("buildLoopContract carries a declared workingDir onto the contract", () => {
  const contract = buildLoopContract({
    contractId: "TC-wd-test",
    loop: { id: "loop-x", nodes: ["a", "b"], entryAgentId: "a", continueSignal: "continue", concludeSignal: "conclude" },
    loopSessionId: "LS-wd-test",
    startAgent: "a",
    requestedTask: "do the project work",
    workingDir: "~/project-root",
  });
  assert.equal(contract.workingDir, "~/project-root");
  // and omitted cleanly when not declared
  const noWd = buildLoopContract({
    contractId: "TC-no-wd", loop: { id: "loop-y", nodes: ["a", "b"], entryAgentId: "a", continueSignal: "continue", concludeSignal: "conclude" },
    loopSessionId: "LS-no-wd", startAgent: "a", requestedTask: "x",
  });
  assert.equal("workingDir" in noWd, false);
});
