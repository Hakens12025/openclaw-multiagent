// lib/transport/channel-notify.js — QQ notifications through qqbot plugin's sending infrastructure
// Replaces qq.js: unified token management, proxy-aware (undici ProxyAgent), no duplicate client.

import { join } from "node:path";
import { cfg } from "../state.js";
import { isSyntheticQQTarget } from "../routing/qq-reply-target.js";

const QQBOT_DIST = join(process.env.HOME || "", ".openclaw", "extensions", "qqbot", "dist", "src");

let _qqbot = null;
async function loadQQBot() {
  if (_qqbot) return _qqbot;
  const [outbound, api] = await Promise.all([
    import(join(QQBOT_DIST, "outbound.js")),
    import(join(QQBOT_DIST, "api.js")),
  ]);
  _qqbot = {
    sendText: outbound.sendText,
    sendProactiveMessage: outbound.sendProactiveMessage,
    getAccessToken: api.getAccessToken,
    sendC2CInputNotify: api.sendC2CInputNotify,
  };
  return _qqbot;
}

function resolveAccount() {
  return {
    appId: cfg.qqAppId || "",
    clientSecret: cfg.qqClientSecret || "",
    accountId: "default",
  };
}

function normalizeQQReplyTarget(target) {
  if (!target) return null;
  if (typeof target === "string") {
    const address = target.trim();
    return address ? { target: address } : null;
  }
  if (typeof target !== "object") return null;

  const address = typeof target.target === "string" ? target.target.trim() : "";
  if (!address) return null;

  const output = { target: address };
  for (const key of ["channel", "messageId", "replyToId", "accountId"]) {
    const value = typeof target[key] === "string" ? target[key].trim() : "";
    if (value) output[key] = value;
  }
  return output;
}

export function getQQTargetAddress(target) {
  return normalizeQQReplyTarget(target)?.target || null;
}

function getPassiveReplyId(target) {
  const normalized = normalizeQQReplyTarget(target);
  return normalized?.replyToId || normalized?.messageId || null;
}

export function hasQQPassiveReplyTarget(target) {
  return Boolean(getPassiveReplyId(target));
}

// ── Extract QQ target from contract.replyTo (pure data, no API) ──

export function getQQTarget(contract) {
  if (!contract?.replyTo) return null;
  if (contract.replyTo.channel === "qqbot" && contract.replyTo.target) {
    return normalizeQQReplyTarget(contract.replyTo);
  }
  return null;
}

// ── Send notification (replaces qqNotify) ──

export async function qqNotify(target, text) {
  const account = resolveAccount();
  if (!account.appId || !account.clientSecret) {
    return { ok: false, reason: "token_unavailable", detail: "QQ credentials not configured" };
  }
  const replyTarget = normalizeQQReplyTarget(target);
  const to = replyTarget?.target || "";
  if (!to) {
    return { ok: false, reason: "invalid_target", detail: "empty target" };
  }
  if (isSyntheticQQTarget(to)) {
    return { ok: false, reason: "invalid_target", detail: "synthetic QQ target is not valid for live QQ delivery" };
  }
  try {
    const qqbot = await loadQQBot();
    const message = String(text || "").trim();
    const replyToId = getPassiveReplyId(replyTarget);
    const result = replyToId
      ? await qqbot.sendText({
          to,
          text: message,
          accountId: replyTarget.accountId || account.accountId,
          replyToId,
          account,
        })
      : await qqbot.sendProactiveMessage(account, to, message);
    return {
      ok: !result.error,
      messageId: result.messageId || null,
      reason: result.error ? "send_failed" : null,
      detail: result.error || null,
      chunkCount: 1,
    };
  } catch (e) {
    return { ok: false, reason: "exception", detail: e?.message || String(e) };
  }
}

// ── Typing indicators ──

const typingIntervals = new Map();

async function sendTyping(openid) {
  try {
    const account = resolveAccount();
    if (!account.appId || !account.clientSecret || !openid) return;
    const qqbot = await loadQQBot();
    const token = await qqbot.getAccessToken(account.appId, account.clientSecret);
    await qqbot.sendC2CInputNotify(token, openid);
  } catch { /* typing failure is non-critical */ }
}

export function qqTypingStart(contractId, target) {
  qqTypingStop(contractId);
  const address = getQQTargetAddress(target);
  if (!address || address.startsWith("group:")) return;
  const openid = address.startsWith("c2c:") ? address.slice(4) : address;
  sendTyping(openid);
  const handle = setInterval(() => sendTyping(openid), 15000);
  typingIntervals.set(contractId, handle);
}

export function qqTypingStop(contractId) {
  const handle = typingIntervals.get(contractId);
  if (handle) {
    clearInterval(handle);
    typingIntervals.delete(contractId);
  }
}

export function listQQTypingContracts() {
  return [...typingIntervals.keys()];
}

export function qqTypingStopAll() {
  const contractIds = listQQTypingContracts();
  for (const id of contractIds) qqTypingStop(id);
  return contractIds.length;
}
