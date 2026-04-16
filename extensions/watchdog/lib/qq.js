// lib/qq.js — QQ integration: auth, notifications, typing indicators

import { cfg, QQ_API_BASE, QQ_TOKEN_URL, QQ_OPENID, qqTypingIntervals } from "./state.js";

let _qqToken = null;

function buildQQFailure(reason, detail, extra = {}) {
  return { ok: false, reason, detail, ...extra };
}

async function getQQToken() {
  if (!cfg.qqAppId || !cfg.qqClientSecret) return null;
  if (_qqToken && Date.now() < _qqToken.expiresAt) return _qqToken.token;
  try {
    const res = await fetch(QQ_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: cfg.qqAppId, clientSecret: cfg.qqClientSecret }),
    });
    const data = await res.json();
    _qqToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return _qqToken.token;
  } catch (e) {
    console.error("[watchdog][QQ] token error:", e.message);
    return null;
  }
}

function qqChunkText(text, limit = 1800) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.3) splitAt = remaining.lastIndexOf(" ", limit);
    if (splitAt < limit * 0.3) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function buildQQMessageBodies(content) {
  return [
    { markdown: { content }, msg_type: 2 },
    { content, msg_type: 0 },
  ];
}

async function postQQMessage(token, endpoint, chunk) {
  for (const body of buildQQMessageBodies(chunk)) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Authorization": `QQBot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      return { ok: true, status: res.status, msgType: body.msg_type };
    }
    let errorBody = null;
    try {
      errorBody = await res.json();
    } catch {}
    if (errorBody?.code === 11298 || errorBody?.err_code === 40023002) {
      return buildQQFailure("ip_not_whitelisted", errorBody.message || "接口访问源IP不在白名单", {
        status: res.status,
        code: errorBody.code,
        errCode: errorBody.err_code,
        traceId: errorBody.trace_id,
        msgType: body.msg_type,
      });
    }
  }
  return buildQQFailure("send_failed", "all QQ message body formats rejected");
}

export async function qqNotify(target, text) {
  try {
    const token = await getQQToken();
    if (!token) return buildQQFailure("token_unavailable", "QQ token unavailable");

    const chunks = qqChunkText(text);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks.length > 1
        ? (i === 0 ? chunks[i] : `...(续 ${i + 1}/${chunks.length})\n${chunks[i]}`)
        : chunks[i];

      let result;
      if (target && target.startsWith("group:")) {
        const groupOpenid = target.slice(6);
        result = await postQQMessage(token, `${QQ_API_BASE}/v2/groups/${groupOpenid}/messages`, chunk);
      } else {
        const openid = (target && target.startsWith("c2c:")) ? target.slice(4) : (target || QQ_OPENID);
        result = await postQQMessage(token, `${QQ_API_BASE}/v2/users/${openid}/messages`, chunk);
      }
      if (!result.ok) {
        return { ...result, chunkIndex: i, chunkCount: chunks.length };
      }
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
    }
    return { ok: true, chunkCount: chunks.length };
  } catch (e) {
    console.error("[watchdog][QQ] notify error:", e.message);
    return buildQQFailure("exception", e.message);
  }
}

async function qqSendTyping(openid) {
  try {
    const token = await getQQToken();
    if (!token || !openid) return;
    const targetOpenid = openid.startsWith("c2c:") ? openid.slice(4) : openid;
    await fetch(`${QQ_API_BASE}/v2/users/${targetOpenid}/messages`, {
      method: "POST",
      headers: { "Authorization": `QQBot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: 6, input_notify: { input_type: 1, input_second: 60 } }),
    });
  } catch { /* typing indicator failure is non-critical */ }
}

export function qqTypingStart(contractId, target) {
  qqTypingStop(contractId);
  if (!target || target.startsWith("group:")) return;
  const openid = target.startsWith("c2c:") ? target.slice(4) : target;
  qqSendTyping(openid);
  const handle = setInterval(() => qqSendTyping(openid), 15000);
  qqTypingIntervals.set(contractId, handle);
}

export function qqTypingStop(contractId) {
  const handle = qqTypingIntervals.get(contractId);
  if (handle) {
    clearInterval(handle);
    qqTypingIntervals.delete(contractId);
  }
}

export function listQQTypingContracts() {
  return [...qqTypingIntervals.keys()];
}

export function qqTypingStopAll() {
  const contractIds = listQQTypingContracts();
  for (const contractId of contractIds) {
    qqTypingStop(contractId);
  }
  return contractIds.length;
}

export function getQQTarget(contract) {
  if (!contract?.replyTo) return null;
  if (contract.replyTo.channel === "qqbot" && contract.replyTo.target) {
    return contract.replyTo.target;
  }
  return null;
}
