// lib/security/security.js — Security checks for before_tool_call

import { isBridgeAgent } from "../agent/agent-identity.js";
import { HOME, resolvePhysicalWorkspacePath } from "../state.js";

const SENSITIVE_PATH_PATTERNS = [
  /openclaw\.json/i,
  /\.env(?:\.[A-Za-z0-9_-]+)?$/i,
  /credentials/i,
  /api[_-]?key/i,
  /\.ssh\//i,
  /id_rsa/i,
  /\.gnupg\//i,
];

const API_KEY_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/,
  /nvapi-[a-zA-Z0-9_-]{20,}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /gho_[a-zA-Z0-9]{36}/,
  /AKIA[0-9A-Z]{16}/,
  /dsk-[a-zA-Z0-9_-]{20,}/i,
  /\b(?:api[_-]?key|gateway[_-]?token|access[_-]?token|secret)\b\s*[:=]\s*["']?[a-zA-Z0-9._-]{16,}/i,
];

const READ_TOOL_PATTERN = /^(read|Read|cat|head|tail)$/i;
// D-G:ls/grep 的 path 参数与 read 同等过敏感文件检查(Rule 1a)。
const DISCOVERY_TOOL_PATTERN = /^(ls|grep)$/i;
const WRITE_TOOL_PATTERN = /^(write|Write|edit|Edit|create|Create|append|Append|apply_patch|multi_edit|move|Move|copy|Copy)$/i;
const EXEC_TOOL_PATTERN = /^(exec|Exec|Bash)$/i;
const SENSITIVE_ENV_VAR_PATTERN = /\$(?:\{)?(?:OPENCLAW(?:_CONFIG|_JSON)?|GATEWAY_TOKEN|API_KEY|DASHSCOPE_API_KEY|GITHUB_TOKEN|SSH_[A-Z_]*|GPG_[A-Z_]*|CREDENTIALS?)(?:\})?/i;

function expandHome(value) {
  return String(value || "").replace(/^~/, HOME);
}

function extractCandidatePaths(value, {
  keyName = "",
  results = [],
  depth = 0,
} = {}) {
  if (depth > 4 || value == null) return results;

  if (typeof value === "string") {
    if (!keyName || /(?:^|_|-)(?:path|file|source|target|destination|output|input)(?:$|_|-)/i.test(keyName)) {
      results.push(expandHome(value));
    }
    return results;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractCandidatePaths(item, {
        keyName,
        results,
        depth: depth + 1,
      });
    }
    return results;
  }

  if (typeof value === "object") {
    for (const [entryKey, entryValue] of Object.entries(value)) {
      extractCandidatePaths(entryValue, {
        keyName: entryKey,
        results,
        depth: depth + 1,
      });
    }
  }

  return results;
}

function isSensitivePath(filePath) {
  const normalized = expandHome(filePath);
  return SENSITIVE_PATH_PATTERNS.some(p => p.test(normalized));
}

function containsApiKey(text) {
  return API_KEY_PATTERNS.some(p => p.test(String(text)));
}

// Redaction reuses the SAME pattern truth as the block checks (spec §2):
// one rule source, two consumers (block + redact). Used by the evidence
// digesters to keep trace files free of secrets.
export function redactSensitiveText(text) {
  let out = String(text ?? "");
  for (const pattern of API_KEY_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    out = out.replace(new RegExp(pattern.source, flags), "[REDACTED]");
  }
  return out;
}

function extractToolPaths(params) {
  const rawPaths = extractCandidatePaths(params).filter(Boolean);
  // Sensitive-path rules must also see the PHYSICAL form of each absolute
  // candidate (same helper as the hook guard chain): an innocently named
  // symlink pointing at a sensitive file would otherwise pass the lexical
  // regex. Raw candidates stay in the set — relative paths carry no reliable
  // base directory here, so they are judged lexically as before. Note the
  // guards' shared limits: Bash-mediated writes and the check→write TOCTOU
  // window are outside this check.
  const physicalPaths = rawPaths
    .filter((candidatePath) => candidatePath.startsWith("/"))
    .map((candidatePath) => resolvePhysicalWorkspacePath(candidatePath));
  return [...new Set([...rawPaths, ...physicalPaths])].filter(Boolean);
}

function containsSensitivePathReferenceInCommand(command) {
  const text = String(command || "");
  if (!text) return false;

  if (SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }

  if (SENSITIVE_ENV_VAR_PATTERN.test(text)) {
    return true;
  }

  const assignments = text.match(/(?:^|[;&|\n])\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*([^\n;&|]+)/g) || [];
  return assignments.some((assignment) => (
    SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(assignment))
    || SENSITIVE_ENV_VAR_PATTERN.test(assignment)
  ));
}

