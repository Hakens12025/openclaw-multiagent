import { basename } from "node:path";

import { getToolLabel } from "./state.js";
import { classifyRuntimeActivityKind } from "./runtime-activity.js";

function normalizeToolName(toolName) {
  return typeof toolName === "string" && toolName.trim()
    ? toolName.trim()
    : "unknown";
}

function normalizeParams(params) {
  return params && typeof params === "object" ? params : {};
}

function truncateText(value, limit = 80) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;

  const seconds = durationMs / 1000;
  if (seconds < 60) {
    const rounded = seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds * 10) / 10);
    return rounded.endsWith(".0") ? `${rounded.slice(0, -2)}s` : `${rounded}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds % 60);
  return `${minutes}m${String(remainderSeconds).padStart(2, "0")}s`;
}

function extractPathBasename(rawPath) {
  const normalized = String(rawPath || "").trim();
  if (!normalized) return "";
  return basename(normalized);
}

function extractHost(url) {
  try {
    return new URL(String(url || "").trim()).hostname || "";
  } catch {
    return "";
  }
}

function resolveToolTarget(toolName, params) {
  const normalizedToolName = normalizeToolName(toolName).toLowerCase();
  const normalizedParams = normalizeParams(params);

  switch (normalizedToolName) {
    case "exec":
    case "bash":
      return truncateText(normalizedParams.command || normalizedParams.cmd || "", 80);
    case "read":
    case "write":
    case "edit":
    case "create":
    case "apply_patch":
      return extractPathBasename(
        normalizedParams.file_path
        || normalizedParams.path
        || normalizedParams.filePath
        || "",
      );
    case "web_fetch":
      return truncateText(extractHost(normalizedParams.url), 80);
    case "web_search":
      return truncateText(normalizedParams.query || normalizedParams.q || "", 80);
    case "glob":
    case "grep":
      return truncateText(normalizedParams.pattern || "", 80);
    case "sessions_send":
      return truncateText(
        normalizedParams.targetAgent
        || normalizedParams.agentId
        || normalizedParams.target
        || normalizedParams.agent
        || "",
        80,
      );
    case "browser":
      return truncateText(normalizedParams.url || normalizedParams.action || "", 80);
    default:
      return "";
  }
}

function resolveToolVerb(toolName) {
  const normalizedToolName = normalizeToolName(toolName).toLowerCase();
  switch (normalizedToolName) {
    case "exec":
    case "bash":
      return "执行";
    case "read":
      return "阅读";
    case "write":
      return "写入";
    case "edit":
      return "编辑";
    case "create":
      return "创建";
    case "apply_patch":
      return "应用补丁";
    case "web_search":
      return "搜索";
    case "web_fetch":
      return "读取网页";
    case "glob":
      return "搜索文件";
    case "grep":
      return "搜索内容";
    case "sessions_send":
      return "发送消息";
    case "spawn":
      return "派生子任务";
    case "browser":
      return "浏览器";
    default:
      return "执行工具";
  }
}

function buildToolSummary({
  toolName,
  params,
  durationMs,
  error,
  label,
}) {
  const verb = resolveToolVerb(toolName);
  const durationLabel = formatDuration(durationMs);
  const durationPart = durationLabel ? ` (${durationLabel})` : "";
  const target = resolveToolTarget(toolName, params);
  const statusWord = error ? "失败" : "完成";
  const base = `${verb}${statusWord}${durationPart}`;
  if (target) return `${base}: ${target}`;

  const fallback = String(label || "").replace(/^[^:]+:\s*/u, "").trim();
  if (fallback) return `${base}: ${fallback}`;
  return base;
}

export function buildToolTimelineEvent({
  index,
  toolName,
  params,
  result,
  error,
  durationMs,
  runId = null,
  toolCallId = null,
  observedAt = Date.now(),
} = {}) {
  void result;

  const normalizedToolName = normalizeToolName(toolName);
  const normalizedParams = normalizeParams(params);
  const label = getToolLabel(normalizedToolName, normalizedParams);

  return {
    index: Number.isFinite(index) ? Math.max(1, Math.trunc(index)) : 1,
    tool: normalizedToolName,
    kind: classifyRuntimeActivityKind(normalizedToolName),
    label,
    summary: buildToolSummary({
      toolName: normalizedToolName,
      params: normalizedParams,
      durationMs,
      error,
      label,
    }),
    status: error ? "error" : "ok",
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.trunc(durationMs)) : null,
    runId: typeof runId === "string" && runId.trim() ? runId.trim() : null,
    toolCallId: typeof toolCallId === "string" && toolCallId.trim() ? toolCallId.trim() : null,
    ts: Number.isFinite(observedAt) ? observedAt : Date.now(),
  };
}
