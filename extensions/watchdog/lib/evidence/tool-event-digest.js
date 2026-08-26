// tool-event-digest.js — per-tool args/result digesters (spec §2).
// One registry row per tool; the conservative default never dumps raw args.
// Collab tools are the exception (spec: 协作 FC args+凭证全量不摘) — their
// args ARE the evidence, stored whole after redaction, and their result is
// the acceptance receipt.

import { collectWriteContent, redactSensitiveText } from "../security/security.js";
import { sha256Hex } from "../core/sha256-hex.js";
import { measureToolResultBytes } from "../delivery/runtime-user-facing-output.js";

function clip(value, limit = 200) {
  const normalized = String(value ?? "").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function toolPath(params) {
  return String(params.path ?? params.file_path ?? params.filePath ?? "");
}

function writeDigest(params) {
  const content = collectWriteContent(params);
  return {
    path: toolPath(params),
    bytes: Buffer.byteLength(content || "", "utf8"),
    ...(content ? { hash: sha256Hex(content) } : {}),
  };
}

function execDigest(params) {
  return { command: redactSensitiveText(clip(params.command ?? params.cmd)) };
}

const DIGESTERS = Object.freeze({
  write: writeDigest, edit: writeDigest, create: writeDigest,
  apply_patch: writeDigest, multi_edit: writeDigest,
  read: (params) => ({ path: toolPath(params) }),
  bash: execDigest, exec: execDigest,
  glob: (params) => ({ pattern: clip(params.pattern) }),
  grep: (params) => ({ pattern: clip(params.pattern) }),
  web_search: (params) => ({ query: clip(params.query ?? params.q) }),
  web_fetch: (params) => ({ url: clip(params.url) }),
  sessions_send: (params) => ({
    target: clip(params.targetAgent ?? params.agentId ?? params.target ?? params.agent),
  }),
});

export function digestToolArgs(toolName, params = {}) {
  const digester = DIGESTERS[String(toolName || "").toLowerCase()];
  if (digester) return digester(params);
  return { keys: Object.keys(params).slice(0, 12) };
}

export function digestToolResult(event = {}) {
  if (event.error) {
    return { error: redactSensitiveText(clip(event.error?.message ?? event.error)) };
  }
  return { bytes: measureToolResultBytes(event) };
}

// ── 协作 FC 例外行(kind:collab)────────────────────────────────────────────

// args 全量入账(只做脱敏,不摘要)——协作动作的参数本身就是证据。
export function digestCollabToolArgs(params = {}) {
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(params)));
  } catch {
    return { keys: Object.keys(params).slice(0, 12) };
  }
}

// result = 受理凭证。工具面把凭证放在 details;经 after_tool_call 只能看到
// content 文本块 → 凭证是 JSON 文本,解析回对象;解析不动就存脱敏原文。
export function digestCollabToolResult(event = {}) {
  if (event.error) {
    return { error: redactSensitiveText(clip(event.error?.message ?? event.error)) };
  }
  const blocks = Array.isArray(event?.result?.content) ? event.result.content : [];
  const text = blocks.find((block) => block?.type === "text" && typeof block.text === "string")?.text || "";
  if (!text) return { bytes: measureToolResultBytes(event) };
  try {
    return { receipt: JSON.parse(redactSensitiveText(text)) };
  } catch {
    return { receipt: redactSensitiveText(text) };
  }
}
