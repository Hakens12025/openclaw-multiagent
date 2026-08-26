// lib/archive/thread-tree-store.js — 树店地址权威(备忘录142 §三定案C/§十四布局终裁,批②树店落地)。
//
// 布局:threads/{threadId}/runs/{runId}/ —— 目录名 = 谱系 id 原串(批②裁定:
// 身份即地址,不做二次改写;非法 charset 直接抛 = 调用方 bug,不是容错面)。
// run 目录固定成员(§十四,events.jsonl 文件账已随 v232 SQLite 终态退役):
// run.json / contracts/ / participants/ / assembly/ / workspace/,
// 其中 workspace/ 只留名不创建(§十一钩②,批④才施工)。
//
// id→路径索引(§三):建约时刻单写一行 {id,threadId,runId} 进 append-only JSONL,
// 常驻内存供【同步】解析(getContractPath 是全系统同步解析点,索引查询必须免 IO);
// 索引可全树扫描重建(rebuildContractIndex),坏行防御式跳过。
//
// 店根由 control-plane-paths.resolveOwnedStorePath 单源判定(显式种子>测试沙箱>生产根),每次 IO 现解析。
// 惰性解析(照抄 delivery-ticket-store 手法:mock.module 对静态可达消费者无效,
// 环境种子是对静态图也生效的唯一注入面;CONTROL_PLANE_PATHS 是模块加载期冻结
// 常量,只改它救不了先 import 后 setenv 的测试)。内存缓存按解析后的文件路径分键,
// 测试换根自动隔离。

import { readFileSync } from "node:fs";
import { open, appendFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "../state/state-file-utils.js";
import { CONTROL_PLANE_PATHS, resolveOwnedStorePath } from "../control-plane/control-plane-paths.js";
import { normalizeLineage } from "../contract/contract-lineage.js";
import { normalizeString } from "../core/normalize.js";

// §十四 run 目录成员名(单一来源,编译器/记录者共用)
export const RUN_CONTRACTS_DIRNAME = "contracts";
export const RUN_PARTICIPANTS_DIRNAME = "participants";
export const RUN_ASSEMBLY_DIRNAME = "assembly";
// §十一钩②:名字预留给批④(线性组共享空间),本批不创建、任何人不得占用该名。
export const RUN_WORKSPACE_DIRNAME = "workspace";

// ---- 路径解析(惰性种子) ----

export function resolveThreadsRoot() {
  // 店根门卫单源(control-plane-paths §13):显式种子 > 测试进程沙箱 > 生产根。
  return resolveOwnedStorePath("OPENCLAW_THREADS_DIR", CONTROL_PLANE_PATHS.threadsDir, "threads");
}

export function resolveContractIndexFile() {
  return resolveOwnedStorePath("OPENCLAW_CONTRACT_INDEX_FILE", CONTROL_PLANE_PATHS.contractIndexFile, "contract-index.jsonl");
}

// ---- 谱系→地址(身份即地址,不改写) ----

// id 原串直接做目录名:charset 白名单免路径穿越,越界即抛(铸造点保证合法,
// 走到这里还非法 = 调用方 bug,绝不改写救场)。
function assertIdSegment(value, label) {
  const id = normalizeString(value);
  if (!id || id === "." || id === ".." || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`thread-tree-store: invalid ${label} ${JSON.stringify(value)} — identity is the address, caller must pass a minted id`);
  }
  return id;
}

// 归一 + 双 id 齐全断言。批②规则:工厂兜底铸孤儿线,每约必有完整谱系——
// 走到树店还缺 id 是 bug,抛而不补。
export function requireRunLineage(lineage) {
  const normalized = normalizeLineage(lineage);
  const threadId = assertIdSegment(normalized?.threadId, "lineage.threadId");
  const runId = assertIdSegment(normalized?.runId, "lineage.runId");
  return { threadId, runId };
}

export function threadDirFor(lineage) {
  const threadId = assertIdSegment(normalizeLineage(lineage)?.threadId, "lineage.threadId");
  return join(resolveThreadsRoot(), threadId);
}

export function runDirFor(lineage) {
  const { threadId, runId } = requireRunLineage(lineage);
  return join(resolveThreadsRoot(), threadId, "runs", runId);
}

// ---- participants/{agent}/ 成员地址(布局单一权威,写者=agent_end 归档段;
// turn-*.json 归投影编译器,不在此列) ----

export function participantDirFor(lineage, agentId) {
  const aid = assertIdSegment(agentId, "agentId");
  return join(runDirFor(lineage), RUN_PARTICIPANTS_DIRNAME, aid);
}

// 会话转录副本(agents/ live .jsonl 的归档拷贝)
export function participantSessionJsonlFor(lineage, agentId, sessionId) {
  const sid = assertIdSegment(sessionId, "sessionId");
  return join(participantDirFor(lineage, agentId), `session-${sid}.jsonl`);
}

// 提示词拼装报告 sidecar
export function participantSessionPromptFor(lineage, agentId, sessionId) {
  const sid = assertIdSegment(sessionId, "sessionId");
  return join(participantDirFor(lineage, agentId), `session-${sid}.prompt.json`);
}

// inbox 过滤副本快照目录(清理 unlink 前留档,含 upstream/)
export function participantInboxSnapshotDirFor(lineage, agentId, contractId) {
  const cid = assertIdSegment(contractId, "contractId");
  return join(participantDirFor(lineage, agentId), `inbox-${cid}`);
}

