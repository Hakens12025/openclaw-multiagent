// Tests: lib/session/session-phase-store.js — 会话相位真值 + agent_end 在飞注册表。
//
// 锁三件事(备忘录141 §二 相位门的地基):
//   1. 三相位判定:idle(其余) / running(tracker 状态 running) / closing(agent_end 在飞,
//      且 closing 压过 running——收尾窗口 tracker 往往仍是 running);
//   2. settle 等待次序:waitForAgentEndSettled 必须在收尾落地之后才放行等待方;
//   3. 错误吞掉:收尾 promise reject 也放行等待方,不外泄;
// 另锁 sessionKey 归一(trim+toLowerCase,与 tracker-store 同一归一)——相位真值与
// tracker 事实不同键会把同一会话判成 idle,相位门整个失效。

import test from "node:test";
import assert from "node:assert/strict";

import {
  SESSION_PHASE,
  getSessionPhase,
  isAgentEndInFlight,
  waitForAgentEndSettled,
  registerAgentEndRun,
} from "../lib/session/session-phase-store.js";
import { rememberTrackingState, deleteTrackingSession } from "../lib/store/tracker-store.js";
import { TRACKING_STATUS } from "../lib/core/runtime-status.js";
import { runAgentEndLifecycle } from "../lib/lifecycle/agent-end/lifecycle.js";

const logger = { info() {}, warn() {}, error() {} };

function makeApi() {
  return {
    on() {},
    emit() {},
    sessions: { get() { return null; } },
  };
}

test("idle:空键/未知会话", () => {
  assert.equal(getSessionPhase(null), SESSION_PHASE.IDLE);
  assert.equal(getSessionPhase(""), SESSION_PHASE.IDLE);
  assert.equal(getSessionPhase(`agent:phase-unknown-${Date.now()}:contract:TC-none`), SESSION_PHASE.IDLE);
});

test("running:tracker 状态 running 才算;非 running tracker 判 idle", () => {
  const sessionKey = `agent:phase-running-${Date.now()}:contract:TC-run`;
  try {
    rememberTrackingState(sessionKey, { agentId: "phase-agent", status: TRACKING_STATUS.RUNNING });
    assert.equal(getSessionPhase(sessionKey), SESSION_PHASE.RUNNING);

    rememberTrackingState(sessionKey, { agentId: "phase-agent", status: TRACKING_STATUS.COMPLETED });
    assert.equal(getSessionPhase(sessionKey), SESSION_PHASE.IDLE);
  } finally {
    deleteTrackingSession(sessionKey);
  }
});

test("closing:真实 agent_end 流水线在飞;落地后回 idle", async () => {
  const sessionKey = `agent:phase-closing-${Date.now()}:contract:TC-close`;
  const run = runAgentEndLifecycle({
    event: { success: true, error: null, synthetic: false },
    ctx: { agentId: "phase-closing-agent", sessionKey },
    api: makeApi(),
    logger,
    trackingState: null,
  });

  // 同一 tick 内即可观察到在飞(deferred 占位在 async 体启动前入注册表)
  assert.equal(isAgentEndInFlight(sessionKey), true);
  assert.equal(getSessionPhase(sessionKey), SESSION_PHASE.CLOSING);

  await run;
  assert.equal(isAgentEndInFlight(sessionKey), false);
  assert.equal(getSessionPhase(sessionKey), SESSION_PHASE.IDLE);
});

test("closing 压过 running:收尾在飞时 tracker 仍 running 也判 closing", () => {
  const sessionKey = `agent:phase-precedence-${Date.now()}:contract:TC-prec`;
  const registration = registerAgentEndRun(sessionKey);
  try {
    rememberTrackingState(sessionKey, { agentId: "phase-agent", status: TRACKING_STATUS.RUNNING });
    assert.equal(getSessionPhase(sessionKey), SESSION_PHASE.CLOSING);

    registration.clear();
    assert.equal(getSessionPhase(sessionKey), SESSION_PHASE.RUNNING);
  } finally {
    registration.clear();
    deleteTrackingSession(sessionKey);
  }
});

test("settle 等待次序:收尾落地前不放行,落地后放行", async () => {
  const sessionKey = `agent:phase-settle-${Date.now()}:contract:TC-settle`;
  const registration = registerAgentEndRun(sessionKey);

  let releaseRun;
  const runPromise = new Promise((resolve) => { releaseRun = resolve; });
  registration.settle(runPromise);

  let waiterReleased = false;
  const waiter = waitForAgentEndSettled(sessionKey).then(() => { waiterReleased = true; });

  // 冲掉一轮 microtask:收尾未落地,等待方必须还挂着
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(waiterReleased, false, "waitForAgentEndSettled 在收尾落地前就放行了等待方");

  releaseRun();
  await waiter;
  assert.equal(waiterReleased, true);
  registration.clear();
});

test("错误吞掉:收尾 reject 也放行等待方,不向外抛", async () => {
  const sessionKey = `agent:phase-reject-${Date.now()}:contract:TC-reject`;
  const registration = registerAgentEndRun(sessionKey);

  let rejectRun;
  const runPromise = new Promise((_resolve, reject) => { rejectRun = reject; });
  registration.settle(runPromise);
  const waiter = waitForAgentEndSettled(sessionKey);

  rejectRun(new Error("simulated agent_end failure"));
  await waiter; // 不得抛
  registration.clear();
  assert.equal(getSessionPhase(sessionKey), SESSION_PHASE.IDLE);
});

test("归一:大小写/空白差异判同一会话(与 tracker-store 同一归一)", async () => {
  const stamp = Date.now();
  const upperKey = `  Agent:Phase-Norm-${stamp}:Contract:TC-Norm  `;
  const lowerKey = `agent:phase-norm-${stamp}:contract:tc-norm`;

  // 在飞注册表侧
  const registration = registerAgentEndRun(upperKey);
  assert.equal(isAgentEndInFlight(lowerKey), true);
  assert.equal(getSessionPhase(lowerKey), SESSION_PHASE.CLOSING);
  registration.settle(Promise.resolve());
  await waitForAgentEndSettled(lowerKey);
  registration.clear();

  // tracker 侧(rememberTrackingState 内部同样 trim+toLowerCase)
  try {
    rememberTrackingState(upperKey, { agentId: "phase-agent", status: TRACKING_STATUS.RUNNING });
    assert.equal(getSessionPhase(lowerKey), SESSION_PHASE.RUNNING);
  } finally {
    deleteTrackingSession(lowerKey);
  }
});
