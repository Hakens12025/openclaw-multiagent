// lib/runtime-wake-transport.js — Unified runtime wake transport

import { request as httpRequest } from "node:http";

import { cfg } from "../state.js";
import { normalizeWakeDiagnostic } from "../lifecycle/runtime-diagnostics.js";

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

async function hooksDispatchDetailed(agentId, message, logger, options = {}) {
  const url = `http://localhost:${cfg.gatewayPort}/hooks/agent`;
  const sessionKey = options?.sessionKey || null;
  const deliver = options?.deliver === true;

  try {
    const payload = JSON.stringify({
      message,
      agentId,
      wakeMode: "now",
      ...(deliver ? { deliver: true } : {}),
      ...(sessionKey ? { sessionKey } : {}),
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
    } catch {}

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
  const message = reason || "唤醒: 请读取 inbox/ 中的文件并执行任务";
  logger?.info?.(`[comm] wake ${agentId}: ${message.slice(0, 120)}`);
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
      reason: reason || "wakeup",
      agentId,
      ...(sessionKey ? { sessionKey } : {}),
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
