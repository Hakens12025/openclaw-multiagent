// lib/delivery/upstream-guide.js — 上游包的可选导览与缺料标记（纯构建，无 IO）。
//
// 第一原则：LLM 管内容，代码管流程。本模块只产出两份 markdown 正文（纯函数、可单测）：
//   buildUpstreamGuide   → UPSTREAM_GUIDE.md：上游包各文件 path + size + head 预览，
//                          纯便利导览——上游正本已整包在场（树链或拷贝），导览缺席只降便利。
//   buildMissingMarker   → _MISSING.md：上游产物未能流入 inbox 时的可见缺料标记，
//                          下游读 inbox 即知道缺了谁（非静默）。
//
// 约束：上游文件一律整包在场（链或拷贝），无字节预算取舍——提示词只注入指针零正文
// （143 §七核查），inbox 体量与上下文体量无关，字节上限在这里没有承重点。

export const UPSTREAM_GUIDE_FILE = "UPSTREAM_GUIDE.md";
export const MISSING_MARKER_FILE = "_MISSING.md";
export const GUIDE_HEAD_CHARS = 800;
export const GUIDE_HEAD_READ_BYTES = 4096;

function toFiniteSize(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function formatBytes(value) {
  const b = toFiniteSize(value);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

// head 预览纯截断，供导览展示。
export function truncateHead(text, maxChars = GUIDE_HEAD_CHARS) {
  const s = typeof text === "string" ? text : "";
  const cap = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : GUIDE_HEAD_CHARS;
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n… [truncated ${s.length - cap} more chars]`;
}

/**
 * 上游包文件 → UPSTREAM_GUIDE.md 正文（纯字符串）。每条列 path + size + 截断 head。
 * 落点在 inbox/upstream/ 根（包目录可能是指向产者树 outbox 的链，终态包保持只读）。
 * @param {{ entries?: Array<{path?:string, size?:number, head?:string}> }} params
 */
export function buildUpstreamGuide({ entries } = {}) {
  const rows = Array.isArray(entries) ? entries : [];
  const lines = [
    "# UPSTREAM GUIDE",
    "",
    "> 上游产物已整包位于 inbox/upstream/<producer>/，本导览列出各文件的路径、大小与开头预览，便于直接定位要读的正本。",
    "",
  ];
  for (const entry of rows) {
    const path = entry && typeof entry.path === "string" && entry.path ? entry.path : "(unknown)";
    lines.push(`## ${path}  (${formatBytes(entry?.size)})`);
    const head = truncateHead(entry?.head, GUIDE_HEAD_CHARS);
    if (head.trim()) {
      lines.push("", "```", head, "```", "");
    } else {
      lines.push("", "_(head 不可读 / 空)_", "");
    }
  }
  if (rows.length === 0) lines.push("_(无上游文件)_", "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * 复制失败 → _MISSING.md 正文（纯字符串）。下游读 inbox 就能看到缺了谁，不再静默。
 * @param {{ agentId?:string, contractId?:string, failures?: Array<{producer?:string, reason?:string}> }} params
 */
export function buildMissingMarker({ agentId, contractId, failures } = {}) {
  const aid = typeof agentId === "string" && agentId.trim() ? agentId.trim() : "unknown";
  const cid = typeof contractId === "string" && contractId.trim() ? contractId.trim() : "unknown";
  const rows = Array.isArray(failures) ? failures : [];
  const lines = [
    "# MISSING UPSTREAM CONTEXT",
    "",
    `> 以下上游产物**未能**复制进 ${aid} 的 inbox（contract ${cid}）。`,
    "> 这些上游的上下文在本 inbox 缺失——如相关请向上游索取或让 operator 重投，不要当作「上游没产出」。",
    "",
  ];
  for (const f of rows) {
    const producer = f && typeof f.producer === "string" && f.producer ? f.producer : "(unknown)";
    const reason = f && f.reason ? String(f.reason) : "unknown error";
    lines.push(`- **${producer}** — ${reason}`);
  }
  if (rows.length === 0) lines.push("_(无缺失记录)_");
  return `${lines.join("\n").trimEnd()}\n`;
}
