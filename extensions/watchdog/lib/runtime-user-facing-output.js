import { basename, extname, resolve } from "node:path";

import { HOME } from "./state.js";

const CONTROL_TEXT_PATTERNS = [
  /^\[ACTION\]/u,
  /^[A-Z][A-Z0-9_:-]{2,}$/u,
  /\[LOOP DETECTED\]/iu,
  /runtime 语义/u,
  /根据系统提示/u,
  /请直接写入本轮约定的结果文件/u,
  /请直接写入结果路径/u,
  /请读取当前会话自己的 inbox\/contract\.json/u,
  /请读取相对路径 inbox\/contract\.json/u,
  /Write relative path outbox\/runtime_result\.json/u,
];

const TOOL_ERROR_TEXT_PATTERNS = [
  /^\[error\]\s+/iu,
  /^error:/iu,
  /^tool error:/iu,
  /^failed to (?:read|write|edit)\b/iu,
  /^(?:读取|写入|编辑).{0,80}(?:失败|错误|出错)/u,
];

const CONTROL_JSON_KEYS = new Set([
  "status",
  "tool",
  "error",
  "file_path",
  "path",
  "details",
  "content",
]);

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseStructuredText(text) {
  const normalized = String(text || "").trim();
  if (!normalized || !/^[{\[]/u.test(normalized)) {
    return null;
  }
  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function isTextLikeOutputPath(outputPath) {
  const extension = extname(String(outputPath || "").trim()).toLowerCase();
  return !extension || extension === ".md" || extension === ".markdown" || extension === ".txt";
}

function normalizeOutputPath(outputPath) {
  const normalized = String(outputPath || "").replace(/^~/, HOME).trim();
  return normalized ? resolve(normalized) : "";
}

function matchesControlText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return true;
  }
  return CONTROL_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function matchesToolErrorText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  return TOOL_ERROR_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function matchesPathResidue(text, outputPath) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  if (/^(?:\.\/)?output\/?$/iu.test(normalized)) return true;

  const normalizedOutputPath = normalizeOutputPath(outputPath);
  if (!normalizedOutputPath) return false;
  const outputFileName = basename(normalizedOutputPath);
  return normalized === normalizedOutputPath
    || normalized === `output/${outputFileName}`
    || normalized.endsWith(`/output/${outputFileName}`);
}

export function classifyRuntimeControlPayload(text, { outputPath = null } = {}) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "empty_text";
  }
  if (matchesPathResidue(normalized, outputPath)) {
    return "path_residue";
  }
  if (matchesControlText(normalized)) {
    return "control_text";
  }
  if (matchesToolErrorText(normalized)) {
    return "tool_error_text";
  }

  const parsed = parseStructuredText(normalized);
  if (!parsed) {
    return null;
  }

  if (Array.isArray(parsed)) {
    return isTextLikeOutputPath(outputPath) ? "control_json" : null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }

  if (String(parsed.status || "").toLowerCase() === "error" && typeof parsed.tool === "string") {
    return "tool_error_json";
  }
  if (typeof parsed.error === "string" && matchesControlText(parsed.error)) {
    return "tool_error_json";
  }

  const keys = Object.keys(parsed);
  if (
    keys.length > 0
    && isTextLikeOutputPath(outputPath)
    && keys.every((key) => CONTROL_JSON_KEYS.has(key))
  ) {
    return "control_json";
  }

  return null;
}

export function isRuntimeControlPayload(text, options = {}) {
  return classifyRuntimeControlPayload(text, options) != null;
}

function extractTextParts(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean);
}

export function isToolOutcomeError(event = null) {
  if (event?.error) {
    return true;
  }
  const result = event?.result;
  if (!result) {
    return false;
  }
  if (String(result.status || "").toLowerCase() === "error") {
    return true;
  }
  if (String(result?.details?.status || "").toLowerCase() === "error") {
    return true;
  }
  const text = extractTextParts(result.content).join("\n\n").trim();
  if (!text) {
    return false;
  }
  return isRuntimeControlPayload(text);
}
