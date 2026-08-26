// Tests: runtime-wake-transport.js 相位门 + 幂等键账原语接线(备忘录141 §二/§三)。
//
// 锁四条契约:
//   ① closing 相位:等收尾落地后才发送(绝不在收尾窗口内发);
//   ② 同键第二发 no-op(mode="deduplicated",发送层只被调一次);
//   ③ 无身份(deliveryTicketId/sourceContractId 双缺)永不去重,连发照发;
//   ④ 发送成功才记键:首发失败不记,重试照发。
//
// mock 面:发送层 = 心跳腿(api.runtime.system.requestHeartbeatNow 注入;
// cfg.hooksToken 置空使 hooks 腿关闭)。wake 去重是原语内部的进程内 TTL 缓存
// (2026-08-12 审查裁定:不落盘,持久 wake 键会跨重启焊死恢复腿),故无需 mock
// 键账;"记键"契约用行为断言(成功后再发→deduplicated)。
// 相位用真 session-phase-store(registerAgentEndRun 造 closing 在飞条目)。
//
// Run: node --test --experimental-test-module-mocks tests/wake-phase-gate.test.js

import test, { after } from "node:test";
import assert from "node:assert/strict";

const { runtimeWakeAgentDetailed } = await import("../lib/transport/runtime-wake-transport.js");
const { registerAgentEndRun } = await import("../lib/session/session-phase-store.js");
const { registerRuntimeAgents } = await import("../lib/agent/agent-identity.js");
const { cfg, runtimeAgentConfigs } = await import("../lib/state.js");

// 满足激活门:registered=true, plane="runtime", autoWakeEligible=true。
registerRuntimeAgents({
  agents: {
    list: [
      { id: "phase-gate-target", binding: { roleRef: "agent" } },
    ],
  },
});

const previousHooksToken = cfg.hooksToken;
cfg.hooksToken = ""; // hooks 腿关闭 → 发送层收敛为可注入的心跳腿

after(() => {
  runtimeAgentConfigs.clear();
  cfg.hooksToken = previousHooksToken;
});

const silentLogger = { info() {}, warn() {}, error() {} };

function makeHeartbeatApi(calls, { failOnCall = 0 } = {}) {
  let callCount = 0;
  return {
    runtime: {
      system: {
        requestHeartbeatNow(payload) {
          callCount += 1;
          calls.push(payload);
          if (callCount === failOnCall) {
            throw new Error("heartbeat transport down");
          }
        },
      },
    },
  };
}

test("closing 相位:等收尾落地后才发送(收尾在飞期间零发送)", async () => {
  const sessionKey = `agent:phase-gate-target:closing-${Date.now()}`;
  const runHandle = registerAgentEndRun(sessionKey);
  const heartbeatCalls = [];
  const api = makeHeartbeatApi(heartbeatCalls);

  const wakePromise = runtimeWakeAgentDetailed(
    "phase-gate-target",
    "closing gate probe",
    api,
    silentLogger,
    { sessionKey },
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(heartbeatCalls.length, 0, "收尾在飞期间不得发送唤醒");

  runHandle.settle(Promise.resolve());
  runHandle.clear();

  const result = await wakePromise;
  assert.equal(result.ok, true);
  assert.equal(result.mode, "heartbeat");
  assert.equal(heartbeatCalls.length, 1, "收尾落地后必须照发(closing 不是拒发)");
});

test("同键第二发 no-op:mode=deduplicated,发送层只被调一次", async () => {
  const sessionKey = `agent:phase-gate-target:dedup-${Date.now()}`;
  const wakeOptions = { sessionKey, deliveryTicketId: "SADT-PHASE-GATE-1" };
  const heartbeatCalls = [];
  const api = makeHeartbeatApi(heartbeatCalls);

  const first = await runtimeWakeAgentDetailed("phase-gate-target", "dedup probe", api, silentLogger, wakeOptions);
  assert.equal(first.ok, true);
  assert.equal(heartbeatCalls.length, 1);
  const second = await runtimeWakeAgentDetailed("phase-gate-target", "dedup probe", api, silentLogger, wakeOptions);
  assert.equal(second.ok, true);
  assert.equal(second.mode, "deduplicated");
  assert.equal(second.reason, "duplicate_wake_idempotency_key");
  assert.equal(heartbeatCalls.length, 1, "同键第二发不得触发发送层");
});

test("无身份唤醒永不去重:双 id 缺失时连发照发", async () => {
  const sessionKey = `agent:phase-gate-target:generic-${Date.now()}`;
  const heartbeatCalls = [];
  const api = makeHeartbeatApi(heartbeatCalls);

  const first = await runtimeWakeAgentDetailed("phase-gate-target", "generic probe", api, silentLogger, { sessionKey });
  const second = await runtimeWakeAgentDetailed("phase-gate-target", "generic probe", api, silentLogger, { sessionKey });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(second.mode, "deduplicated");
  assert.equal(heartbeatCalls.length, 2, "generic/heartbeat 族唤醒(无身份键)必须每次照发");
});

test("首发失败不记键:重试照发且成功后才记", async () => {
  const sessionKey = `agent:phase-gate-target:retry-${Date.now()}`;
  const wakeOptions = { sessionKey, sourceContractId: "TC-PHASE-GATE-RETRY" };
  const heartbeatCalls = [];
  const api = makeHeartbeatApi(heartbeatCalls, { failOnCall: 1 });
  const first = await runtimeWakeAgentDetailed("phase-gate-target", "retry probe", api, silentLogger, wakeOptions);
  assert.equal(first.ok, false, "心跳腿抛错时首发必须报失败");

  const second = await runtimeWakeAgentDetailed("phase-gate-target", "retry probe", api, silentLogger, wakeOptions);
  assert.equal(second.ok, true, "首发失败后的重试必须照发(失败不记键)");
  assert.notEqual(second.mode, "deduplicated");
  assert.equal(heartbeatCalls.length, 2);

  const third = await runtimeWakeAgentDetailed("phase-gate-target", "retry probe", api, silentLogger, wakeOptions);
  assert.equal(third.mode, "deduplicated", "成功后的再发必须被去重(=成功才记键的行为等价)");
  assert.equal(heartbeatCalls.length, 2, "去重后发送层不得再被调用");
});
