// lib/archive/run-tree-inspect.js — 树形真值(threads/{t}/runs/{r})的只读观测面。
//
// 定址/寻家全部复用 thread-tree-store / session-home-index / outbox-seal 既有函数,
// 本模块零写零删,只做防御式读取 + 摘要投影,供 cli-surface-inspector 的
// inspect.threads / inspect.run / inspect.run_events / inspect.run_causality /
// inspect.contract_seal / inspect.tree_indexes 六个表面分发调用。
//
// 事件账读面(文件账退役批):全部读 records DB(按 (seq,id) 升序 = 到达序)。
// source ∈ "db"|"none":none = DB 缺席/打不开(观测面如实报缺,不回落——文件账
// 已退役,没有可回落的东西)。badLines 是文件撕裂时代的指标,表面字段保留、恒 0,
// 供 dashboard 兼容。树内 run.json/contracts/participants 的读取不动:那是"物"。
//
// GC 语义:run 目录被 GC 后按 found:false 返回(合法 404,非错误);索引行仍在而
// 树目录已消失时同样归入 found:false —— 索引是加速面,树目录才是在场判据。

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  RUN_CONTRACTS_DIRNAME,
  RUN_PARTICIPANTS_DIRNAME,
  requireRunLineage,
  resolveContractHome,
  resolveContractIndexFile,
  resolveThreadsRoot,
  runDirFor,
} from "./thread-tree-store.js";
import { resolveSessionIndexFile } from "./session-home-index.js";
import { findSealedOutbox, readOutboxSeal, sameContractIdentity } from "./outbox-seal.js";
import { normalizeString } from "../core/normalize.js";
import { tryReadRunEventsFromDb, tryReadRunMaxTsFromDb } from "../record-plane/record-reader.js";

const DEFAULT_THREAD_LIMIT = 50;
const DEFAULT_EVENT_LIMIT = 20;

// ---- 共用小读具 ----

async function listDirectoryNames(parent) {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function listFileNames(parent) {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

// 事件读取:records DB 唯一来源(按 (seq,id) 升序 = 到达序;同 seq 撞号被库唯一
// 索引当场拒,不存在"同 seq 保首条"问题)。返回 { exists, events, badLines, source }:
//   exists   DB 可查且该 run 有行
//   source   "db" | "none"(none = DB 缺席/打不开,观测面如实报缺)
//   badLines 恒 0:文件撕裂时代指标,字段保留供表面/dashboard 兼容
async function readRunEventsParsed(lineage) {
  const fromDb = tryReadRunEventsFromDb(lineage.runId);
  if (fromDb === null) {
    return { exists: false, events: [], badLines: 0, source: "none" };
  }
  return { exists: fromDb.length > 0, events: fromDb, badLines: 0, source: "db" };
}

// 该 run 最新事件 ts(listThreads 展示字段)。DB MAX(ts);无行/库缺席 → null。
async function readLatestEventTs(lineage) {
  return tryReadRunMaxTsFromDb(lineage.runId);
}

// ---- inspect.threads ----

// threads 根扫描 → 每线程 {threadId, runCount, latestRunId, latestTs}。
// latestRunId 取目录名排序末位(§九 目录名 ≈ 时间近似序);latestTs 取该 run
// 事件账的 DB MAX(ts)(仅展示字段)。输出按 latestTs 新前排序,limit 截断。
export async function listThreads({ limit = DEFAULT_THREAD_LIMIT } = {}) {
  const root = resolveThreadsRoot();
  const cappedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : DEFAULT_THREAD_LIMIT;
  const threadNames = await listDirectoryNames(root);
  const threads = [];
  for (const threadId of threadNames) {
    const runNames = await listDirectoryNames(join(root, threadId, "runs"));
    const latestRunId = runNames.length ? runNames[runNames.length - 1] : null;
    const latestTs = latestRunId
      ? await readLatestEventTs({ threadId, runId: latestRunId })
      : null;
    threads.push({ threadId, runCount: runNames.length, latestRunId, latestTs });
  }
  threads.sort((a, b) => (Number(b.latestTs) || 0) - (Number(a.latestTs) || 0));
  const returned = threads.slice(0, cappedLimit);
  return {
    counts: { total: threads.length, returned: returned.length },
    threads: returned,
  };
}

// ---- inspect.run ----

// run 详情:run.json 投影(在则用,缺则 null——投影滞后合法)+ contracts/ 清单 +
// participants 目录树摘要(每 agent: turn 文件数/session 副本数/outbox 封条态)。
export async function readRunDetail({ threadId, runId } = {}) {
  const lineage = requireRunLineage({ threadId, runId });
  const runDir = runDirFor(lineage);
  if (!(await directoryExists(runDir))) {
    return { found: false, threadId: lineage.threadId, runId: lineage.runId };
  }

  let run = null;
  try {
    run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  } catch {
    // 投影未编/半写 → null,事件账(records DB)仍是真值
  }

  const contractIds = (await listFileNames(join(runDir, RUN_CONTRACTS_DIRNAME)))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));

  const participantsDir = join(runDir, RUN_PARTICIPANTS_DIRNAME);
  const participants = [];
  for (const agentId of await listDirectoryNames(participantsDir)) {
    const agentDir = join(participantsDir, agentId);
    const files = await listFileNames(agentDir);
    const subdirs = await listDirectoryNames(agentDir);
    const outboxes = [];
    for (const name of subdirs.filter((entry) => entry.startsWith("outbox-"))) {
      const contractId = name.slice("outbox-".length);
      const seal = readOutboxSeal(join(agentDir, name));
      outboxes.push({
        contractId,
        sealed: Boolean(seal && sameContractIdentity(seal.contractId, contractId)),
        declaredStatus: normalizeString(seal?.declaredStatus) || null,
        collectedAt: Number.isFinite(seal?.collectedAt) ? seal.collectedAt : null,
      });
    }
    participants.push({
      agentId,
      turnFileCount: files.filter((name) => /^turn-\d+\.json$/.test(name)).length,
      sessionCopyCount: files.filter((name) => /^session-.+\.jsonl$/.test(name)).length,
      inboxSnapshotCount: subdirs.filter((entry) => entry.startsWith("inbox-")).length,
      outboxes,
    });
  }

  return {
    found: true,
    threadId: lineage.threadId,
    runId: lineage.runId,
    run,
    contracts: { count: contractIds.length, ids: contractIds },
    participants,
  };
}

