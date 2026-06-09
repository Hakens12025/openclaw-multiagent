// 平台托管文档标记与归一化工具。
// 带此 marker 的工作区文档（IDENTITY/AGENTS/HEARTBEAT 等）由 watchdog 自动生成/维护；
// 用户去掉 marker = 接管该文档，平台不再覆盖（见 agent-guidance-drift / enrollment）。
// SOUL.md 是例外：用户拥有、无 marker、平台永不重写（六层模型 ⑤）。

export const MANAGED_BOOTSTRAP_MARKER = "<!-- managed-by-watchdog:agent-bootstrap -->";

export function normalizeManagedDocContent(content) {
  return String(content || "").replace(/\r\n/g, "\n");
}
