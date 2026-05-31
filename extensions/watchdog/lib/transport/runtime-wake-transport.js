// lib/runtime-wake-transport.js — Unified runtime wake transport

import { request as httpRequest } from "node:http";

import { cfg } from "../state.js";
import { canAutoWakeForTaskRuntime } from "../agent/agent-activation-policy.js";
import { getAgentIdentitySnapshot } from "../agent/agent-identity.js";
import { normalizeWakeDiagnostic } from "../lifecycle/runtime-diagnostics.js";

export const RUNTIME_WAKE_SEMANTICS = Object.freeze({
  GENERIC: "generic",
  EXECUTION_CONTRACT: "execution_contract",
  DIRECT_REQUEST_RESUME: "direct_request_resume",
  SYSTEM_ACTION_WAKE_AGENT: "system_action_wake_agent",
  ASSIGN_TASK_DISPATCH: "assign_task_dispatch",
  REQUEST_REVIEW_DISPATCH: "request_review_dispatch",
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
    case RUNTIME_WAKE_SEMANTICS.REQUEST_REVIEW_DISPATCH:
      return "处理当前审阅任务。";
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

  try {
    const payload = JSON.stringify({
      message,
      agentId,
      wakeMode: "now",
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
  logger?.info?.(`[comm] wake ${agentId}: ${message.slice(0, 120)}${wakeEnvelope ? ` [semantic=${wakeEnvelope.semanticType}]` : ""}`);
  const sessionKey = options?.sessionKey || null;
  let hookError = null;
  let fallbackUsed = false;

  if (cfg.hooksToken) {
    const hookResult = await hooksDispatchDetailed(agentId, message, logger, options);
    if (hookResult.ok) {
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