// outbox 正本目录(批④刀2,备忘录143 §六:每合约粒度,与 inbox-{cid} 命名对称)。
// 真目录期仅作布局权威;切链后 workspace outbox 以 symlink 指向此处。
// 树链规范:树链一律绝对路径目标;文件级链不得作 atomicWriteFile/rename 目标。
export function participantOutboxDirFor(lineage, agentId, contractId) {
  const cid = assertIdSegment(contractId, "contractId");
  return join(participantDirFor(lineage, agentId), `outbox-${cid}`);
}

// 产出件快照(live 产出件被清后 delivery 的回退读面)
export function participantDeliverySnapshotFor(lineage, agentId, contractId) {
  const cid = assertIdSegment(contractId, "contractId");
  return join(participantDirFor(lineage, agentId), `delivery-${cid}.md`);
}

// run 脚手架:contracts/ participants/ assembly/ 三目录;workspace/ 只留名不创建
// (§十一钩②)。幂等,重复调用无害。
export async function ensureRunScaffold(lineage) {
  const runDir = runDirFor(lineage);
  const scaffold = {
    runDir,
    contractsDir: join(runDir, RUN_CONTRACTS_DIRNAME),
    participantsDir: join(runDir, RUN_PARTICIPANTS_DIRNAME),
    assemblyDir: join(runDir, RUN_ASSEMBLY_DIRNAME),
  };
  await mkdir(scaffold.contractsDir, { recursive: true });
  await mkdir(scaffold.participantsDir, { recursive: true });
  await mkdir(scaffold.assemblyDir, { recursive: true });
  return scaffold;
}

// ---- id→home 索引(append-only JSONL + 常驻内存) ----

// { filePath, byId: Map<lowercaseId, {id, threadId, runId}> } — 按解析路径分键,换根自动失效。
// 键侧 lowercase 归一(会话键派生的 id 是小写,APFS 大小写不敏感曾隐性兜底,索引必须显式兜);
// 值里保留原串 id —— 树文件名用原串,大小写归一绝不进路径。
let indexCache = null;

function indexKeyOf(id) {
  return id.toLowerCase();
}

function loadIndexCache() {
  const filePath = resolveContractIndexFile();
  if (indexCache && indexCache.filePath === filePath) return indexCache;
  const byId = new Map();
  let raw = null;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    // 文件未建 = 空索引(首约前的合法态)
  }
  if (raw) {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const id = normalizeString(parsed?.id);
        const threadId = normalizeString(parsed?.threadId);
        const runId = normalizeString(parsed?.runId);
        if (id && threadId && runId) byId.set(indexKeyOf(id), { id, threadId, runId });
      } catch {
        // 坏行(崩溃撕裂尾行)防御式跳过 — 索引可全树重建,不是真值
      }
    }
  }
  indexCache = { filePath, byId };
  return indexCache;
}

// 建约时刻单写一行(§三)。同 id 同 home 重登幂等跳写;同 id 异 home 追加,
// 读侧 last-wins(append-only 语义)。
export async function recordContractHome(contractId, lineage) {
  const id = assertIdSegment(contractId, "contractId");
  const { threadId, runId } = requireRunLineage(lineage);
  const cache = loadIndexCache();
  const existing = cache.byId.get(indexKeyOf(id));
  if (existing && existing.threadId === threadId && existing.runId === runId) {
    return { id, threadId, runId };
  }
  await mkdir(dirname(cache.filePath), { recursive: true });
  // fsync(审查⑥):索引是 getContractPath 同步解析的唯一底座——"合约已落树而索引
  // 行丢失"的崩溃窗必须堵;建约频率低,单行 fsync 成本可忽略。
  const handle = await open(cache.filePath, "a");
  try {
    await handle.writeFile(`${JSON.stringify({ id, threadId, runId })}\n`, "utf8");
    await handle.datasync();
  } finally {
    await handle.close().catch(() => {});
  }
  cache.byId.set(indexKeyOf(id), { id, threadId, runId });
  return { id, threadId, runId };
}

// 同步查询(getContractPath 的解析底座,保同步签名)。未收录 → null。
// 返回的 home.id 是登记时的【原串 id】——调用方拼文件名必须用它,不得用查询串
// (查询串可能是会话键派生的小写形态)。
export function resolveContractHome(contractId) {
  const id = normalizeString(contractId);
  if (!id) return null;
  const home = loadIndexCache().byId.get(indexKeyOf(id));
  return home ? { ...home } : null;
}

// 全树扫描重建:threads/{t}/runs/{r}/contracts/*.json → 索引整文件原子重写。
// 排序遍历保证重建输出确定性。
export async function rebuildContractIndex({ logger = null } = {}) {
  const root = resolveThreadsRoot();
  const filePath = resolveContractIndexFile();
  const byId = new Map();
  const threadNames = await listDirectoryNames(root);
  for (const threadId of threadNames) {
    const runNames = await listDirectoryNames(join(root, threadId, "runs"));
    for (const runId of runNames) {
      let contractFiles = [];
      try {
        contractFiles = await readdir(join(root, threadId, "runs", runId, RUN_CONTRACTS_DIRNAME));
      } catch {
        continue; // run 无 contracts/(纯事件 run)是合法态
      }
      for (const name of contractFiles.filter((file) => file.endsWith(".json")).sort()) {
        const id = name.slice(0, -".json".length);
        byId.set(indexKeyOf(id), { id, threadId, runId });
      }
    }
  }
  const lines = [...byId.values()]
    .map((home) => JSON.stringify({ id: home.id, threadId: home.threadId, runId: home.runId }))
    .join("\n");
  await mkdir(dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, lines ? `${lines}\n` : "");
  indexCache = { filePath, byId };
  logger?.info?.(`[thread-tree-store] contract index rebuilt: ${byId.size} entries`);
  return { entries: byId.size };
}

async function listDirectoryNames(parent) {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}
