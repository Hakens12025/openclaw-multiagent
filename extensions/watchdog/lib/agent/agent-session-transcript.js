// agent-session-transcript.js — agent session .jsonl 解析读路径
//
// 解析 ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl（每行一个 JSON），
// 抽出 message 消息 + 引用文件，供「工作流」页 session 查看器使用。
// surface inspect.session_transcript 的源。
//
// 不复制 session 正文（.jsonl 已内嵌读/写工具的完整内容，是真值本身），
// 只做投影 + 引用文件解析。引用文件解析到正本路径（contract/output），
// persistent 用 fs existsSync 判定。

import { readFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OC } from "../state/state-paths.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { loadGraph, getEdgesFrom } from "./agent-graph.js";
import { compactHomePath } from "./agent-enrollment-discovery.js";
import { isControlOutboxFile } from "../routing/mailbox/runtime-mailbox-outbox-helpers.js";
import { resolveSessionHome } from "../archive/session-home-index.js";
import {
  participantInboxSnapshotDirFor,
  participantOutboxDirFor,
  participantSessionJsonlFor,
  resolveContractHome,
} from "../archive/thread-tree-store.js";
import { findDeliverySnapshotPath, findSealedOutbox } from "../archive/outbox-seal.js";
import { resolveSharedContractPathById } from "../store/contract-store.js";

// 投递正文单文件上限（字符），与 system-prompt 路径一致。超出截断 + truncated:true。
const DELIVERY_CONTENT_CAP = 40000;

// 产物包内单文件正文上限（字符）。
const PRODUCED_CONTENT_CAP = 40000;

// 该 agent 在本 contract 的产物文件，树优先：
//   ① sealed 树 outbox（threads/…/participants/<agent>/outbox-<cid>/ + seal.json）——
//      采集封包后的产物正本，清单/主交付物从 seal 取；归属核对 hit.agentId===aid
//      （findSealedOutbox 提示未命中会退回全参与者扫描，别的参与者的封包零采信）。
//   ② 同一个树 outbox 目录、但封条还不在（仍在跑 / 崩溃轮 / 采集失败）——按目录实况
//      列文件，manifest 为 null（没有封条就没有那组元数据）。
//      两路读的是同一份产物，不是某处的副本（workflow-page-backend.test.js 锁形状）。
// 直接读文件正文供页面内显——异于 referencedFiles 的 reveal（那些是历史引用、常被清理）。
function resolveProducedFiles(agentId, contractId) {
  const empty = { available: false, files: [], manifest: null };
  try {
    const cid = typeof contractId === "string" ? contractId.trim() : "";
    const aid = typeof agentId === "string" ? agentId.trim() : "";
    if (!cid || !aid) return empty;

    // 封包轮:清单与主交付物取自封条(采集事实)。
    const sealed = findSealedOutbox(cid, { agentId: aid });
    if (sealed && sealed.agentId === aid) {
      const sealFiles = (Array.isArray(sealed.seal?.files) ? sealed.seal.files : [])
        .filter((name) => typeof name === "string" && name.trim());
      const sealPrimary = typeof sealed.seal?.primary === "string" && sealFiles.includes(sealed.seal.primary)
        ? sealed.seal.primary
        : null;
      const files = readProducedFiles(sealed.outboxDir, sealFiles, sealPrimary);
      if (files.length > 0) {
        const collectedAt = Number(sealed.seal?.collectedAt);
        return {
          available: true,
          files,
          manifest: {
            producer: aid,
            producedAt: Number.isFinite(collectedAt) && collectedAt > 0 ? new Date(collectedAt).toISOString() : null,
            summary: null,
            primary: sealPrimary,
          },
        };
      }
    }

    // 未封包轮(仍在跑 / 崩溃轮 / 采集失败):树 outbox 正本目录还在,照样列出来。
    // 数据源与封包轮是同一个目录——页面看到的永远是产物本身,不是某处的副本。
    // 目录名一律用登记原串 home.id:查询串可能是会话键派生的小写形态,
    // 大小写不敏感 FS 会掩盖这个错,大小写敏感 FS 上就是整轮读不到产物。
    const home = resolveContractHome(cid);
    const outboxDir = home ? participantOutboxDirFor(home, aid, home.id || cid) : null;
    if (!outboxDir || !existsSync(outboxDir)) return empty;
    let names = [];
    try {
      names = readdirSync(outboxDir).filter((name) => !isControlOutboxFile(name));
    } catch {
      return empty;
    }
    const files = readProducedFiles(outboxDir, names, null);
    return { available: files.length > 0, files, manifest: null };
  } catch {
    return empty;
  }
}

