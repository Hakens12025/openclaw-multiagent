// state-tool-labels.js — Tool label mapping for UI display
import { basename } from "node:path";

const TOOL_LABELS = {
  web_search:     (p) => `搜索中: ${(p?.query || p?.q || "").slice(0, 50)}`,
  web_fetch:      (p) => { try { return `读取网页: ${new URL(p?.url || "").hostname}`; } catch { return `读取网页`; } },
  read:           (p) => `阅读: ${basename(String(p?.file_path || p?.path || "unknown"))}`,
  Read:           (p) => `阅读: ${basename(String(p?.file_path || p?.path || "unknown"))}`,
  write:          (p) => `写入: ${basename(String(p?.file_path || p?.path || "unknown"))}`,
  Write:          (p) => `写入: ${basename(String(p?.file_path || p?.path || "unknown"))}`,
  edit:           (p) => `编辑: ${basename(String(p?.file_path || p?.path || "unknown"))}`,
  Edit:           (p) => `编辑: ${basename(String(p?.file_path || p?.path || "unknown"))}`,
  create:         (p) => `创建: ${basename(String(p?.file_path || p?.path || "unknown"))}`,
  apply_patch:    (p) => `应用补丁: ${basename(String(p?.file_path || p?.path || "unknown"))}`,
  exec:           (p) => `执行: ${(p?.command || "").slice(0, 40)}`,
  Exec:           (p) => `执行: ${(p?.command || "").slice(0, 40)}`,
  Bash:           (p) => `执行: ${(p?.command || "").slice(0, 40)}`,
  glob:           (p) => `搜索文件: ${p?.pattern || ""}`,
  Glob:           (p) => `搜索文件: ${p?.pattern || ""}`,
  grep:           (p) => `搜索内容: ${(p?.pattern || "").slice(0, 30)}`,
  Grep:           (p) => `搜索内容: ${(p?.pattern || "").slice(0, 30)}`,
  spawn:          (_p) => `派生子任务`,
  sessions_send:  (p) => `发送消息给: ${p?.targetAgent || p?.agentId || "agent"}`,
  browser:        (p) => `浏览器: ${(p?.url || p?.action || "操作中").slice(0, 40)}`,
  Browser:        (p) => `浏览器: ${(p?.url || p?.action || "操作中").slice(0, 40)}`,
};

export function getToolLabel(toolName, params) {
  const fn = TOOL_LABELS[toolName];
  if (fn) {
    try { return fn(params || {}); } catch { return `${toolName}`; }
  }
  return `执行工具: ${toolName}`;
}
