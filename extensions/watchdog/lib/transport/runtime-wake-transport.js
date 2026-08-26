// lib/runtime-wake-transport.js — Unified runtime wake transport

import { request as httpRequest } from "node:http";

import { cfg } from "../state.js";
import { canAutoWakeForTaskRuntime } from "../agent/agent-activation-policy.js";
import { getAgentIdentitySnapshot } from "../agent/agent-identity.js";
import { normalizeWakeDiagnostic } from "../routing/runtime-diagnostics.js";
import {
  SESSION_PHASE,
  getSessionPhase,
  waitForAgentEndSettled,
} from "../session/session-phase-store.js";
import { buildWakeIdempotencyKey } from "../store/delivery-idempotency-store.js";

// 唤醒去重是【进程内短时】的,不落盘(与投递票据键的持久账本刻意不同):
// 宿主的唤醒队列本身是进程易失的——持久 wake 键会在重启后否决合法的重新唤醒,
// 把恢复腿焊死(2026-08-12 对抗审查裁定)。双总线/重试连发都发生在秒级窗口内,
// TTL 缓存足以无害化;TTL 过后允许再发,等价于"重发一封已经不在队列里的信"。
const RECENT_WAKE_KEY_TTL_MS = 30000;
const recentWakeKeys = new Map();

function isRecentWakeKey(key, now = Date.now()) {
  for (const [k, expiresAt] of recentWakeKeys) {
    if (expiresAt <= now) recentWakeKeys.delete(k);
  }
  const expiry = recentWakeKeys.get(key);
  return typeof expiry === "number" && expiry > now;
}

function rememberWakeKey(key, now = Date.now()) {
  recentWakeKeys.set(key, now + RECENT_WAKE_KEY_TTL_MS);
}

// 相位门(备忘录141 §二):closing 相位等收尾落地的上限。超限 warn+放行(fail-open),
// 接收侧 before-agent-start 的收尾让位守卫仍兜底。
const CLOSING_SETTLE_WAIT_MS = 15_000;

async function waitForClosingSettled(sessionKey, agentId, logger) {
  let settleTimer = null;
  const timedOut = await Promise.race([
    waitForAgentEndSettled(sessionKey).then(() => false),
    new Promise((resolve) => {
      settleTimer = setTimeout(() => resolve(true), CLOSING_SETTLE_WAIT_MS);
    }),
  ]);
  clearTimeout(settleTimer);
  if (timedOut) {
    logger?.warn?.(
      `[comm] wake ${agentId}: closing settle wait exceeded ${CLOSING_SETTLE_WAIT_MS}ms `
      + `for ${sessionKey} — proceeding fail-open (receiver-side guard covers)`,
    );
  }
}

export const RUNTIME_WAKE_SEMANTICS = Object.freeze({
  GENERIC: "generic",
  EXECUTION_CONTRACT: "execution_contract",
  DIRECT_REQUEST_RESUME: "direct_request_resume",
  SYSTEM_ACTION_WAKE_AGENT: "system_action_wake_agent",
  ASSIGN_TASK_DISPATCH: "assign_task_dispatch",
  TERMINAL_DELIVERY_READY: "terminal_delivery_ready",
  SYSTEM_ACTION_DELIVERY_RESUME: "system_action_delivery_resume",
});

function normalizeWakeToken(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function localPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: "POST",
      headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: data,
        });
      });
    });

    req.on("error", reject);
    req.end(body);
  });
}

function formatHookFailure(status, body) {
  const suffix = body ? ` — ${String(body).slice(0, 200)}` : "";
  return `HTTP ${status}${suffix}`;
}

async function resolveTypedWakeEnvelope(agentId, message, options = {}) {
  if (options?.wakeEnvelope) {
    return options.wakeEnvelope;
  }

  const semanticType = normalizeWakeToken(options?.wakeSemantic);
  if (!semanticType) {
    return null;
  }

  const { buildRuntimeWakeEnvelope } = await import("./runtime-wake-envelope.js");
  return buildRuntimeWakeEnvelope({
    semanticType,
    targetAgentId: agentId,
    contractId: options?.contractId || null,
    envelopeId: options?.envelopeId || null,
    sourceAgentId: options?.sourceAgentId || null,
    actionType: options?.actionType || null,
    deliveryTicketId: options?.deliveryTicketId || null,
    deliveryId: options?.deliveryId || null,
    sourceContractId: options?.sourceContractId || null,
    sessionKeyHint: options?.sessionKeyHint || options?.sessionKey || null,
    reason: typeof options?.reason === "string" && options.reason.trim() ? options.reason.trim() : null,
    renderText: message,
  });
}

