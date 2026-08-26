/**
 * agent-timeout-sweep.js — per-agent 硬超时 + 静默唤醒巡检
 *
 * 周期性巡检所有 running tracker：
 *   1) 显式 per-agent 硬超时（constraints.timeoutSeconds）：占用合约 elapsed > timeoutMs
 *      → force-fail，经 handleCrashRecovery 按 maxRetry 决定 retry / abandon，再 finalizeAgentSession。
 *      仅对显式设了 timeoutSeconds 的 agent 生效（opt-in，无显式超时的 agent 行为不变）。
 *   2) 否则静默超 RUNNING_TRACKER_STALE_SILENCE_MS → inactivity wake（保留原 index.js 行为）。
 *
 * 一条路径：fail+retry 复用 agent_end 崩溃路径的同两原语（handleCrashRecovery → finalizeAgentSession），
 * 不另起平行 release/fail 机制。纯 elapsed 触发（显式预算=硬上限），不用旧全局安全网的双阈值。
 */

import { listTrackingEntries } from "../store/tracker-store.js";
import { getRuntimeAgentConfig } from "../agent/agent-identity.js";
import { handleCrashRecovery } from "./crash-recovery.js";
import { finalizeAgentSession, SESSION_FINALIZE_MODE } from "./runtime-lifecycle.js";
import { isAgentEndInFlight } from "../session/session-phase-store.js";
import { runtimeWakeAgent } from "../transport/runtime-wake-transport.js";
import { MAX_RETRY_COUNT, RETRY_DELAYS, RUNNING_TRACKER_STALE_SILENCE_MS } from "../state/state-constants.js";

// 硬超时下限 60s：避免误配 0/极小值导致瞬杀（getAgentTimeoutMs 已对 <=0 返回 null=不硬杀）。
const MIN_AGENT_TIMEOUT_MS = 60_000;

// 最近活动时间戳：最后一次 tool call 的 ts，回退 session 起点，再回退 now。
export function getTrackerLastActivityTs(trackingState, nowMs) {
  if (!trackingState) return nowMs;
  const toolCalls = Array.isArray(trackingState.toolCalls) ? trackingState.toolCalls : [];
  const lastToolCall = toolCalls.length > 0 ? toolCalls[toolCalls.length - 1] : null;
  return lastToolCall?.ts || trackingState.startMs || nowMs;
}

// 仅当 agent 显式设置了 constraints.timeoutSeconds(>0) 才有硬超时；否则 null（不硬杀）。
export function getAgentTimeoutMs(agentId) {
  const raw = getRuntimeAgentConfig(agentId)?.constraints?.timeoutSeconds;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(MIN_AGENT_TIMEOUT_MS, Math.floor(seconds * 1000));
}

// per-agent maxRetry 优先，回退全局 MAX_RETRY_COUNT（顺带真正接通 constraints.maxRetry）。
function resolveAgentMaxRetry(agentId) {
  const raw = getRuntimeAgentConfig(agentId)?.constraints?.maxRetry;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : MAX_RETRY_COUNT;
}

// 复刻 agent_end 崩溃路径：handleCrashRecovery 决定 retry/abandon → finalizeAgentSession 选 mode。
async function recoverTimedOutAgent({ sessionKey, trackingState, api, logger }) {
  const agentId = trackingState?.agentId;
  const crash = await handleCrashRecovery({
    agentId,
    sessionKey,
    trackingState,
    error: "tracker_timeout",
    api,
    logger,
    maxRetryCount: resolveAgentMaxRetry(agentId),
    retryDelays: RETRY_DELAYS,
  });
  const mode = crash?.status === "retry_scheduled"
    ? SESSION_FINALIZE_MODE.RETRY_SUSPEND
    : SESSION_FINALIZE_MODE.TERMINAL;
  await finalizeAgentSession({ agentId, sessionKey, trackingState, api, logger, mode });
  return crash?.status || "terminal";
}

// 再入守卫：3min 间隔触发；若上一次巡检（恢复可能含 I/O）尚未完成则跳过本次，
// 防 sweep+sweep 重叠对同一 session 双处理（与下方 isAgentEndInFlight 跳过互补）。
let sweepInProgress = false;

export async function sweepRunningTrackers({ now, api, logger }) {
  if (sweepInProgress) return [];
  sweepInProgress = true;
  try {
    const swept = [];
    for (const [sessionKey, t] of listTrackingEntries()) {
      if (t?.status !== "running") continue;
      // 跳过正被 agent_end 流水线处理的 session：避免两路径并发调 handleCrashRecovery/
      // finalizeAgentSession 同 session（守「一条路径」，见 isAgentEndInFlight）。
      if (isAgentEndInFlight(sessionKey)) continue;

      const lastActivity = getTrackerLastActivityTs(t, now);
      const silenceMs = now - lastActivity;
      const timeoutMs = getAgentTimeoutMs(t.agentId);
      const elapsedMs = now - (Number(t.startMs) || lastActivity);

      // ① 显式 per-agent 硬超时（纯 elapsed）→ force-fail（经 crash-recovery 按 maxRetry）。
      // 仅对有持久化 contract.path 的 session 硬杀：direct/QQ 等无持久合约的会话无法durable
      // 记 retryCount（会无限重试），交由静默 inactivity wake 处理，不在此硬终结。
      if (timeoutMs != null && elapsedMs > timeoutMs && t.contract?.path) {
        try {
          const outcome = await recoverTimedOutAgent({ sessionKey, trackingState: t, api, logger });
          logger?.warn?.(
            `[watchdog] per-agent timeout: ${sessionKey} elapsed=${elapsedMs}ms > ${timeoutMs}ms → ${outcome}`,
          );
          swept.push({ sessionKey, agentId: t.agentId, action: "timeout", outcome, elapsedMs, timeoutMs });
        } catch (e) {
          logger?.error?.(`[watchdog] timeout recovery failed for ${sessionKey}: ${e?.message}`);
        }
        continue;
      }

      // ② 静默超阈值 → inactivity wake（保留原行为）。
      if (silenceMs > RUNNING_TRACKER_STALE_SILENCE_MS) {
        logger?.warn?.(`[watchdog] inactivity detected: ${sessionKey}`);
        try { void runtimeWakeAgent(t.agentId, "inactivity", api, logger); } catch {}
        swept.push({ sessionKey, agentId: t.agentId, action: "inactivity_wake", silenceMs });
      }
    }
    return swept;
  } finally {
    sweepInProgress = false;
  }
}
