/**
 * session-phase-store.js — 会话相位真值 + agent_end 在飞注册表（中立模块）。
 *
 * 相位门（备忘录141 §二）的单一相位真值：
 *   getSessionPhase(sessionKey) → "idle" | "running" | "closing"
 *   - closing = agent_end 收尾流水线在飞（注册表本体在此，自 agent-end/lifecycle.js
 *     迁入——唤醒原语 runtime-wake-transport 要消费相位，注册表留在 lifecycle 会经
 *     lifecycle→crash-recovery→runtime-wake-transport 成环）
 *   - running = tracker 状态 running（tracker-store 既有事实）
 *   - idle    = 其余
 *
 * import 纪律：只准向下引 tracker-store / core/runtime-status（叶子方向）。
 * 绝不 import lifecycle/、transport/、routing/、system-action/ 下任何文件。
 * 方向永远是 lifecycle → 本模块（收尾流水线把在飞 promise 注册进来）。
 */

import { getTrackingState } from "../store/tracker-store.js";
import { isRunningTrackingStatus } from "../core/runtime-status.js";

export const SESSION_PHASE = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  CLOSING: "closing",
});

// sessionKey(归一后) → deferred Promise（agent_end 在飞收尾）。
const activeAgentEndRuns = new Map();

// 与 tracker-store.js normalizeSessionKey 同一归一（trim+toLowerCase）：相位真值与
// tracker 事实必须同键，否则同一会话在两套判定里裂成两个键（幂等键账同理）。
function normalizeSessionKey(sessionKey) {
  return typeof sessionKey === "string" && sessionKey.trim()
    ? sessionKey.trim().toLowerCase()
    : null;
}

// runAgentEndLifecycle 用：查同键在飞收尾。并发重入直接返回同一 run promise，
// 保证流水线只跑一次（dedup 行为由 tests/agent-end-lifecycle-dedup.test.js 锁定）。
export function getActiveAgentEndRun(sessionKey) {
  const normalized = normalizeSessionKey(sessionKey);
  return normalized ? activeAgentEndRuns.get(normalized) || null : null;
}

// runAgentEndLifecycle 用：在 async 体启动前注册 deferred 占位，让同一 microtask
// tick 内的并发调用立即看到在飞条目（占位先于 IIFE 的时序是 dedup 修法本体）。
// 返回句柄：
//   settle(runPromise) — 把真实结果转发给占位 promise，等待方随之放行；
//   clear()            — 收尾后删键（校验仍是本次条目，防误删后续注册）。
export function registerAgentEndRun(sessionKey) {
  const normalized = normalizeSessionKey(sessionKey);
  let resolveDeferred;
  let rejectDeferred;
  const deferredEntry = new Promise((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  if (normalized) {
    activeAgentEndRuns.set(normalized, deferredEntry);
  }
  return {
    settle(runPromise) {
      runPromise.then(resolveDeferred, rejectDeferred);
    },
    clear() {
      if (normalized && activeAgentEndRuns.get(normalized) === deferredEntry) {
        activeAgentEndRuns.delete(normalized);
      }
    },
  };
}

// agent-timeout-sweep 用：某 sessionKey 是否正在被 agent_end 流水线处理。
// 让外部 force-fail 路径（超时巡检）跳过正在终结的 session，避免两路径并发调
// handleCrashRecovery/finalizeAgentSession 同 session（守「一条路径」）。
export function isAgentEndInFlight(sessionKey) {
  const normalized = normalizeSessionKey(sessionKey);
  return Boolean(normalized) && activeAgentEndRuns.has(normalized);
}

// before_agent_start 用：同 sessionKey 的收尾流水线在飞时等它落地再绑定会话。
// 唤醒若撞进收尾窗口，复活的 tracker 会被随后的 finalize 拆除，整个后续回合
// 失去 tracker（收尾各 stage 因 match 不中而静默跳过）。错误一并吞掉——等待方
// 只关心"收尾已结束"，失败路径自有 agent_end 自己的告警。
export function waitForAgentEndSettled(sessionKey) {
  const normalized = normalizeSessionKey(sessionKey);
  const inFlight = normalized ? activeAgentEndRuns.get(normalized) : null;
  return inFlight ? inFlight.then(() => {}, () => {}) : Promise.resolve();
}

// 相位真值。closing 压过 running：收尾在飞时 tracker 往往仍是 running（finalize
// 尚未拆键），该窗口正是幽灵回合竞态窗口，唤醒必须先等收尾落地。
export function getSessionPhase(sessionKey) {
  const normalized = normalizeSessionKey(sessionKey);
  if (!normalized) return SESSION_PHASE.IDLE;
  if (activeAgentEndRuns.has(normalized)) return SESSION_PHASE.CLOSING;
  const trackingState = getTrackingState(normalized);
  if (trackingState && isRunningTrackingStatus(trackingState.status)) {
    return SESSION_PHASE.RUNNING;
  }
  return SESSION_PHASE.IDLE;
}