export function buildRuntimeWakeReason(reason, options = {}) {
  if (typeof reason === "string" && reason.trim()) {
    return reason.trim();
  }

  const wakeSemantic = options?.wakeSemantic || RUNTIME_WAKE_SEMANTICS.GENERIC;

  switch (wakeSemantic) {
    case RUNTIME_WAKE_SEMANTICS.EXECUTION_CONTRACT:
      return "继续处理当前任务。";
    case RUNTIME_WAKE_SEMANTICS.DIRECT_REQUEST_RESUME:
      return "继续当前用户会话。";
    case RUNTIME_WAKE_SEMANTICS.SYSTEM_ACTION_WAKE_AGENT:
      return "继续当前协作任务。";
    case RUNTIME_WAKE_SEMANTICS.ASSIGN_TASK_DISPATCH:
      return "处理当前协作任务。";
    case RUNTIME_WAKE_SEMANTICS.TERMINAL_DELIVERY_READY:
      return "领取当前结果。";
    case RUNTIME_WAKE_SEMANTICS.SYSTEM_ACTION_DELIVERY_RESUME:
      return "处理当前返回结果。";
    case RUNTIME_WAKE_SEMANTICS.GENERIC:
    default:
      return "按当前会话继续处理。";
  }
}

async function hooksDispatchDetailed(agentId, message, logger, options = {}) {
  const url = `http://localhost:${cfg.gatewayPort}/hooks/agent`;
  const sessionKey = options?.sessionKey || null;
  const deliver = options?.deliver === true;
  const wakeEnvelope = options?.wakeEnvelope || null;

  // 言面收口 P0(备忘录156 四层②,2026-08-26 裁决):宿主会把 hook 隔离运行的最终
  // 原文回执进 default agent(controller)的 main 会话——载荷缺 name 时横幅显示为
  // 无意义的 "Hook Hook",且 wakeMode:"now" 会在每次合约结束后强拍醒 controller。
  //   name:回执自述归属(runtime:<agentId>[:<cid>]),controller 能读出这是运行时遥测;
  //   wakeMode next-heartbeat:回执不再触发即时心跳(只随 30m 自然心跳带到),
  //     不影响目标 agent 本身的运行(宿主 wakeMode 只门控回执后的 requestHeartbeatNow)。
  // 宿主无静默旗标(deliver 语义=投聊天渠道,更糟),彻底封死需上游支持,见备忘录156 P3。
  const contractTail = typeof sessionKey === "string" && sessionKey.includes(":contract:")
    ? `:${sessionKey.split(":contract:")[1]}`
    : "";

  try {
    const payload = JSON.stringify({
      message,
      agentId,
      name: `runtime:${agentId}${contractTail}`,
      wakeMode: "next-heartbeat",
      ...(deliver ? { deliver: true } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(wakeEnvelope ? { wakeEnvelope } : {}),
    });
    const response = await localPost(url, {
      Authorization: `Bearer ${cfg.hooksToken}`,
      "Content-Type": "application/json",
    }, payload);

    if (response.status < 200 || response.status >= 300) {
      const error = formatHookFailure(response.status, response.body);
      logger?.error?.(`[hooks-dispatch] ${agentId} failed: ${error}`);
      return {
        ok: false,
        mode: "hooks",
        statusCode: response.status,
        error,
      };
    }

    let result = {};
    try {
      result = response.body ? JSON.parse(response.body) : {};
    } catch (e) {
      logger?.warn?.(`[hooks-dispatch] ${agentId} malformed JSON response body: ${e.message}`);
    }

    logger?.info?.(`[hooks-dispatch] ${agentId} OK: runId=${result.runId || "?"}`);
    return {
      ok: true,
      mode: "hooks",
      runId: result.runId || null,
    };
  } catch (error) {
    logger?.error?.(`[hooks-dispatch] ${agentId} fetch error: ${error.message}`);
    return {
      ok: false,
      mode: "hooks",
      error: error.message,
    };
  }
}

export async function runtimeWakeAgentDetailed(agentId, reason, api, logger, options = {}) {
  const actorPolicy = getAgentIdentitySnapshot(agentId);
  if (!canAutoWakeForTaskRuntime(actorPolicy)) {
    return normalizeWakeDiagnostic({
      ok: false,
      requested: false,
      reason: "control_plane_activation_blocked",
      error: `ordinary task runtime cannot auto-wake ${agentId}`,
    }, {
      lane: "runtime_wake",
      targetAgent: agentId,
    });
  }
  const message = buildRuntimeWakeReason(reason, options);
  let wakeEnvelope = null;
  try {
    wakeEnvelope = await resolveTypedWakeEnvelope(agentId, message, options);
  } catch (error) {
    logger?.warn?.(`[comm] wake envelope invalid for ${agentId}: ${error.message}`);
    return normalizeWakeDiagnostic({
      ok: false,
      requested: false,
      reason: "invalid_wake_envelope",
      error: error.message,
    }, {
      lane: "runtime_wake",
      targetAgent: agentId,
    });
  }
  const sessionKey = options?.sessionKey || null;

  // 相位门(备忘录141 §二):closing → 等收尾落地(15s fail-open)再发;running/idle 照发
  // ——宿主本就把发给在跑会话的唤醒排队到回合边界(回投腿复活会话的机制),拒发会饿死投递,
  // 重复发的害处由下面的幂等键账兜住。
  if (sessionKey && getSessionPhase(sessionKey) === SESSION_PHASE.CLOSING) {
    await waitForClosingSettled(sessionKey, agentId, logger);
  }

  // 幂等键账(备忘录141 §三):有身份(deliveryTicketId/sourceContractId 至少其一)才成键;
  // generic/heartbeat 唤醒键为 null,永不去重。记账在两条发送腿的成功分支——首发失败不记。
  const idempotencyKey = buildWakeIdempotencyKey({
    targetSessionKey: sessionKey,
    deliveryTicketId: options?.deliveryTicketId || null,
    sourceContractId: options?.sourceContractId || null,
  });
  if (idempotencyKey && isRecentWakeKey(idempotencyKey)) {
    logger?.info?.(`[comm] wake ${agentId} deduplicated: ${idempotencyKey}`);
    return normalizeWakeDiagnostic({
      ok: true,
      requested: false,
      mode: "deduplicated",
      reason: "duplicate_wake_idempotency_key",
      error: null,
    }, {
      lane: "runtime_wake",
      targetAgent: agentId,
    });
  }

  logger?.info?.(`[comm] wake ${agentId}: ${message.slice(0, 120)}${wakeEnvelope ? ` [semantic=${wakeEnvelope.semanticType}]` : ""}`);
  let hookError = null;
  let fallbackUsed = false;

  if (cfg.hooksToken) {
    const hookResult = await hooksDispatchDetailed(agentId, message, logger, options);
    if (hookResult.ok) {
      if (idempotencyKey) {
        rememberWakeKey(idempotencyKey);
      }
      return normalizeWakeDiagnostic({
        ok: true,
        requested: true,
        mode: "hooks",
        fallbackUsed: false,
        runId: hookResult.runId || null,
        hookError: null,
        error: null,
      }, {
        lane: "runtime_wake",
        targetAgent: agentId,
      });
    }

    hookError = hookResult.error || "hooks dispatch failed";
    fallbackUsed = true;
    logger?.warn?.(`[comm] hooks dispatch failed for ${agentId}, falling back to heartbeat`);
  }

  try {
    api.runtime.system.requestHeartbeatNow({
      reason: message,
      agentId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(wakeEnvelope ? { wakeEnvelope } : {}),
    });
    if (idempotencyKey) {
      rememberWakeKey(idempotencyKey);
    }
    return normalizeWakeDiagnostic({
      ok: true,
      requested: true,
      mode: "heartbeat",
      fallbackUsed,
      hookError,
      error: null,
    }, {
      lane: "runtime_wake",
      targetAgent: agentId,
    });
  } catch (e) {
    logger?.warn?.(`[comm] wakeup ${agentId} failed: ${e.message}`);
    return normalizeWakeDiagnostic({
      ok: false,
      requested: true,
      mode: null,
      fallbackUsed,
      hookError,
      heartbeatError: e.message,
      error: e.message,
    }, {
      lane: "runtime_wake",
      targetAgent: agentId,
    });
  }
}

export async function runtimeWakeAgent(agentId, reason, api, logger) {
  const result = await runtimeWakeAgentDetailed(agentId, reason, api, logger);
  return result.ok;
}
