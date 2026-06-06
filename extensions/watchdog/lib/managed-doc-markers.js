// 平台托管文档标记与归一化工具。
// 带此 marker 的工作区文档（SOUL/IDENTITY/AGENTS 等）由 watchdog 自动生成/维护；
// 用户去掉 marker = 接管该文档，平台不再覆盖（见 agent-guidance-drift / enrollment）。
// 从 soul-template-builder 抽出为中性模块，使分层重构可删除 soul-template-builder。

export const MANAGED_BOOTSTRAP_MARKER = "<!-- managed-by-watchdog:agent-bootstrap -->";

export function normalizeManagedDocContent(content) {
  return String(content || "").replace(/\r\n/g, "\n");
}