// ---- inspect.run_events ----

// events.jsonl 分页读:afterSeq 给定 → seq > afterSeq 的前 limit 条(向后翻页);
// 缺省 → 尾部 limit 条(最新窗口)。latestSeq 恒为账上最大 seq,供续读游标。
export async function readRunEvents({ threadId, runId, afterSeq = null, limit = DEFAULT_EVENT_LIMIT } = {}) {
  const lineage = requireRunLineage({ threadId, runId });
  if (!(await directoryExists(runDirFor(lineage)))) {
    return { found: false, threadId: lineage.threadId, runId: lineage.runId };
  }
  const cappedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : DEFAULT_EVENT_LIMIT;
  const parsedAfterSeq = Number.isFinite(Number(afterSeq)) && afterSeq !== null && afterSeq !== ""
    ? Math.floor(Number(afterSeq))
    : null;
  const { events, badLines, source } = await readRunEventsParsed(lineage);
  const window = parsedAfterSeq !== null
    ? events.filter((event) => event.seq > parsedAfterSeq).slice(0, cappedLimit)
    : events.slice(-cappedLimit);
  return {
    found: true,
    threadId: lineage.threadId,
    runId: lineage.runId,
    source, // db|none:DB 唯一来源,none = 库缺席(如实报缺)
    totalEvents: events.length,
    latestSeq: events.length ? events[events.length - 1].seq : 0,
    badLines, // 恒 0:文件撕裂时代指标,字段保留供 dashboard 兼容
    afterSeq: parsedAfterSeq,
    limit: cappedLimit,
    events: window,
  };
}

// ---- inspect.run_causality ----

// 事件→节点,causeRefs→边。跨 run 引用原样透出(edge.crossRun=true,来源节点
// 不在本 run 节点集内,由读方按 {runId,seq} 全局地址跨 run 解析)。
export async function readRunCausality({ threadId, runId } = {}) {
  const lineage = requireRunLineage({ threadId, runId });
  if (!(await directoryExists(runDirFor(lineage)))) {
    return { found: false, threadId: lineage.threadId, runId: lineage.runId };
  }
  const { events } = await readRunEventsParsed(lineage);
  const nodes = events.map((event) => ({
    seq: event.seq,
    ts: event.ts ?? null,
    type: event.type ?? null,
    ...(normalizeString(event?.contractId) ? { contractId: event.contractId } : {}),
    ...(normalizeString(event?.agentId) ? { agentId: event.agentId } : {}),
    ...(normalizeString(event?.sessionKey) ? { sessionKey: event.sessionKey } : {}),
  }));
  const edges = [];
  for (const event of events) {
    if (!Array.isArray(event?.causeRefs)) continue;
    for (const ref of event.causeRefs) {
      const refRunId = normalizeString(ref?.runId);
      if (!refRunId || !Number.isInteger(ref?.seq)) continue;
      edges.push({
        from: { runId: refRunId, seq: ref.seq },
        to: { runId: lineage.runId, seq: event.seq },
        crossRun: refRunId !== lineage.runId,
      });
    }
  }
  return {
    found: true,
    threadId: lineage.threadId,
    runId: lineage.runId,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      crossRunEdges: edges.filter((edge) => edge.crossRun).length,
    },
    nodes,
    edges,
  };
}

