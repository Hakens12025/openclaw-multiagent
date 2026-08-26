// tests/realpath-write-guard.test.js — write guards judge PHYSICAL paths:
// a workspace-internal symlink pointing outside must be judged by its target,
// while normal paths (including not-yet-existing new files) keep their
// lexical behavior. Driven through the before_tool_call guard chain, plus the
// checkToolCall sensitive-path rule and the harness scope guard.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as beforeToolCallHook from "../hooks/before-tool-call.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { createTrackingState } from "../lib/session/session-bootstrap.js";
import { resolvePhysicalWorkspacePath, runtimeAgentConfigs } from "../lib/state.js";
import { clearTrackingStore, rememberTrackingState } from "../lib/store/tracker-store.js";

const logger = { info() {}, warn() {}, error() {} };

function hook() {
  const handlers = new Map();
  beforeToolCallHook.register({ on: (e, h) => handlers.set(e, h) }, logger);
  return handlers.get("before_tool_call");
}

function registerAgents(list) {
  registerRuntimeAgents({
    agents: {
      list: list.map(({ id, role = "executor", workspace }) => ({
        id,
        role,
        workspace,
        model: { primary: "demo/worker" },
      })),
    },
  });
}

const tempRoots = [];
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

test.afterEach(() => {
  runtimeAgentConfigs.clear();
  clearTrackingStore();
  while (tempRoots.length) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

test("helper: not-yet-existing tail segments join lexically onto the physical ancestor", () => {
  const ws = makeTempDir("realpath-guard-helper-");
  const physicalWs = realpathSync(ws);
  assert.equal(
    resolvePhysicalWorkspacePath(join(ws, "a", "b", "c.md")),
    join(physicalWs, "a", "b", "c.md"),
  );
});

test("symlink escaping into another agent's workspace is blocked on the physical path", async () => {
  const wsA = makeTempDir("realpath-guard-a-");
  const wsB = makeTempDir("realpath-guard-b-");
  const agentA = "worker-realpath-a";
  registerAgents([
    { id: agentA, workspace: wsA },
    { id: "worker-realpath-b", workspace: wsB },
  ]);
  symlinkSync(wsB, join(wsA, "escape"));

  const handler = hook();
  const result = await handler(
    { toolName: "write", params: { file_path: join(wsA, "escape", "forged.md"), content: "x" } },
    { agentId: agentA, sessionKey: `agent:${agentA}:main` },
  );
  assert.equal(result?.block, true, "lexically in-workspace symlink target must be judged physically");
  assert.match(result?.blockReason || "", /工作区/u);
});

test("symlink pointing inside the same workspace stays allowed", async () => {
  const wsA = makeTempDir("realpath-guard-self-");
  const agentA = "worker-realpath-self";
  registerAgents([{ id: agentA, workspace: wsA }]);
  mkdirSync(join(wsA, "real-dir"));
  symlinkSync(join(wsA, "real-dir"), join(wsA, "alias"));

  const handler = hook();
  const result = await handler(
    { toolName: "write", params: { file_path: join(wsA, "alias", "note.md"), content: "x" } },
    { agentId: agentA, sessionKey: `agent:${agentA}:main` },
  );
  assert.equal(result?.block, undefined);
});

test("normal not-yet-existing file paths in the own workspace stay allowed (absolute and relative)", async () => {
  const wsA = makeTempDir("realpath-guard-plain-");
  const agentA = "worker-realpath-plain";
  registerAgents([{ id: agentA, workspace: wsA }]);

  const handler = hook();
  const absolute = await handler(
    { toolName: "write", params: { file_path: join(wsA, "outbox", "new-file.md"), content: "x" } },
    { agentId: agentA, sessionKey: `agent:${agentA}:main` },
  );
  assert.equal(absolute?.block, undefined);

  const relative = await handler(
    { toolName: "write", params: { file_path: "outbox/draft.md", content: "x" } },
    { agentId: agentA, sessionKey: `agent:${agentA}:main` },
  );
  assert.equal(relative?.block, undefined);
});

test("operator guard judges symlink escapes physically", async () => {
  const wsOp = makeTempDir("realpath-guard-op-");
  const external = makeTempDir("realpath-guard-ext-");
  registerAgents([{ id: "operator", role: "agent", workspace: wsOp }]);
  symlinkSync(external, join(wsOp, "leak"));

  const handler = hook();
  const result = await handler(
    { toolName: "write", params: { file_path: join(wsOp, "leak", "x.md"), content: "x" } },
    { agentId: "operator", sessionKey: "agent:operator:main" },
  );
  assert.equal(result?.block, true, "operator write through an escaping symlink must be blocked");
  assert.match(result?.blockReason || "", /meta-agent|CLI-system|admin surface/u);
});

test("harness scope guard judges symlink escapes physically; in-root writes stay allowed", async () => {
  const wsA = makeTempDir("realpath-guard-harness-");
  const external = makeTempDir("realpath-guard-harness-ext-");
  const agentA = "worker-realpath-harness";
  registerAgents([{ id: agentA, workspace: wsA }]);
  symlinkSync(external, join(wsA, "out"));

  const sessionKey = `agent:${agentA}:contract:test`;
  const trackingState = createTrackingState({ sessionKey, agentId: agentA, parentSession: null });
  trackingState.contract = {
    id: "TC-realpath-harness",
    assignee: agentA,
    output: join(wsA, "output", "TC-realpath-harness.md"),
    status: "running",
    automationContext: {
      harness: {
        moduleConfig: {
          "guard.scope": { allowedWorkspaceRoots: [wsA] },
        },
      },
    },
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);

  const handler = hook();
  const escaped = await handler(
    { toolName: "write", params: { file_path: join(wsA, "out", "report.md"), content: "x" } },
    { agentId: agentA, sessionKey },
  );
  assert.equal(escaped?.block, true, "scope roots must be enforced on the physical path");
  assert.match(escaped?.blockReason || "", /沙箱边界/u);

  const inside = await handler(
    { toolName: "write", params: { file_path: join(wsA, "outbox", "report.md"), content: "x" } },
    { agentId: agentA, sessionKey },
  );
  assert.equal(inside?.block, undefined, "physical in-root write stays allowed even with /var-vs-/private lexical drift");
});

test("checkToolCall sensitive-path rule sees the symlink's physical target", async () => {
  const wsA = makeTempDir("realpath-guard-sec-");
  const external = makeTempDir("realpath-guard-sec-ext-");
  const agentA = "worker-realpath-sec";
  registerAgents([{ id: agentA, workspace: wsA }]);
  // Dangling symlink: the target file does not exist yet — writing through it
  // would CREATE the sensitive-named target, so it must still be resolved.
  symlinkSync(join(external, "credentials", "secret.txt"), join(wsA, "innocent.md"));

  const handler = hook();
  const result = await handler(
    { toolName: "write", params: { file_path: join(wsA, "innocent.md"), content: "hello" } },
    { agentId: agentA, sessionKey: `agent:${agentA}:main` },
  );
  assert.equal(result?.block, true, "innocently named symlink to a sensitive path must be blocked");
  assert.match(result?.blockReason || "", /安全策略/u);
});

test("inbox 域读范围按物理目标判:inbox 内文件级链指向外部必须拦(词法拼写不是授权面)", async () => {
  const ws = makeTempDir("realpath-guard-inboxread-");
  const outside = makeTempDir("realpath-guard-outside-");
  const agentId = "planner-inboxread";
  registerAgents([{ id: agentId, role: "planner", workspace: ws }]);
  mkdirSync(join(ws, "inbox"), { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(outside, "secret.md"), "leak\n", "utf8");
  symlinkSync(join(outside, "secret.md"), join(ws, "inbox", "leak.md"));
  writeFileSync(join(ws, "inbox", "legit.md"), "ok\n", "utf8");

  const handler = hook();
  const escaped = await handler(
    { toolName: "read", params: { file_path: join(ws, "inbox", "leak.md") } },
    { agentId, sessionKey: `agent:${agentId}:main` },
  );
  assert.equal(escaped?.block, true, "inbox 内指向外部的文件级链读=词法逃逸,必须按物理目标拦(审查 2026-08-16 回归)");

  const legit = await handler(
    { toolName: "read", params: { file_path: join(ws, "inbox", "legit.md") } },
    { agentId, sessionKey: `agent:${agentId}:main` },
  );
  assert.equal(legit?.block, undefined, "真 inbox 内真文件读必须照常放行");
});

test("树店写屏障:上游链下写/改必拦,自己 outbox 链下写放行,树内直写必拦", async () => {
  const { mkdtempSync: mkdtemp2 } = await import("node:fs");
  const { writeFileSync } = await import("node:fs");
  // 种子树根(本测试文件不经 npm 种子跑时也要有沙箱树根)
  if (!process.env.OPENCLAW_THREADS_DIR) {
    process.env.OPENCLAW_THREADS_DIR = mkdtemp2(join(tmpdir(), "guard-tree-root-"));
  }
  const treeRoot = process.env.OPENCLAW_THREADS_DIR;
  const ws = makeTempDir("treebar-ws-");
  const agentId = "worker-treebar";
  registerAgents([{ id: agentId, workspace: ws }]);

  const ownTreeOutbox = join(treeRoot, "t-bar", "runs", "r-1-bar", "participants", agentId, "outbox-TC-BAR");
  const producerTreeOutbox = join(treeRoot, "t-bar", "runs", "r-1-bar", "participants", "producer-x", "outbox-TC-BAR");
  mkdirSync(ownTreeOutbox, { recursive: true });
  mkdirSync(producerTreeOutbox, { recursive: true });
  writeFileSync(join(producerTreeOutbox, "report.md"), "sealed\n", "utf8");
  symlinkSync(ownTreeOutbox, join(ws, "outbox"));
  mkdirSync(join(ws, "inbox", "upstream"), { recursive: true });
  symlinkSync(producerTreeOutbox, join(ws, "inbox", "upstream", "producer-x"));

  const handler = hook();
  const ownWrite = await handler(
    { toolName: "write", params: { file_path: join(ws, "outbox", "note.md"), content: "x" } },
    { agentId, sessionKey: `agent:${agentId}:main` },
  );
  assert.equal(ownWrite?.block, undefined, "经自己 outbox 链写树=唯一合法通道,必须放行");

  const upstreamEdit = await handler(
    { toolName: "edit", params: { file_path: join(ws, "inbox", "upstream", "producer-x", "report.md") } },
    { agentId, sessionKey: `agent:${agentId}:main` },
  );
  assert.equal(upstreamEdit?.block, true, "经上游链改产者封包正本=篡改,必须拦(审验 2026-08-16)");

  const sealForge = await handler(
    { toolName: "write", params: { file_path: join(ws, "inbox", "upstream", "producer-x", "seal.json"), content: "{}" } },
    { agentId, sessionKey: `agent:${agentId}:main` },
  );
  assert.equal(sealForge?.block, true, "伪造 seal 必须拦");

  const directTree = await handler(
    { toolName: "write", params: { file_path: join(producerTreeOutbox, "inject.md"), content: "x" } },
    { agentId, sessionKey: `agent:${agentId}:main` },
  );
  assert.equal(directTree?.block, true, "树内任意直写必须拦");
});
