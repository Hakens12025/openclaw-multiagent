// lib/formal-runtime/checks/check-http.js — check 套件共用的网关 HTTP 帮手
//
// infra.js 的 fetchJSON 对已含 "?" 的路径会拼出第二个 "?"（token 进了上一个参数的值），
// 这里统一做 query-safe 的 token 拼接，并返回 { status, body, rawBody }（解析失败不抛，
// body=null —— 由各 check 自己断言并把 rawBody 摘进 evidence）。

import { BASE, httpFetch, tokens } from "../infra.js";

function parseResponse(res) {
  let body = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = null;
  }
  return { status: res.status, body, rawBody: typeof res.body === "string" ? res.body : "" };
}

export async function gatewayGetJson(pathWithQuery, { timeoutMs } = {}) {
  const sep = pathWithQuery.includes("?") ? "&" : "?";
  return parseResponse(await httpFetch(`${BASE}${pathWithQuery}${sep}token=${tokens.gateway}`, {
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  }));
}

export async function gatewayPostJson(path, payload = {}, { timeoutMs } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  return parseResponse(await httpFetch(`${BASE}${path}${sep}token=${tokens.gateway}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  }));
}