// 目录 + 文件名清单 → 页面用的文件条目(带截断正文)。封包轮与未封包轮共用,
// 两处各写一份的话,同一份产物会在两条路上显示成不同样子。
function readProducedFiles(dir, names, primaryName) {
  const files = [];
  for (const name of names) {
    const p = join(dir, name);
    let content = null;
    let chars = 0;
    let truncated = false;
    try {
      const text = readFileSync(p, "utf8");
      chars = text.length;
      truncated = text.length > PRODUCED_CONTENT_CAP;
      content = truncated ? text.slice(0, PRODUCED_CONTENT_CAP) : text;
    } catch { /* 二进制/不可读 → 无正文，仍列文件名 */ }
    files.push({ name, path: compactHomePath(p), chars, truncated, content, primary: name === primaryName });
  }
  files.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0)); // 主交付物排前
  return files;
}

function liveSessionFile(agentId, sessionId) {
  return join(OC, "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

// 归档副本：经 session-index 找 run 家 → participants/{agent}/session-{sid}.jsonl
// （agent_end 归档段写；文件名用索引登记的原串 sessionId/agentId）。无家 → null。
function archivedSessionFile(agentId, sessionId) {
  try {
    const home = resolveSessionHome(sessionId);
    if (!home) return null;
    return participantSessionJsonlFor(home, home.agentId || agentId, home.sessionId);
  } catch {
    return null;
  }
}

// 先读 live .jsonl（= truth），不存在则回退树内归档副本。两处皆无 → null。
async function readSessionJsonl(agentId, sessionId) {
  try {
    return await readFile(liveSessionFile(agentId, sessionId), "utf8");
  } catch {
    // live 不在（如被 session-clean 清），回退树内归档副本
  }
  const archived = archivedSessionFile(agentId, sessionId);
  if (!archived) return null;
  try {
    return await readFile(archived, "utf8");
  } catch {
    return null;
  }
}

// ── 引用文件路径解析 ──────────────────────────────────────────────────────────
// 规则：
//   workspaces/<a>/inbox/contract.json            → 共享合约正本 (kind=contract)
//   workspaces/<a>/output/<TC>.md                 → control-plane/output/<TC>.md (kind=output)
//   control-plane/output/<TC>.md                  → control-plane/output/<TC>.md (kind=output)
//   其它                                          → kind=other, resolvedPath=原路径
//
// 合约正本 = 树店 threads/{t}/runs/{r}/contracts/<id>.json，唯一解析底座
// resolveSharedContractPathById（contract-index 常驻内存，同步；miss → null）。

// 在 dir 里按 basename **大小写不敏感**找实际文件(sessionKey 把 contractId 小写成 tc-,
// 但产出件文件名是 TC-,直接拼路径会 miss)。命中→返回实际大小写路径;否则返回构造路径(persistent=false)。
function resolveCaseInsensitive(dir, basename) {
  const exact = join(dir, basename);
  if (existsSync(exact)) return exact;
  try {
    const lower = basename.toLowerCase();
    for (const f of readdirSync(dir)) {
      if (f.toLowerCase() === lower) return join(dir, f);
    }
  } catch {
    // dir 不存在(如被清)→ 落构造路径
  }
  return exact;
}

function resolveReferencedFile(rawPath, contractId) {
  const raw = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!raw) return null;

  let kind = "other";
  let resolvedPath = raw;

  const inboxContractMatch = raw.match(/workspaces\/[^/]+\/inbox\/contract\.json$/);
  if (inboxContractMatch) {
    kind = "contract";
    // 正本经 contract-index 走树(索引键侧小写归一,兜住会话键派生的 tc- 形态);
    // 索引 miss / 拿不到 contractId 则保留原路径
    resolvedPath = (contractId && resolveSharedContractPathById(contractId)) || raw;
  } else {
    const outputMatch = raw.match(/(?:workspaces\/[^/]+\/output|control-plane\/output)\/(.+)$/);
    if (outputMatch) {
      kind = "output";
      resolvedPath = resolveCaseInsensitive(CONTROL_PLANE_PATHS.outputDir, outputMatch[1]);
    }
  }

  return {
    rawPath: raw,
    resolvedPath: compactHomePath(resolvedPath),
    persistent: existsSync(resolvedPath),
    kind,
  };
}

// ── content block 投影 ────────────────────────────────────────────────────────

function extractFromContent(content) {
  const result = { text: "", thinking: "", toolCalls: [], toolResults: [] };
  if (typeof content === "string") {
    result.text = content;
    return result;
  }
  if (!Array.isArray(content)) return result;

  const textParts = [];
  const thinkingParts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = block.type;
    if (type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (type === "thinking" && typeof block.thinking === "string") {
      thinkingParts.push(block.thinking);
    } else if (type === "toolCall" || type === "tool_use") {
      // 真实 .jsonl 格式：{type:"toolCall", name, arguments}；
      // 兼容 Anthropic 风格 {type:"tool_use", name, input}。
      result.toolCalls.push({
        name: typeof block.name === "string" ? block.name : null,
        args:
          block.arguments && typeof block.arguments === "object"
            ? block.arguments
            : block.input && typeof block.input === "object"
              ? block.input
              : {},
      });
    } else if (type === "toolResult" || type === "tool_result") {
      result.toolResults.push({
        tool:
          (typeof block.toolName === "string" && block.toolName) ||
          (typeof block.toolCallId === "string" && block.toolCallId) ||
          (typeof block.tool_use_id === "string" && block.tool_use_id) ||
          null,
        contentText: stringifyToolResultContent(block.content),
      });
    }
  }
  result.text = textParts.join("\n");
  result.thinking = thinkingParts.join("\n");
  return result;
}

function stringifyToolResultContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((blk) => {
        if (typeof blk === "string") return blk;
        if (blk && typeof blk === "object" && typeof blk.text === "string") return blk.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// 从 toolCall args 提取候选文件路径（read/write/edit 用 path/file_path）
function collectToolCallPaths(toolCalls, sink) {
  for (const call of toolCalls) {
    const args = call.args || {};
    for (const key of ["path", "file_path"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) sink.add(value.trim());
    }
  }
}

// 从 toolResult contentText 扫已知正本前缀的路径
const PATH_SCAN_REGEX = /(?:[^\s"'`)]*\/)?(?:workspaces\/[^/\s"'`)]+\/(?:inbox\/contract\.json|output\/[^\s"'`)]+)|control-plane\/output\/[^\s"'`)]+)/g;

function collectToolResultPaths(toolResults, sink) {
  for (const tr of toolResults) {
    collectTextPaths(tr.contentText || "", sink);
  }
}

// 扫任意文本里出现的已知正本前缀路径(write 结果"wrote to /path"、读到的内容等)
function collectTextPaths(text, sink) {
  if (typeof text !== "string" || !text) return;
  const matches = text.match(PATH_SCAN_REGEX);
  if (matches) {
    for (const m of matches) sink.add(m.trim());
  }
}

// ── 末位投递解析（delivery）──────────────────────────────────────────────────
// 末位(terminal)agent = workflow 叶子(graph 中无出边)。末位 agent 的「用户最终
// 接收到的消息」正文,读序:
//   ① 树封包 seal.primary(合约轮产物正本,采集零镜像后的第一真值)
//   ② 树内快照 participants/{agent}/delivery-{cid}.md(直写件被清后的留档)
//   ③ live control-plane/output/{contractId}.md(镜像遗产/直写链路)
// 区别于 agent 自己的输出气泡(LLM 叙述"我输出了")。
//
// 整段 graph 读取/判定 try/catch：失败 → { isTerminal:false }（不抛、不破坏主体）。
async function resolveDelivery(agentId, contractId) {
  try {
    const graph = await loadGraph();
    // 无出边 = 叶子 = 末位 agent
    const isTerminal = getEdgesFrom(graph, agentId).length === 0;
    if (!isTerminal) return { isTerminal: false };
    if (!contractId) return { isTerminal: true, outputPath: null, available: false, content: null, contentChars: 0 };

    // 产出件路径(大小写不敏感：contractId 小写 tc-，文件名可能 TC-)
    const outputPath = resolveCaseInsensitive(CONTROL_PLANE_PATHS.outputDir, `${contractId}.md`);
    const candidates = [
      findSealedOutbox(contractId, { agentId })?.primaryPath,
      findDeliverySnapshotPath(contractId, { agentId }),
      outputPath,
    ].filter(Boolean);

    let raw = null;
    let resolvedPath = outputPath;
    for (const candidate of candidates) {
      try {
        raw = await readFile(candidate, "utf8");
        resolvedPath = candidate;
        break;
      } catch {
        raw = null;
      }
    }
    if (raw == null) {
      // 两处皆无
      return { isTerminal: true, outputPath: compactHomePath(outputPath), available: false, content: null, contentChars: 0 };
    }
    const truncated = raw.length > DELIVERY_CONTENT_CAP;
    const content = truncated ? raw.slice(0, DELIVERY_CONTENT_CAP) : raw;
    return {
      isTerminal: true,
      outputPath: compactHomePath(resolvedPath),
      available: true,
      content,
      contentChars: content.length,
      truncated,
    };
  } catch {
    return { isTerminal: false };
  }
}

// ── 系统投递解析（received）──────────────────────────────────────────────────
// 「系统/上游发来什么」= 系统投递到该 agent inbox 的合约。用户要看清系统究竟
// 投递了什么给 worker2（不要"无输入"）。来源优先级（读到即用）：
//   1. inbox 快照 threads/{t}/runs/{r}/participants/<agentId>/inbox-<contractId>/contract.json
//      （首选——agent_end 已把每个 agent 实收的 inbox 合约快照进 run 树，经 contract-index 找家）
//   2. live workspaces/<agentId>/inbox/contract.json（回退）
//   3. 共享合约正本（回退，resolveSharedContractPathById 经 contract-index 走树）
//
// 整段 try/catch：失败/无 contractId → { available:false }（不抛、不破坏主体）。
async function resolveReceived(agentId, contractId) {
  try {
    if (!contractId) return { available: false };

    // 候选源（按优先级），命中即用
    const candidates = [];

    // 1) inbox 快照：participants/<agentId>/inbox-<contractId>/contract.json
    //    （目录名用索引登记原串 home.id；索引键侧小写归一兜住 tc- 查询形态）
    try {
      const home = resolveContractHome(contractId);
      if (home) {
        candidates.push({
          source: "inbox-snapshot",
          path: join(participantInboxSnapshotDirFor(home, agentId, home.id || contractId), "contract.json"),
        });
      }
    } catch {
      // 家索引/路径段解析失败 → 无此候选，继续回退
    }

    // 2) live inbox：workspaces/<agentId>/inbox/contract.json
    candidates.push({ source: "live-inbox", path: join(OC, "workspaces", agentId, "inbox", "contract.json") });

    // 3) 共享合约正本（树店；索引 miss → 无此候选）
    const sharedPath = resolveSharedContractPathById(contractId);
    if (sharedPath) candidates.push({ source: "contract", path: sharedPath });

    for (const { source, path } of candidates) {
      let raw;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        continue; // 该源不存在 → 试下一个
      }
      // 解析 task（合约 JSON 的 task 字段；非 JSON/无 task → null）
      let task = null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && typeof parsed.task === "string") {
          task = parsed.task;
        }
      } catch {
        task = null; // .md 正本或非 JSON → task 留 null，raw 仍给原文
      }
      const truncated = raw.length > DELIVERY_CONTENT_CAP;
      const rawOut = truncated ? raw.slice(0, DELIVERY_CONTENT_CAP) : raw;
      return {
        available: true,
        source,
        path: compactHomePath(path),
        contractId,
        task,
        raw: rawOut,
        truncated,
      };
    }

    return { available: false };
  } catch {
    return { available: false };
  }
}

