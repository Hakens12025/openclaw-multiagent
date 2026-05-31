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
import { OC } from "../state-paths.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { loadGraph, getEdgesFrom } from "./agent-graph.js";
import { artifactPackageDir, ARTIFACT_MANIFEST_FILE } from "../lifecycle/artifact-store.js";

// 投递正文单文件上限（字符），与 system-prompt 路径一致。超出截断 + truncated:true。
const DELIVERY_CONTENT_CAP = 40000;

// 产物包内单文件正文上限（字符）。
const PRODUCED_CONTENT_CAP = 40000;

// 该 agent 在本 contract 的产物包（持久，过 session-clean）：
//   control-plane/artifacts/<contractId>/<agentId>/{manifest.json + 产物文件们}
// 直接读包内文件正文供页面内显——异于 referencedFiles 的 reveal（那些是历史引用、常被清理）：
// 这些是该 agent 真正产出的文件，且独立留存不被清。
function resolveProducedFiles(agentId, contractId) {
  const empty = { available: false, files: [], manifest: null };
  try {
    const cid = typeof contractId === "string" ? contractId.trim() : "";
    const aid = typeof agentId === "string" ? agentId.trim() : "";
    if (!cid || !aid) return empty;
    const dir = artifactPackageDir(cid, aid);
    if (!existsSync(dir)) return empty;

    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(join(dir, ARTIFACT_MANIFEST_FILE), "utf8"));
    } catch { /* 无 manifest 也照样列文件 */ }
    const primary = manifest && typeof manifest.primary === "string" ? manifest.primary : null;

    const names = readdirSync(dir).filter((n) => n !== ARTIFACT_MANIFEST_FILE);
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
      files.push({ name, path: p, chars, truncated, content, primary: name === primary });
    }
    files.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0)); // 主交付物排前

    return {
      available: files.length > 0,
      files,
      manifest: manifest
        ? { producer: manifest.producer || aid, producedAt: manifest.producedAt || null, summary: manifest.summary || null, primary }
        : null,
    };
  } catch {
    return empty;
  }
}

function liveSessionFile(agentId, sessionId) {
  return join(OC, "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

function archivedSessionFile(agentId, sessionId) {
  return join(CONTROL_PLANE_PATHS.root, "session-archive", agentId, `${sessionId}.jsonl`);
}

// 先读 live .jsonl（= truth），不存在则回退 archive 历史副本。两处皆无 → null。
async function readSessionJsonl(agentId, sessionId) {
  try {
    return await readFile(liveSessionFile(agentId, sessionId), "utf8");
  } catch {
    // live 不在（如被 session-clean 清），回退归档副本
  }
  try {
    return await readFile(archivedSessionFile(agentId, sessionId), "utf8");
  } catch {
    return null;
  }
}

// ── 引用文件路径解析 ──────────────────────────────────────────────────────────
// 规则（来自设计稿）：
//   workspaces/<a>/inbox/contract.json            → 正本 control-plane/contracts/<contractId>.json (kind=contract)
//   workspaces/<a>/output/<TC>.md                 → control-plane/output/<TC>.md (kind=output)
//   control-plane/output/<TC>.md                  → control-plane/output/<TC>.md (kind=output)
//   其它                                          → kind=other, resolvedPath=原路径
//
// 注意：正本 contracts 目录是 control-plane/contracts/（代码真值，
// CONTROL_PLANE_PATHS.contractsDir），非设计稿文字里的 ~/.openclaw/contracts/。

// 在 dir 里按 basename **大小写不敏感**找实际文件(sessionKey 把 contractId 小写成 tc-,
// 但正本文件名是 TC-,直接拼路径会 miss)。命中→返回实际大小写路径;否则返回构造路径(persistent=false)。
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
    // 正本按 session 的 contractId 解析(大小写不敏感);拿不到 contractId 则保留原路径
    resolvedPath = contractId
      ? resolveCaseInsensitive(CONTROL_PLANE_PATHS.contractsDir, `${contractId}.json`)
      : raw;
  } else {
    const outputMatch = raw.match(/(?:workspaces\/[^/]+\/output|control-plane\/output)\/(.+)$/);
    if (outputMatch) {
      kind = "output";
      resolvedPath = resolveCaseInsensitive(CONTROL_PLANE_PATHS.outputDir, outputMatch[1]);
    }
  }

  return {
    rawPath: raw,
    resolvedPath,
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
// 接收到的消息」是产出件 control-plane/output/<contractId>.md 的正文(终端投递给
// 用户的实际内容)，区别于 agent 自己的输出气泡(LLM 叙述"我输出了")。
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
    // workflow-trace 快照回退路径(live 产出件被 session-clean 清后仍能读到最终件)
    const tracePath = join(CONTROL_PLANE_PATHS.root, "workflow-trace", contractId, "output.md");

    let raw = null;
    let resolvedPath = outputPath;
    try {
      // live 优先
      raw = await readFile(outputPath, "utf8");
    } catch {
      // live 缺 → 回退快照
      try {
        raw = await readFile(tracePath, "utf8");
        resolvedPath = tracePath;
      } catch {
        raw = null;
      }
    }
    if (raw == null) {
      // 两处皆无
      return { isTerminal: true, outputPath, available: false, content: null, contentChars: 0 };
    }
    const truncated = raw.length > DELIVERY_CONTENT_CAP;
    const content = truncated ? raw.slice(0, DELIVERY_CONTENT_CAP) : raw;
    return {
      isTerminal: true,
      outputPath: resolvedPath,
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
//   1. inbox 快照 control-plane/workflow-trace/<contractId>/<agentId>/inbox/contract.json
//      （首选——agent_end 已把每个 agent 实收的 inbox 合约快照在此）
//   2. live workspaces/<agentId>/inbox/contract.json（回退）
//   3. 正本 control-plane/contracts/<contractId>.md 或 .json（回退，大小写不敏感）
//
// 整段 try/catch：失败/无 contractId → { available:false }（不抛、不破坏主体）。
async function resolveReceived(agentId, contractId) {
  try {
    if (!contractId) return { available: false };

    // 候选源（按优先级），命中即用
    const candidates = [];

    // 1) inbox 快照：workflow-trace/<contractId>/<agentId>/inbox/contract.json
    //    <contractId> 目录是原始大小写（TC-），传入 contractId 小写（tc-），需大小写不敏感解析目录段
    const traceRoot = join(CONTROL_PLANE_PATHS.root, "workflow-trace");
    const contractDir = resolveCaseInsensitive(traceRoot, contractId);
    candidates.push({ source: "inbox-snapshot", path: join(contractDir, agentId, "inbox", "contract.json") });

    // 2) live inbox：workspaces/<agentId>/inbox/contract.json
    candidates.push({ source: "live-inbox", path: join(OC, "workspaces", agentId, "inbox", "contract.json") });

    // 3) 正本：control-plane/contracts/<contractId>.json 或 .md（大小写不敏感）
    candidates.push({ source: "contract", path: resolveCaseInsensitive(CONTROL_PLANE_PATHS.contractsDir, `${contractId}.json`) });
    candidates.push({ source: "contract", path: resolveCaseInsensitive(CONTROL_PLANE_PATHS.contractsDir, `${contractId}.md`) });

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
        path,
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
