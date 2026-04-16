// lib/security.js — Security checks for before_tool_call

import { isBridgeAgent } from "./agent/agent-identity.js";
import { HOME } from "./state.js";

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

function extractToolPaths(params) {
  return [...new Set(extractCandidatePaths(params).filter(Boolean))];
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

// Returns { block, blockReason } or null if allowed
export function checkToolCall(agentId, sessionKey, toolName, params, logger) {
  const filePaths = extractToolPaths(params);

  // Rule 0: Bridge hook sessions — block ALL tool calls
  if (isBridgeAgent(agentId) && sessionKey.includes(":hook:")) {
    logger.info(`[watchdog] HOOK LOCKDOWN: blocked ${toolName} in bridge hook session`);
    return { block: true, blockReason: "Bridge hook session 仅用于触发任务派发，不执行任何操作" };
  }

  // Rule 1a: Block sensitive file reads
  if (READ_TOOL_PATTERN.test(toolName)) {
    const blockedPath = filePaths.find((filePath) => isSensitivePath(filePath));
    if (blockedPath) {
      logger.warn(`[watchdog] SECURITY BLOCK: ${agentId} tried to read sensitive path: ${blockedPath}`);
      return { block: true, blockReason: "安全策略：禁止读取敏感配置文件" };
    }
  }

  // Rule 1b: Block sensitive file writes/edits
  if (WRITE_TOOL_PATTERN.test(toolName)) {
    const blockedPath = filePaths.find((filePath) => isSensitivePath(filePath));
    if (blockedPath) {
      logger.warn(`[watchdog] SECURITY BLOCK: ${agentId} tried to write/edit sensitive path: ${blockedPath}`);
      return { block: true, blockReason: "安全策略：禁止写入或修改敏感配置文件" };
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
      return { block: true, blockReason: "安全策略：消息中包含 API 密钥，已拦截" };
    }
  }

  // Rule 3: Block exec commands that reference sensitive paths
  if (EXEC_TOOL_PATTERN.test(toolName)) {
    const cmd = String(params.command ?? params.cmd ?? "");
    if (containsSensitivePathReferenceInCommand(cmd)) {
      logger.warn(`[watchdog] SECURITY BLOCK: ${agentId} tried to exec with sensitive path: ${cmd.slice(0, 80)}`);
      return { block: true, blockReason: "安全策略：禁止在命令中引用敏感文件路径" };
    }
  }

  return null; // allowed
}
