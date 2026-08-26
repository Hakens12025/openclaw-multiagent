// Tests: session-phase-store.js waitForAgentEndSettled — 收尾让位原语
// (注册表已自 agent-end/lifecycle.js 迁入 session-phase-store,注册方仍是 lifecycle)。
//
// 病理(2026-08-10 幽灵回合竞态):exact-session 唤醒撞进 agent_end 收尾窗口,
// before_agent_start 复活了一个即将被 finalize 拆除的 tracker;之后整个回合
// 无 tracker 运行,第二次 agent_end 各 stage 因 match 不中而静默跳过(无 commit、
// 无 release、无 harness)。修法:绑定会话前先等在飞的收尾流水线落地。
// 本文件锁原语本身;链路行为由 live 预设验收(system-action 连续 3 轮全绿)。

import test from "node:test";
import assert from "node:assert/strict";

import { runAgentEndLifecycle } from "../lib/lifecycle/agent-end/lifecycle.js";
import {
  waitForAgentEndSettled,
  isAgentEndInFlight,
} from "../lib/session/session-phase-store.js";

const logger = { info() {}, warn() {}, error() {} };

function makeApi() {
  return {
    on() {},
    emit() {},
    sessions: { get() { return null; } },
  };
}

test("无在飞收尾时立即 resolve(不阻塞正常会话启动)", async () => {
  await waitForAgentEndSettled(`agent:settle-idle-${Date.now()}:contract:TC-none`);
  await waitForAgentEndSettled(null);
});

test("收尾在飞时:等待方必须在流水线完成之后才被放行", async () => {
  const sessionKey = `agent:settle-wait-${Date.now()}:contract:TC-settle`;
  const ctx = { agentId: "settle-wait-agent", sessionKey };

  let lifecycleFinished = false;
  const run = runAgentEndLifecycle({
    event: { success: true, error: null, synthetic: false },
    ctx,
    api: makeApi(),
    logger,
    trackingState: null,
  });
  run.then(() => { lifecycleFinished = true; });

  // 同一 tick 内注册即可观察到在飞(deferred 占位在 async 体启动前入 map)
  assert.equal(isAgentEndInFlight(sessionKey), true);

  await waitForAgentEndSettled(sessionKey).then(() => {
    assert.equal(
      lifecycleFinished,
      true,
      "waitForAgentEndSettled 在收尾流水线完成前就放行了等待方(竞态未被挡住)",
    );
  });
  await run;
});

test("收尾流水线抛错也放行等待方(错误由 agent_end 自身告警,不外泄给唤醒方)", async () => {
  const sessionKey = `agent:settle-reject-${Date.now()}:contract:TC-reject`;
  const ctx = { agentId: "settle-reject-agent", sessionKey };

  // success:false + error 走 crash-recovery 路径;trackingState:null 下快速返回。
  // 无论 run 正常 resolve 还是 reject,waitForAgentEndSettled 都不得抛。
  const run = runAgentEndLifecycle({
    event: { success: false, error: new Error("simulated crash"), synthetic: false },
    ctx,
    api: makeApi(),
    logger,
    trackingState: null,
  });

  await waitForAgentEndSettled(sessionKey);
  await run.catch(() => {});
});
