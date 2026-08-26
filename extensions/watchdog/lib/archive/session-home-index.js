// lib/archive/session-home-index.js — 会话 id→run 家索引(备忘录142 批③B)。
//
// 行 {sessionId,sessionKey,agentId,threadId,runId,ts},append-only JSONL。
// 真值是树上的 participants/{agent}/session-{sid}.jsonl,索引只是查询加速面:
// 可全树扫描重建(rebuildSessionIndex),故追加写不 fsync(丢行只损一次查询,
// boot 重建归真;对比 contract-index 必须 fsync 的差异:那边是同步解析唯一底座)。
//
// 环境种子 OPENCLAW_SESSION_INDEX_FILE 在每次 IO 时惰性解析(同 contract-index
// 手法);内存缓存按解析后文件路径分键,测试换根自动隔离。键侧 lowercase 归一,
// 值保留原串 —— 树文件名用原串,大小写归一绝不进路径。

import { readFileSync } from "node:fs";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "../state/state-file-utils.js";
import { CONTROL_PLANE_PATHS, resolveOwnedStorePath } from "../control-plane/control-plane-paths.js";
import { normalizeString } from "../core/normalize.js";
import {
  RUN_PARTICIPANTS_DIRNAME,
  requireRunLineage,
  resolveThreadsRoot,
} from "./thread-tree-store.js";

const SESSION_JSONL_PATTERN = /^session-(.+)\.jsonl$/;

export function resolveSessionIndexFile() {
  // 店根门卫单源(control-plane-paths §13)。
  return resolveOwnedStorePath("OPENCLAW_SESSION_INDEX_FILE", CONTROL_PLANE_PATHS.sessionIndexFile, "session-index.jsonl");
}

// { filePath, byId: Map<lowercaseSessionId, entry> } — last-wins(append-only 语义)
let indexCache = null;

function indexKeyOf(sessionId) {
  return sessionId.toLowerCase();
}

function normalizeEntry(raw) {
  const sessionId = normalizeString(raw?.sessionId);
  const threadId = normalizeString(raw?.threadId);
  const runId = normalizeString(raw?.runId);
  if (!sessionId || !threadId || !runId) return null;
  return {
    sessionId,
    sessionKey: normalizeString(raw?.sessionKey) || null,
    agentId: normalizeString(raw?.agentId) || null,
    threadId,
    runId,
    ts: Number.isFinite(raw?.ts) ? Number(raw.ts) : null,
  };
}

function loadIndexCache() {
  const filePath = resolveSessionIndexFile();
  if (indexCache && indexCache.filePath === filePath) return indexCache;
  const byId = new Map();
  let raw = null;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    // 文件未建 = 空索引(首次归档前的合法态)
  }
  if (raw) {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = normalizeEntry(JSON.parse(line));
        if (entry) byId.set(indexKeyOf(entry.sessionId), entry);
      } catch {
        // 坏行(崩溃撕裂尾行)防御式跳过 — 索引可全树重建,不是真值
      }
    }
  }
  indexCache = { filePath, byId };
  return indexCache;
}

// 归档时刻单写一行。同 sessionId 同 home 重登幂等跳写;异 home 追加,读侧 last-wins。
export async function recordSessionHome({ sessionId, sessionKey = null, agentId = null, lineage, ts = null } = {}) {
  const sid = normalizeString(sessionId);
  if (!sid) throw new Error("session-home-index: sessionId required");
  const { threadId, runId } = requireRunLineage(lineage);
  const entry = {
    sessionId: sid,
    sessionKey: normalizeString(sessionKey) || null,
    agentId: normalizeString(agentId) || null,
    threadId,
    runId,
    ts: Number.isFinite(ts) ? Number(ts) : null,
  };
  const cache = loadIndexCache();
  const existing = cache.byId.get(indexKeyOf(sid));
  if (existing && existing.threadId === threadId && existing.runId === runId) {
    cache.byId.set(indexKeyOf(sid), entry);
    return entry;
  }
  await mkdir(dirname(cache.filePath), { recursive: true });
  await appendFile(cache.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  cache.byId.set(indexKeyOf(sid), entry);
  return entry;
}

// 同步查询。未收录 → null。返回的 sessionId 是登记原串,拼文件名必须用它。
export function resolveSessionHome(sessionId) {
  const sid = normalizeString(sessionId);
  if (!sid) return null;
  const entry = loadIndexCache().byId.get(indexKeyOf(sid));
  return entry ? { ...entry } : null;
}

// 全索引同步遍历(agentId 过滤可选)。历史会话列表(listAgentSessions)的归档合并源:
// 树上 participants/{agent}/session-*.jsonl 是真值,这里只是它的查询加速面。
export function listSessionHomes(agentId = null) {
  const aid = normalizeString(agentId);
  const entries = [...loadIndexCache().byId.values()];
  const filtered = aid ? entries.filter((entry) => entry.agentId === aid) : entries;
  return filtered.map((entry) => ({ ...entry }));
}

// 全树扫描重建:threads/{t}/runs/{r}/participants/{agent}/session-*.jsonl →
// 索引整文件原子重写。sessionKey/ts 不可从树反推 —— 现存行 home 一致时保留其元数据,
// 否则置 null(home 四元才是索引承重面)。排序遍历保证输出确定性。
export async function rebuildSessionIndex({ logger = null } = {}) {
  const root = resolveThreadsRoot();
  const filePath = resolveSessionIndexFile();
  const previous = loadIndexCache();
  const byId = new Map();
  for (const threadId of await listDirectoryNames(root)) {
    for (const runId of await listDirectoryNames(join(root, threadId, "runs"))) {
      const participantsDir = join(root, threadId, "runs", runId, RUN_PARTICIPANTS_DIRNAME);
      for (const agentId of await listDirectoryNames(participantsDir)) {
        let files = [];
        try {
          files = await readdir(join(participantsDir, agentId));
        } catch {
          continue;
        }
        for (const name of files.sort()) {
          const match = SESSION_JSONL_PATTERN.exec(name);
          if (!match) continue;
          const sessionId = match[1];
          const kept = previous.byId.get(indexKeyOf(sessionId));
          const sameHome = kept && kept.threadId === threadId && kept.runId === runId;
          byId.set(indexKeyOf(sessionId), {
            sessionId,
            sessionKey: sameHome ? kept.sessionKey : null,
            agentId,
            threadId,
            runId,
            ts: sameHome ? kept.ts : null,
          });
        }
      }
    }
  }
  const lines = [...byId.values()].map((entry) => JSON.stringify(entry)).join("\n");
  await mkdir(dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, lines ? `${lines}\n` : "");
  indexCache = { filePath, byId };
  logger?.info?.(`[session-home-index] session index rebuilt: ${byId.size} entries`);
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