// FIX(A3-write-size-cap): single source of truth for which params carry write/edit content
// (was inline in checkToolCall). Reused by the API-key scan AND the new size guard.
// FIX(A3-write-size-cap/review): WRITE_TOOL_PATTERN also matches apply_patch and multi_edit
// whose payload is NOT in the flat fields — apply_patch carries a patch envelope (patch/input),
// multi_edit an edits[] array. Missing them let a huge apply_patch/multi_edit slip the size cap.
export function collectWriteContent(params = {}) {
  const parts = [
    params.content,
    params.text,
    params.newText,
    params.new_string,
    params.body,
    params.patch,   // apply_patch envelope
    params.input,   // apply_patch (Codex-style) envelope
  ];
  if (Array.isArray(params.edits)) { // multi_edit: content lives per-edit
    for (const edit of params.edits) {
      if (edit && typeof edit === "object") {
        parts.push(edit.new_string, edit.newText, edit.content);
      }
    }
  }
  return parts.filter((p) => typeof p === "string" && p).join("\n");
}

// FIX(A3-write-size-cap): pure guard — returns { block, blockReason } when a write/edit tool's
// UTF-8 content byte length exceeds maxWriteBytes, else null (non-write tools / empty content /
// non-positive cap all pass through). Uses Buffer.byteLength, not String.length, so multibyte
// payloads are measured by real disk bytes.
export function checkWriteSize(toolName, params, maxWriteBytes) {
  if (!WRITE_TOOL_PATTERN.test(toolName)) return null;
  const cap = Number(maxWriteBytes);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const content = collectWriteContent(params ?? {});
  if (!content) return null;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= cap) return null;
  return {
    block: true,
    blockReason: `安全策略：单次写入内容 ${bytes} 字节超过上限 ${cap} 字节；请拆分为多次较小写入或精简内容后再提交。`,
  };
}

// Returns { block, blockReason } or null if allowed
export function checkToolCall(agentId, sessionKey, toolName, params, logger) {
  const filePaths = extractToolPaths(params);

  // Rule 0: Bridge hook sessions — block ALL tool calls
  // (2026-08-23 用户裁决放行 ls/grep:发现工具只读、不派发不动作,hook 会话
  // 用它定位输入无害;其余工具维持全锁)
  if (isBridgeAgent(agentId) && sessionKey.includes(":hook:") && !DISCOVERY_TOOL_PATTERN.test(toolName)) {
    logger.info(`[watchdog] HOOK LOCKDOWN: blocked ${toolName} in bridge hook session`);
    return { block: true, blockReason: "Bridge hook session 用于触发任务派发；请回到当前会话继续。" };
  }

  // Rule 1a: Block sensitive file reads (D-G:发现工具的 path 同判——
  // 列目录/搜索敏感路径与直接读取同罪)
  if (READ_TOOL_PATTERN.test(toolName) || DISCOVERY_TOOL_PATTERN.test(toolName)) {
    const blockedPath = filePaths.find((filePath) => isSensitivePath(filePath));
    if (blockedPath) {
      logger.warn(`[watchdog] SECURITY BLOCK: ${agentId} tried to read sensitive path: ${blockedPath}`);
      return { block: true, blockReason: "安全策略：读取工作面限定为当前任务文件。" };
    }
  }

  // Rule 1b: Block sensitive file writes/edits; also scan write content for API keys
  if (WRITE_TOOL_PATTERN.test(toolName)) {
    const blockedPath = filePaths.find((filePath) => isSensitivePath(filePath));
    if (blockedPath) {
      logger.warn(`[watchdog] SECURITY BLOCK: ${agentId} tried to write/edit sensitive path: ${blockedPath}`);
      return { block: true, blockReason: "安全策略：写入工作面限定为当前任务文件。" };
    }
    const writeContent = collectWriteContent(params); // FIX(A3-write-size-cap): reuse single write-content source
    if (writeContent && containsApiKey(writeContent)) {
      logger.warn(`[watchdog] SECURITY BLOCK: ${agentId} tried to write API key via ${toolName}`);
      return { block: true, blockReason: "安全策略：消息面只发送任务内容和结果。" };
    }
  }

  // Rule 2: Block API key leakage via sessions_send
  if (/^sessions_send$/i.test(toolName)) {
    const message = [
      params.message,
      params.content,
      params.text,
      params.body,
    ].filter(Boolean).join("\n");
    if (containsApiKey(message)) {
      logger.warn(`[watchdog] SECURITY BLOCK: ${agentId} tried to send API key via sessions_send`);
      return { block: true, blockReason: "安全策略：消息面只发送任务内容和结果。" };
    }
  }

  // Rule 3: Block exec commands that reference sensitive paths
  if (EXEC_TOOL_PATTERN.test(toolName)) {
    const cmd = String(params.command ?? params.cmd ?? "");
    if (containsSensitivePathReferenceInCommand(cmd)) {
      logger.warn(`[watchdog] SECURITY BLOCK: ${agentId} tried to exec with sensitive path: ${cmd.slice(0, 80)}`);
      return { block: true, blockReason: "安全策略：命令引用工作面限定为当前任务文件。" };
    }
  }

  return null; // allowed
}