// ---- inspect.contract_seal ----

// 经 contract-index 寻家(resolveContractHome)→ 扫全参与者 outbox-{cid}/seal.json。
// seals 列全部在场封条(多跳管线同 cid 多份),latest 为 findSealedOutbox 终局采信
// (collectedAt 时间序最新者)。无家(索引未收录/GC 后重建缺失)→ found:false。
export async function readContractSeal({ contractId } = {}) {
  const queryId = normalizeString(contractId);
  const home = queryId ? resolveContractHome(queryId) : null;
  if (!home) {
    return { found: false, contractId: queryId || null };
  }
  const cid = home.id;
  const participantsDir = join(runDirFor(home), RUN_PARTICIPANTS_DIRNAME);
  if (!(await directoryExists(participantsDir))) {
    // 索引行在而树目录已 GC → 同 found:false(树目录才是在场判据)
    return { found: false, contractId: cid, threadId: home.threadId, runId: home.runId };
  }
  const seals = [];
  for (const agentId of await listDirectoryNames(participantsDir)) {
    const outboxDir = join(participantsDir, agentId, `outbox-${cid}`);
    const seal = readOutboxSeal(outboxDir);
    if (!seal || !sameContractIdentity(seal.contractId, cid)) continue;
    seals.push({
      agentId,
      collectedAt: Number.isFinite(seal.collectedAt) ? seal.collectedAt : null,
      primary: normalizeString(seal.primary) || null,
      files: Array.isArray(seal.files) ? seal.files.filter((name) => typeof name === "string") : [],
      declaredStatus: normalizeString(seal.declaredStatus) || null,
    });
  }
  seals.sort((a, b) => (Number(b.collectedAt) || 0) - (Number(a.collectedAt) || 0));
  const latestHit = findSealedOutbox(cid);
  return {
    found: true,
    contractId: cid,
    threadId: home.threadId,
    runId: home.runId,
    counts: { seals: seals.length },
    latest: latestHit
      ? {
          agentId: latestHit.agentId,
          collectedAt: Number.isFinite(latestHit.seal?.collectedAt) ? latestHit.seal.collectedAt : null,
          primary: normalizeString(latestHit.seal?.primary) || null,
          declaredStatus: normalizeString(latestHit.seal?.declaredStatus) || null,
        }
      : null,
    seals,
  };
}

// ---- inspect.tree_indexes ----

async function summarizeIndexFile(filePath, extractKey) {
  let raw = null;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return { exists: false, lines: 0, parsedLines: 0, entries: 0 };
  }
  let lines = 0;
  let parsedLines = 0;
  const keys = new Set();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    lines += 1;
    try {
      const parsed = JSON.parse(line);
      const key = extractKey(parsed);
      if (key) {
        parsedLines += 1;
        keys.add(key.toLowerCase());
      }
    } catch {
      // 坏行只计 lines,不计 parsed
    }
  }
  return { exists: true, lines, parsedLines, entries: keys.size };
}

// 两索引统计(行数/可解析行/去重实体数,last-wins 语义下 entries=有效键数),
// 只算不 dump。loadable 表示按当前行可载入内存缓存(entries>0 或空文件皆合法)。
export async function readTreeIndexes() {
  const contractIndex = await summarizeIndexFile(
    resolveContractIndexFile(),
    (parsed) => (normalizeString(parsed?.id) && normalizeString(parsed?.threadId) && normalizeString(parsed?.runId))
      ? normalizeString(parsed.id)
      : null,
  );
  const sessionIndex = await summarizeIndexFile(
    resolveSessionIndexFile(),
    (parsed) => (normalizeString(parsed?.sessionId) && normalizeString(parsed?.threadId) && normalizeString(parsed?.runId))
      ? normalizeString(parsed.sessionId)
      : null,
  );
  return {
    contractIndex: { ...contractIndex, loadable: contractIndex.exists },
    sessionIndex: { ...sessionIndex, loadable: sessionIndex.exists },
  };
}
