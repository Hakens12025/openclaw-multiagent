// tests/discovery-guard-scope.test.js — D-G 安全红线:ls/grep 经
// DISCOVERY_TOOL_PATTERN 与 read 走同一片路径域(2b)与敏感文件检查
// (checkToolCall Rule 1a)。不加这层,scope=workspace 的 planner 会被开出
// 全盘目录发现的洞。
// 2026-08-26 用户裁决:planner readPathScope inbox→workspace——可列自己整个工作区
// (含 inbox/outbox + 无 path=工作区根),但出了工作区仍拦(系统面/别的 agent)。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as beforeToolCallHook from "../hooks/before-tool-call.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { runtimeAgentConfigs } from "../lib/state.js";
import { clearTrackingStore } from "../lib/store/tracker-store.js";

const logger = { info() {}, warn() {}, error() {} };

function hook() {
  const handlers = new Map();
  beforeToolCallHook.register({ on: (e, h) => handlers.set(e, h) }, logger);
  return handlers.get("before_tool_call");
}

const tempRoots = [];
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function registerAgent(agentId, role, workspace) {
  registerRuntimeAgents({
    agents: {
      list: [{ id: agentId, role, workspace, model: { primary: "demo/worker" } }],
    },
  });
}

test.afterEach(() => {
  runtimeAgentConfigs.clear();
  clearTrackingStore();
  while (tempRoots.length) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

test("planner(scope=workspace):ls 可列自己工作区(inbox/outbox/无path);出工作区拦", async () => {
  const ws = makeTempDir("discovery-planner-ls-");
  const outsideDir = makeTempDir("discovery-outside-ls-"); // 工作区外的另一目录(非敏感)
  const agentId = "planner-discovery-ls";
  registerAgent(agentId, "planner", ws);
  mkdirSync(join(ws, "inbox"), { recursive: true });
  mkdirSync(join(ws, "outbox"), { recursive: true });
  writeFileSync(join(ws, "inbox", "contract.json"), "{}\n");

  const handler = hook();
  const ctx = { agentId, sessionKey: `agent:${agentId}:main` };

  // 工作区内一律放行:inbox / outbox / 无 path(=工作区根)
  const inbox = await handler({ toolName: "ls", params: { path: join(ws, "inbox") } }, ctx);
  assert.equal(inbox?.block, undefined, "ls 自己 inbox 放行");
  const outbox = await handler({ toolName: "ls", params: { path: join(ws, "outbox") } }, ctx);
  assert.equal(outbox?.block, undefined, "ls 自己 outbox 放行(工作区内,inbox 外)");
  const noPath = await handler({ toolName: "ls", params: {} }, ctx);
  assert.equal(noPath?.block, undefined, "ls 无 path=工作区根,workspace scope 放行");

  // 出了工作区仍拦
  const outside = await handler({ toolName: "ls", params: { path: outsideDir } }, ctx);
  assert.equal(outside?.block, true, "ls 列工作区外目录必须拦");
  assert.match(outside?.blockReason || "", /路径限制/u);
});

test("planner(scope=workspace):合约轮软链化邮箱照样放行——规则问域属主,锚集不在规则手里(备忘录157 §二)", async () => {
  // 域单源的规则级端到端证明:合约轮 outbox/inbox 软链进树,目标物理化落树内。
  // 曾经的裸 ws 单锚在此误拦(备忘录156 实锤,live planner 自述 "ls of outbox failed");
  // 域单源下规则只问 isInAgentDomain——挂载形态的判定属主在 agent-domain(那边已全测),
  // 本测试只锁"规则确实在问域"。
  const ws = makeTempDir("discovery-planner-symlink-");
  const treeRoot = makeTempDir("discovery-tree-");
  const agentId = "planner-discovery-symlink";
  registerAgent(agentId, "planner", ws);
  const treeOutbox = join(treeRoot, "participants", agentId, "outbox-TC-SYM");
  const treeInbox = join(treeRoot, "participants", agentId, "inbox-TC-SYM");
  mkdirSync(treeOutbox, { recursive: true });
  mkdirSync(treeInbox, { recursive: true });
  writeFileSync(join(treeOutbox, "brief.md"), "planner 自己写的\n");
  writeFileSync(join(treeInbox, "contract.json"), "{}\n");
  symlinkSync(treeOutbox, join(ws, "outbox"), "dir");
  symlinkSync(treeInbox, join(ws, "inbox"), "dir");

  const handler = hook();
  const ctx = { agentId, sessionKey: `agent:${agentId}:main` };

  const lsOutbox = await handler({ toolName: "ls", params: { path: join(ws, "outbox") } }, ctx);
  assert.equal(lsOutbox?.block, undefined, "ls 软链化 outbox(物理落树内)放行");
  const readOwn = await handler({ toolName: "read", params: { path: join(ws, "outbox", "brief.md") } }, ctx);
  assert.equal(readOwn?.block, undefined, "read 自己刚写的 outbox 文件放行");
  const grepInbox = await handler({ toolName: "grep", params: { pattern: "x", path: join(ws, "inbox") } }, ctx);
  assert.equal(grepInbox?.block, undefined, "grep 软链化 inbox 放行");

  // 边界仍立:树里别人的目录(非域锚)照拦
  const foreign = join(treeRoot, "participants", "someone-else", "outbox-TC-X");
  mkdirSync(foreign, { recursive: true });
  const lsForeign = await handler({ toolName: "ls", params: { path: foreign } }, ctx);
  assert.equal(lsForeign?.block, true, "树内别人的目录必须拦");
  assert.match(lsForeign?.blockReason || "", /路径限制/u);
});

test("planner(scope=workspace):grep 与 ls 同域", async () => {
  const ws = makeTempDir("discovery-planner-grep-");
  const outsideDir = makeTempDir("discovery-outside-grep-");
  const agentId = "planner-discovery-grep";
  registerAgent(agentId, "planner", ws);
  mkdirSync(join(ws, "inbox"), { recursive: true });
  mkdirSync(join(ws, "outbox"), { recursive: true });

  const handler = hook();
  const ctx = { agentId, sessionKey: `agent:${agentId}:main` };

  const inbox = await handler({ toolName: "grep", params: { pattern: "x", path: join(ws, "inbox") } }, ctx);
  assert.equal(inbox?.block, undefined, "grep 自己 inbox 放行");
  const outbox = await handler({ toolName: "grep", params: { pattern: "x", path: join(ws, "outbox") } }, ctx);
  assert.equal(outbox?.block, undefined, "grep 自己 outbox 放行(工作区内)");
  const noPath = await handler({ toolName: "grep", params: { pattern: "x" } }, ctx);
  assert.equal(noPath?.block, undefined, "grep 无 path=工作区根,workspace scope 放行");

  const outside = await handler({ toolName: "grep", params: { pattern: "x", path: outsideDir } }, ctx);
  assert.equal(outside?.block, true, "grep 搜工作区外目录必须拦");
  assert.match(outside?.blockReason || "", /路径限制/u);
});

test("敏感文件检查覆盖 ls/grep 的 path 参数(checkToolCall Rule 1a)", async () => {
  const ws = makeTempDir("discovery-sensitive-");
  const agentId = "worker-discovery-sensitive";
  registerAgent(agentId, "executor", ws);

  const handler = hook();
  const ctx = { agentId, sessionKey: `agent:${agentId}:main` };

  const lsSensitive = await handler({ toolName: "ls", params: { path: join(ws, ".ssh", "config") } }, ctx);
  assert.equal(lsSensitive?.block, true, "ls 探 .ssh 必须拦");
  assert.match(lsSensitive?.blockReason || "", /安全策略/u);

  const grepSensitive = await handler({ toolName: "grep", params: { pattern: "key", path: join(ws, ".env") } }, ctx);
  assert.equal(grepSensitive?.block, true, "grep 搜 .env 必须拦");
  assert.match(grepSensitive?.blockReason || "", /安全策略/u);

  const lsNormal = await handler({ toolName: "ls", params: { path: join(ws, "inbox") } }, ctx);
  assert.equal(lsNormal?.block, undefined, "普通路径照常放行");
});
