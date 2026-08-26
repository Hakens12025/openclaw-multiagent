// tests/hard-stop-gate-end-to-end.test.js — 执行硬停闸的端到端回归网。
//
// 为什么需要这条网(2026-08-18 loop 审计发现):硬停闸的两半分居两个 hook —— 落标记在
// after_tool_call(markSessionHardStopped),拦截在 before_tool_call(isSessionHardStopped),
// 中间靠 execution-hard-stop-registry.js 的【模块级 Map 单例】传递状态。ESM 按 resolved URL 缓存模块,
// 同一文件经两条不同路径加载就是两个 Map:mark 落在 A、check 读 B,拦截静默失效 ——
// 无异常、无日志、无告警,npm test 照样全绿。
//
// 而在本文件之前,全库没有任何一条测试走完"mark → before_tool_call 返回 {block:true}"
// 这条链:既有测试要么只测 loop-detection 单模块,要么只测某个 hook,两个 hook 从未在
// 同一条用例里出现。安全闸没有网。
//
// 本文件专测【跨 hook 的那一跳】,不重复各自的单模块行为:
//   ①after_tool_call 落的标记,before_tool_call 必须看得见(单例同一性);
//   ②三种硬停理由(重复调用/工具预算/产出预算)落标记后都拦;
//   ③epoch 隔离:标记按 epochKey 生效,换 run 即失效(硬停不得跨轮逃逸);
//   ④解除后放行(clearSession 之后闸开)。
//
// 注:本网锁的是"闸能拦住",与硬停归因(reason 语义)无关 —— 归因另有专测。
//
// Run: node --test tests/hard-stop-gate-end-to-end.test.js

import test from "node:test";
import assert from "node:assert/strict";

import * as beforeToolCallHook from "../hooks/before-tool-call.js";
import {
  clearAllSessions,
  clearSession,
  isSessionHardStopped,
  markSessionHardStopped,
  HARD_STOP_REASON,
  HARD_STOP_BLOCK_TAG,
} from "../lib/runtime/execution-hard-stop-registry.js";
import { resolveSessionEpochKey } from "../lib/runtime/session-epoch-key.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { createTrackingState } from "../lib/session/session-bootstrap.js";
import { clearTrackingStore, rememberTrackingState } from "../lib/store/tracker-store.js";
import { runtimeAgentConfigs } from "../lib/state.js";

const logger = { info() {}, warn() {}, error() {} };

function createHookApi() {
  const handlers = new Map();
  return {
    api: { on(eventName, handler) { handlers.set(eventName, handler); } },
    getHandler(eventName) {
      const handler = handlers.get(eventName);
      assert.equal(typeof handler, "function", `missing handler for ${eventName}`);
      return handler;
    },
  };
}

// 注册 agent + tracker,返回一个"调工具"的函数(经真实 before_tool_call handler)。
// 关键:闸读的键是 resolveSessionEpochKey(trackingState) —— createTrackingState 会自动生成
// trackingState.runId,故 epoch key 是 `${sessionKey}#run=${runId}` 而非裸 sessionKey。
// 落标记必须用同一把钥匙,否则测的是"两把钥匙对不上"而不是闸本身(本文件初版即栽在这)。
function armSession(agentId, { runId = null } = {}) {
  const sessionKey = `agent:${agentId}:main`;
  registerRuntimeAgents({
    agents: {
      list: [{ id: agentId, role: "executor", workspace: `~/.openclaw/workspaces/${agentId}`, model: { primary: "demo/worker" } }],
    },
  });
  const trackingState = createTrackingState({ sessionKey, agentId, parentSession: null });
  if (runId) trackingState.runId = runId;
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");
  return {
    sessionKey,
    trackingState,
    epochKey: () => resolveSessionEpochKey(trackingState),
    callTool: (toolName = "read") => handler({ toolName, params: { path: "whatever.md" } }, { agentId, sessionKey }),
  };
}

test.beforeEach(() => {
  clearAllSessions();
  runtimeAgentConfigs.clear();
  clearTrackingStore();
});

test.afterEach(() => {
  clearAllSessions();
  runtimeAgentConfigs.clear();
  clearTrackingStore();
});

test("①after_tool_call 落的硬停标记,before_tool_call 必须看得见(登记处单例同一性)", async () => {
  const agentId = `hardstop-visible-${Date.now()}`;
  const { epochKey, callTool } = armSession(agentId);

  const before = await callTool();
  assert.notEqual(before?.block, true, "未硬停时闸必须放行");

  // 模拟 after_tool_call 侧落标记(它调的就是这个 API,键同为 epoch key)
  markSessionHardStopped(epochKey(), HARD_STOP_REASON.REPEAT_THRESHOLD);
  assert.equal(isSessionHardStopped(epochKey()), true, "标记必须落在登记处");

  const after = await callTool();
  assert.equal(after?.block, true, "跨 hook 的那一跳:落标记后 before_tool_call 必须拦");
  assert.ok(String(after?.blockReason || "").includes(HARD_STOP_BLOCK_TAG), "拦截理由必须带协议标签(单一真值)");
});

test("②三种硬停理由落标记后都拦(闸不挑理由)", async () => {
  for (const reason of [
    HARD_STOP_REASON.REPEAT_THRESHOLD,
    HARD_STOP_REASON.MAX_TOOL_CALLS,
    HARD_STOP_REASON.OUTPUT_BUDGET_EXHAUSTED,
  ]) {
    clearAllSessions();
    runtimeAgentConfigs.clear();
    clearTrackingStore();
    const agentId = `hardstop-reason-${String(reason).replace(/[^a-z]/gi, "")}-${Date.now()}`;
    const { epochKey, callTool } = armSession(agentId);
    markSessionHardStopped(epochKey(), reason);
    const result = await callTool();
    assert.equal(result?.block, true, `理由 ${reason} 落标记后必须拦`);
  }
});

test("③epoch 隔离:硬停标记不得跨轮逃逸(换 runId 即失效)", async () => {
  const agentId = `hardstop-epoch-${Date.now()}`;
  const { trackingState, epochKey, callTool } = armSession(agentId, { runId: "r-round-1" });

  markSessionHardStopped(epochKey(), HARD_STOP_REASON.REPEAT_THRESHOLD);
  assert.equal((await callTool())?.block, true, "本轮硬停必须拦");

  // 换轮:同一 mailbox 身份进入下一 run —— 上一轮的硬停不得继续压着
  trackingState.runId = "r-round-2";
  const next = await callTool();
  assert.notEqual(next?.block, true, "换轮后上一轮的硬停标记必须失效(否则跨轮逃逸)");
});

test("④解除后放行(clearSession 之后闸开)", async () => {
  const agentId = `hardstop-clear-${Date.now()}`;
  const { epochKey, callTool } = armSession(agentId);

  markSessionHardStopped(epochKey(), HARD_STOP_REASON.REPEAT_THRESHOLD);
  assert.equal((await callTool())?.block, true);

  clearSession(epochKey());
  assert.equal(isSessionHardStopped(epochKey()), false, "清账后登记处必须干净");
  assert.notEqual((await callTool())?.block, true, "清账后闸必须放行");
});
