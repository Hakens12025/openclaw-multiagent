// context-compression.js — 上游上下文「有界注入 + 溢出压缩」的纯核心（agent 互通压缩）。
//
// 第一原则：LLM 管内容，代码管流程。本模块只做流程侧的字节预算决策与清单构建
// （全是纯函数、可单测）；真正把溢出正文压成摘要的 LLM 调用是集成点（见文末 INTEGRATION）。
//
// 背景：跨 agent 交接会把上游整包递归复制进 inbox/upstream/<producer>/，此前无字节
// 上限——上游产物越滚越大会撑爆下游上下文，且复制失败只 logger.warn（下游读 inbox
// 看不到、静默缺料）。这里给出唯一的预算真值：
//   computeContextBudgetPlan({files, maxBytes}) -> {included, overflow, needsCompression}
// 装不下的文件不复制正本，改由 buildCompressedManifest 产出 COMPRESSED_MANIFEST.md
// （path + size + 截断 head），复制失败由 buildMissingMarker 产出可见的 _MISSING.md。

// FIX(B8-context-compression): 上游注入无上限会撑爆下游上下文 -> 定义跨所有上游共享的字节池上限（~2MB）。
export const MAX_UPSTREAM_INBOX_BYTES = 2_000_000;
export const COMPRESSED_MANIFEST_FILE = "COMPRESSED_MANIFEST.md";
export const MISSING_MARKER_FILE = "_MISSING.md";
export const MANIFEST_HEAD_CHARS = 800;
export const MANIFEST_HEAD_READ_BYTES = 4096;

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

/**
 * 唯一预算真值：给定带字节大小的上游文件列表 + 字节上限，按输入顺序贪心累加，
 * 累计不超上限的进 included（整包流入），超出的进 overflow（改压缩清单）。
 * 单个 > 上限的文件必进 overflow；overflow 文件不计入累计，故大文件不会饿死其后小文件。
 * 纯函数：不读盘、不写盘、无副作用，输入顺序即决策顺序（确定性）。
 *
 * @param {{ files?: Array<{path?:string, size?:number}>, maxBytes?:number }} params
 * @returns {{ included: object[], overflow: object[], needsCompression: boolean }}
 */
// FIX(B8-context-compression): 无界复制 -> 纯预算函数决定哪些文件流入、哪些溢出压清单。
export function computeContextBudgetPlan({ files, maxBytes = MAX_UPSTREAM_INBOX_BYTES } = {}) {
  const capRaw = Number(maxBytes);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : MAX_UPSTREAM_INBOX_BYTES;
  const list = Array.isArray(files) ? files : [];
  const included = [];
  const overflow = [];
  let used = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const file = { ...raw, size: toFiniteSize(raw.size) };
    if (used + file.size <= cap) {
      included.push(file);
      used += file.size;
    } else {
      overflow.push(file);
    }
  }
  return { included, overflow, needsCompression: overflow.length > 0 };
}

// FIX(B8-context-compression): 溢出正文不能整包丢 -> 纯截断 head，供清单展示。
export function truncateHead(text, maxChars = MANIFEST_HEAD_CHARS) {
  const s = typeof text === "string" ? text : "";
  const cap = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : MANIFEST_HEAD_CHARS;
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n… [truncated ${s.length - cap} more chars]`;
}

/**
 * 溢出文件 → COMPRESSED_MANIFEST.md 正文（纯字符串）。每条列 path + size + 截断 head。
 * 不做 LLM 摘要（那是集成点，见 INTEGRATION）。
 * @param {{ producer?:string, entries?: Array<{path?:string, size?:number, head?:string}>, maxBytes?:number }} params
 */
// FIX(B8-context-compression): 溢出文件静默丢 -> 落可见压缩清单（path+size+head），LLM 侧按需取正本。
export function buildCompressedManifest({ producer, entries, maxBytes = MAX_UPSTREAM_INBOX_BYTES } = {}) {
  const prod = typeof producer === "string" && producer.trim() ? producer.trim() : "unknown";
  const rows = Array.isArray(entries) ? entries : [];
  const lines = [
    `# COMPRESSED UPSTREAM CONTEXT — ${prod}`,
    "",
    `> 上游产物超过注入预算（${formatBytes(maxBytes)}），以下文件未整包流入，仅保留清单与 head 摘要。`,
    `> 需完整正本时读 control-plane/artifacts/<contractId>/${prod}/，或向上游索取（LLM 侧按需拉取）。`,
    "",
  ];
  for (const entry of rows) {
    const path = entry && typeof entry.path === "string" && entry.path ? entry.path : "(unknown)";
    lines.push(`## ${path}  (${formatBytes(entry?.size)})`);
    const head = truncateHead(entry?.head, MANIFEST_HEAD_CHARS);
    if (head.trim()) {
      lines.push("", "```", head, "```", "");
    } else {
      lines.push("", "_(head 不可读 / 空)_", "");
    }
  }
  if (rows.length === 0) lines.push("_(无溢出文件)_", "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * 复制失败 → _MISSING.md 正文（纯字符串）。下游读 inbox 就能看到缺了谁，不再静默。
 * @param {{ agentId?:string, contractId?:string, failures?: Array<{producer?:string, reason?:string}> }} params
 */
// FIX(B8-context-compression): 复制失败只 warn（下游看不到）-> 产出可见 _MISSING.md 正文。
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

// ── INTEGRATION（集成点，非纯，不在本模块实现）─────────────────────────────────
// 真正的 LLM 摘要（把溢出正本压成语义摘要而非仅 head）属于「LLM 管内容」：调用侧在写
// COMPRESSED_MANIFEST.md 前，用 entry.head（或按需读更多正本）喂给模型生成 summary，再作为
// entry.head 传入 buildCompressedManifest。本模块只保证触发时机（needsCompression）与清单结构
// （可单测），不耦合任何模型 SDK。
