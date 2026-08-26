import { HARD_STOP_BLOCK_TAG } from "../runtime/execution-hard-stop-registry.js";
import { basename, extname, resolve } from "node:path";

import { HOME } from "../state.js";

const ANCHORED_CONTROL_TEXT_PATTERNS = [
  /^\[ACTION\]/u,
  /^[A-Z][A-Z0-9_:-]{2,}$/u,
];

// Unanchored phrases classify SHORT echoes of runtime guidance only. A long
// deliverable that merely quotes a blockReason (agents routinely restate why
// they were blocked) is real work, not control noise — the length gate keeps
// it out of the classifier's reach.
const CONTROL_TEXT_SHORT_LIMIT = 200;
const SHORT_CONTROL_TEXT_PATTERNS = [
  new RegExp(HARD_STOP_BLOCK_TAG.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
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
  if (ANCHORED_CONTROL_TEXT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (normalized.length > CONTROL_TEXT_SHORT_LIMIT) {
    return false;
  }
  return SHORT_CONTROL_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
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

// 机械失败残渣识别(2026-08-17 分类器拆分):只认平台自己的失败形态——
// 工具错误回声(text/json)、路径残渣、空白文本。这是"写入其实失败了"的事实识别,
// 终局判定与判决面可用;内容长相启发式(control_text/control_json 标记类)不在此列,
// 那是本读面(用户展示过滤)的专属职责——裸标记是合法交付,判定层无权按长相否决。
export function classifyToolFailureResidue(text, { outputPath = null } = {}) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "empty_text";
  }
  if (matchesPathResidue(normalized, outputPath)) {
    return "path_residue";
  }
  if (matchesToolErrorText(normalized)) {
    return "tool_error_text";
  }
  const parsed = parseStructuredText(normalized);
  if (!isPlainObject(parsed)) {
    return null;
  }
  if (String(parsed.status || "").toLowerCase() === "error" && typeof parsed.tool === "string") {
    return "tool_error_json";
  }
  if (typeof parsed.error === "string" && matchesControlText(parsed.error)) {
    return "tool_error_json";
  }
  return null;
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

function extractTextParts(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean);
}

// FIX(A4-output-length-stop): nothing sized a tool result (tool-timeline discards it) -> measure result output bytes from the one place that already knows result shape.
export function measureToolResultBytes(event = null) {
  const result = event?.result;
  if (result == null) return 0;
  if (typeof result === "string") {
    return Buffer.byteLength(result, "utf8");
  }
  if (Array.isArray(result.content)) {
    return extractTextParts(result.content)
      .reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
  }
  try {
    return Buffer.byteLength(JSON.stringify(result), "utf8");
  } catch {
    return 0;
  }
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
  // A successful result that merely MENTIONS control phrases is not an error.
  // Only anchored tool-error text and structured error JSON count here — the
  // broad control-payload heuristic used to poison every downstream consumer
  // (evidence outcome, writeSucceeded, delivery cleanup, inbox-read tracking).
  if (matchesToolErrorText(text)) {
    return true;
  }
  const parsed = parseStructuredText(text);
  return Boolean(
    parsed && isPlainObject(parsed)
    && String(parsed.status || "").toLowerCase() === "error"
    && typeof parsed.tool === "string",
  );
}

// 消息面正文提取:会话消息倒序找最后一条带正文的 assistant 消息(text 部件拼接,
// thinking/toolCall 不算正文)。采集侧拿它做"零文件轮的缺省交付"物化输入。
// 尾消息可能是纯 toolCall(无正文),继续向前找最后一段真正说给人听的话。
export function extractFinalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    const message = entry && typeof entry === "object" && entry.message && typeof entry.message === "object"
      ? entry.message
      : entry;
    if (message?.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") {
      const text = content.trim();
      if (text) return text;
      continue;
    }
    const text = extractTextParts(content).join("\n").trim();
    if (text) return text;
  }
  return "";
}
