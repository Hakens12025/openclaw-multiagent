// Tests: delivery-system-action-transport.js confirmTargetSessionWake — 重试环补盲锁。
//
// 病理(2026-08-10 幽灵回合竞态的第二半):确认-重试环的观察集里只有
// ① 目标会话认领了回投合约没有 ② 目标会话是否已终态,没有"对方正在跑一个回合"。
// 于是对一个活着但尚未认领的会话连发唤醒,每发都在回合边界多落一次
// before_agent_start,甚至撞进收尾窗口复活将死的 tracker。
// 修法:补发唤醒前查 running tracker,在跑就只等认领不补发。
//
// tracker 状态用真 store 造(mock 整个 tracker-store 会砍掉图上其他消费者的导出);
// 只 mock 唤醒运输层,namedExports 必须补全该模块的全部四个导出名。
//
// Run: node --test --experimental-test-module-mocks tests/delivery-wake-retry-live-session.test.js

import test, { mock } from "node:test";
import assert from "node:assert/strict";

const wakeCalls = [];

mock.module("../lib/transport/runtime-wake-transport.js", {
  namedExports: {
    RUNTIME_WAKE_SEMANTICS: Object.freeze({
      GENERIC: "generic",
      EXECUTION_CONTRACT: "execution_contract",
      DIRECT_REQUEST_RESUME: "direct_request_resume",
      SYSTEM_ACTION_WAKE_AGENT: "system_action_wake_agent",
      ASSIGN_TASK_DISPATCH: "assign_task_dispatch",
      TERMINAL_DELIVERY_READY: "terminal_delivery_ready",
      SYSTEM_ACTION_DELIVERY_RESUME: "system_action_delivery_resume",
    }),
    buildRuntimeWakeReason: (reason) => reason || "test wake",
    runtimeWakeAgent: async () => true,
    runtimeWakeAgentDetailed: async (targetAgent) => {
      wakeCalls.push(targetAgent);
      return { ok: true, mode: "exact" };
    },
  },
});

const { confirmTargetSessionWake } = await import(
  "../lib/routing/delivery/delivery-system-action-transport.js"
);
const { rememberTrackingState, deleteTrackingSession } = await import(
  "../lib/store/tracker-store.js"
);

const RETURN_ENVELOPE_ID = "DIRECT-RETURN-ENVELOPE";

function makeContext(targetSessionKey) {
  return {
    lane: "test-lane",
    targetAgent: "planner",
    targetSessionKey,
    contractId: RETURN_ENVELOPE_ID,
    api: { on() {}, emit() {} },
    logger: { info() {}, warn() {}, error() {} },
  };
}

test("目标会话在跑且未认领:不补发唤醒,循环只等认领(修'无视运行直接重试')", async () => {
  const sessionKey = `agent:planner:contract:tc-retry-live-${Date.now()}`;
  wakeCalls.length = 0;
  rememberTrackingState(sessionKey, {
    sessionKey,
    agentId: "planner",
    status: "running",
    contract: { id: "TC-OLD-CONTRACT" },
  });
  try {
    const result = await confirmTargetSessionWake(makeContext(sessionKey), {
      maxAttempts: 2,
      retryDelayMs: 5,
    });
    assert.equal(result.confirmed, false);
    assert.equal(
      wakeCalls.length,
      0,
      `目标会话明明在跑,重试环仍补发了 ${wakeCalls.length} 次唤醒`,
    );
  } finally {
    deleteTrackingSession(sessionKey);
  }
});

test("目标会话不存在(未醒/已拆):照常补发唤醒(防止补盲变成不唤醒)", async () => {
  const sessionKey = `agent:planner:contract:tc-retry-gone-${Date.now()}`;
  wakeCalls.length = 0;

  const result = await confirmTargetSessionWake(makeContext(sessionKey), {
    maxAttempts: 2,
    retryDelayMs: 5,
  });

  assert.equal(result.confirmed, false);
  assert.equal(wakeCalls.length, 2, "无活会话时每轮重试都应补发唤醒(maxAttempts=2)");
});

test("目标会话已认领回投合约:立即确认,零补发", async () => {
  const sessionKey = `agent:planner:contract:tc-retry-claimed-${Date.now()}`;
  wakeCalls.length = 0;
  rememberTrackingState(sessionKey, {
    sessionKey,
    agentId: "planner",
    status: "running",
    contract: { id: RETURN_ENVELOPE_ID },
  });
  try {
    const result = await confirmTargetSessionWake(makeContext(sessionKey), {
      maxAttempts: 2,
      retryDelayMs: 5,
    });
    assert.equal(result.confirmed, true);
    assert.equal(wakeCalls.length, 0);
  } finally {
    deleteTrackingSession(sessionKey);
  }
});
