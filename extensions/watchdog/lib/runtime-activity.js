import { getToolLabel } from "./state.js";

function normalizeToolName(toolName) {
  return typeof toolName === "string" && toolName.trim()
    ? toolName.trim()
    : "unknown";
}

export function classifyRuntimeActivityKind(toolName) {
  const normalized = normalizeToolName(toolName).toLowerCase();

  if (["web_search"].includes(normalized)) return "search";
  if (["web_fetch", "browser"].includes(normalized)) return "read_remote";
  if (["read", "glob", "grep"].includes(normalized)) return "read_local";
  if (["write", "create", "edit", "apply_patch"].includes(normalized)) return "write_local";
  if (["exec", "bash"].includes(normalized)) return "exec";
  if (["sessions_send", "spawn"].includes(normalized)) return "dispatch";
  return "tool";
}

export function buildToolActivityCursor(toolName, params, observedAt = Date.now()) {
  const normalizedToolName = normalizeToolName(toolName);
  return {
    source: "framework_tool_event",
    kind: classifyRuntimeActivityKind(normalizedToolName),
    label: getToolLabel(normalizedToolName, params || {}),
    toolName: normalizedToolName,
    observedAt,
  };
}