/**
 * 解析指定 agent/session 的 transcript。
 * 文件不存在 / 整体不可读 → 返回空 messages/referencedFiles 兜底结构（不抛）。
 *
 * 末位 agent（workflow 叶子，无出边）额外带 delivery：产出件
 * control-plane/output/<contractId>.md 的正文（用户最终接收到的消息）。
 * received：系统投递给该 agent 的合约（inbox 快照优先），即「系统/上游发来什么」。
 *
 * @param {string} agentId
 * @param {string} sessionId
 * @returns {Promise<{
 *   sessionId:string, agentId:string,
 *   messages:Array<{role,ts,text,thinking,toolCalls,toolResults}>,
 *   referencedFiles:Array<{rawPath,resolvedPath,persistent,kind}>,
 *   delivery:{ isTerminal:boolean, outputPath?:string|null, available?:boolean, content?:string|null, contentChars?:number, truncated?:boolean },
 *   received:{ available:boolean, source?:string, path?:string, contractId?:string, task?:string|null, raw?:string, truncated?:boolean },
 * }>}
 */
export async function readSessionTranscript(agentId, sessionId, { contractId = null } = {}) {
  const normalizedAgentId = typeof agentId === "string" ? agentId.trim() : "";
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedAgentId || !normalizedSessionId) {
    return {
      sessionId: normalizedSessionId,
      agentId: normalizedAgentId,
      messages: [],
      referencedFiles: [],
      delivery: { isTerminal: false },
      received: { available: false },
    };
  }

  // delivery/received 与 transcript 主体独立：即使无 jsonl 仍可解析投递与系统输入
  const delivery = await resolveDelivery(normalizedAgentId, contractId);
  const received = await resolveReceived(normalizedAgentId, contractId);
  // producedFiles：该 agent 产出的文件（持久产物包），独立于 referencedFiles（历史引用、常被清）
  const producedFiles = resolveProducedFiles(normalizedAgentId, contractId);

  const base = {
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
    messages: [],
    referencedFiles: [],
    delivery,
    received,
    producedFiles,
  };

  // live 优先，回退 archive 历史副本
  const raw = await readSessionJsonl(normalizedAgentId, normalizedSessionId);
  if (raw == null) return base;

  const messages = [];
  const rawPaths = new Set();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // 单行损坏跳过，不中断整体解析
    }
    if (!entry || entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
      continue;
    }
    const message = entry.message;
    const role = typeof message.role === "string" ? message.role : null;
    const { text, thinking, toolCalls, toolResults } = extractFromContent(message.content);
    // 真实格式里 toolResult 是独立 message(role="toolResult", toolName, content),
    // 不是 assistant 消息内的 content block —— 在此补成 toolResults 项,供路径扫描与展示。
    if (role === "toolResult") {
      toolResults.push({
        tool:
          (typeof message.toolName === "string" && message.toolName) ||
          (typeof message.toolCallId === "string" && message.toolCallId) ||
          null,
        contentText: text || stringifyToolResultContent(message.content),
      });
    }
    collectToolCallPaths(toolCalls, rawPaths);
    collectToolResultPaths(toolResults, rawPaths);
    collectTextPaths(text, rawPaths);
    messages.push({
      role,
      ts: entry.timestamp ?? message.timestamp ?? null,
      text,
      thinking,
      toolCalls,
      toolResults,
    });
  }

  const referencedFiles = [];
  for (const rawPath of rawPaths) {
    const resolved = resolveReferencedFile(rawPath, contractId);
    if (resolved) referencedFiles.push(resolved);
  }

  return {
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
    messages,
    referencedFiles,
    delivery,
    received,
    producedFiles,
  };
}
