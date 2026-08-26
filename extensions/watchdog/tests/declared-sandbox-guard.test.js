// tests/declared-sandbox-guard.test.js — D-F:guard.tool_access / guard.scope 判定
// 已迁入 lib/security/declared-sandbox-guard.js,配置面直接读
// contract.automationContext.harness.moduleConfig(不再经 lib/harness 的
// resolveHarnessModuleConfig)。经 before_tool_call 守卫链驱动,覆盖:
// 白名单拦截/放行、大小写不敏感修复回归、scope 域拦截/放行、配置缺席不激活。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as beforeToolCallHook from "../hooks/before-tool-call.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { evaluateDeclaredSandboxGuard } from "../lib/security/declared-sandbox-guard.js";
import { createTrackingState } from "../lib/session/session-bootstrap.js";
import { runtimeAgentConfigs } from "../lib/state.js";
import { clearTrackingStore, rememberTrackingState } from "../lib/store/tracker-store.js";

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

test.afterEach(() => {
  runtimeAgentConfigs.clear();
  clearTrackingStore();
  while (tempRoots.length) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

// 带 automationContext 的合约会话种子(与 realpath-write-guard.test.js 同款):
// 1b 闸要求先读过自己 inbox 的 contract,这里直接置 ownInboxContractReadAt。
function seedContractSession(agentId, ws, automationContext) {
  const sessionKey = `agent:${agentId}:contract:test`;
  const trackingState = createTrackingState({ sessionKey, agentId, parentSession: null });
  trackingState.contract = {
    id: `TC-sandbox-${agentId}`,
    assignee: agentId,
    output: "",
    status: "running",
    automationContext,
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  rememberTrackingState(sessionKey, trackingState);
  return sessionKey;
}

function registerExecutor(agentId, workspace) {
  registerRuntimeAgents({
    agents: {
      list: [{ id: agentId, role: "executor", workspace, model: { primary: "demo/worker" } }],
    },
  });
}

test("guard.tool_access:白名单外工具必拦,白名单内放行", async () => {
  const ws = makeTempDir("sandbox-tool-access-");
  const agentId = "worker-sandbox-access";
  registerExecutor(agentId, ws);
  const sessionKey = seedContractSession(agentId, ws, {
    harness: {
      moduleConfig: {
        "guard.tool_access": { allowedTools: ["read", "write"] },
      },
    },
  });

  const handler = hook();
  const blocked = await handler(
    { toolName: "edit", params: { file_path: join(ws, "outbox", "x.md") } },
    { agentId, sessionKey },
  );
  assert.equal(blocked?.block, true);
  assert.match(blocked?.blockReason || "", /工具边界/u);

  const allowed = await handler(
    { toolName: "write", params: { file_path: join(ws, "outbox", "x.md"), content: "x" } },
    { agentId, sessionKey },
  );
  assert.equal(allowed?.block, undefined);
});

test("guard.tool_access 大小写不敏感(修复配置侧小写归一、判定侧裸 includes 的不对称)", async () => {
  const ws = makeTempDir("sandbox-case-");
  const agentId = "worker-sandbox-case";
  registerExecutor(agentId, ws);
  // 配置侧 uniqueTools 小写归一后的形态:allowedTools 全小写
  const sessionKey = seedContractSession(agentId, ws, {
    harness: {
      moduleConfig: {
        "guard.tool_access": { allowedTools: ["read"] },
      },
    },
  });

  const handler = hook();
  // 旧实现裸 includes 会拦 "Read"(不在 ["read"] 里);修复后必须放行
  const capitalized = await handler(
    { toolName: "Read", params: { file_path: join(ws, "outbox", "note.md") } },
    { agentId, sessionKey },
  );
  assert.equal(capitalized?.block, undefined, "配置小写、调用大写必须放行(大小写修复回归)");

  // 反向:配置大写、调用小写同样放行
  const upperConfig = evaluateDeclaredSandboxGuard({
    automationContext: { harness: { moduleConfig: { "guard.tool_access": { allowedTools: ["Read"] } } } },
    toolName: "read",
  });
  assert.equal(upperConfig, null);

  // 大小写修复不放宽语义:名单外工具照拦
  const stillBlocked = evaluateDeclaredSandboxGuard({
    automationContext: { harness: { moduleConfig: { "guard.tool_access": { allowedTools: ["read"] } } } },
    toolName: "BASH",
  });
  assert.equal(stillBlocked?.block, true);
});

test("guard.scope:域外写必拦,域内写放行", async () => {
  const ws = makeTempDir("sandbox-scope-");
  const outside = makeTempDir("sandbox-scope-outside-");
  const agentId = "worker-sandbox-scope";
  registerExecutor(agentId, ws);
  const sessionKey = seedContractSession(agentId, ws, {
    harness: {
      moduleConfig: {
        "guard.scope": { allowedWorkspaceRoots: [ws] },
      },
    },
  });

  const handler = hook();
  const blocked = await handler(
    { toolName: "write", params: { file_path: join(outside, "report.md"), content: "x" } },
    { agentId, sessionKey },
  );
  assert.equal(blocked?.block, true);
  assert.match(blocked?.blockReason || "", /沙箱边界/u);

  const allowed = await handler(
    { toolName: "write", params: { file_path: join(ws, "outbox", "report.md"), content: "x" } },
    { agentId, sessionKey },
  );
  assert.equal(allowed?.block, undefined);
});

test("moduleConfig 缺席或形状异常时两道门都不激活(直读配置面,行为等价)", async () => {
  const ws = makeTempDir("sandbox-inactive-");
  const agentId = "worker-sandbox-inactive";
  registerExecutor(agentId, ws);
  // harness 在、moduleConfig 不在:旧实现 normalizeRecord 兜 {},新实现同义
  const sessionKey = seedContractSession(agentId, ws, { harness: {} });

  const handler = hook();
  const result = await handler(
    { toolName: "edit", params: { file_path: join(ws, "outbox", "x.md") } },
    { agentId, sessionKey },
  );
  assert.equal(result?.block, undefined);

  // 形状异常(非 record)同样不激活
  assert.equal(
    evaluateDeclaredSandboxGuard({
      automationContext: { harness: { moduleConfig: { "guard.tool_access": "bogus" } } },
      toolName: "anything",
    }),
    null,
  );
  // automationContext 整体缺席
  assert.equal(evaluateDeclaredSandboxGuard({ toolName: "anything" }), null);
});
