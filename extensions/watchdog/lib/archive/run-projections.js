// lib/archive/run-projections.js — 投影编译器 = 投影文件唯一写者(备忘录142 §八/§十二/§十四)。
//
// 真值唯 records DB 的 run_event 行(文件账退役批);本模块产出的 run.json /
// participants/agents.json / participants/{agent}/turn-{seq04}.json / thread.json
// 全部是编译投影:可 rm 后重编,编译是事件账的【确定性纯函数】(输出零墙钟字段
// → 重编字节幂等)。
//
// 编译时机(§十二.1 三档):脏标记(recorder 每批落库后标脏)+ run_closed 必编
// (recorder 触发)+ 读方 on-demand(compileRunProjectionsIfDirty)。
// 依赖方向单向:recorder → 本模块。本模块只读事件账(records DB,经
// record-reader 只读打开),不 import recorder —— 避免环。读到的是已落库前缀,
// 投影是缓存,滞后合法。DB 不可读 → 编译抛错(调用方按"投影坏≠事实丢"纪律
// 兜住,投影保持脏),不得用空事件把好投影洗白。
//
// §十一钩④:run.json 恒带 externalMounts: [] 字段位(批④挂载表的家,本批不实现)。
// §十四:回合降格为文件 turn-{seq04}.json(seq 入名安全:run 内 recorder 单写者),
// 回合文件只存事件指针;assemblyRef 为 assembly/{hash}.txt 指针位,本批恒 null。

import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  RUN_PARTICIPANTS_DIRNAME,
  requireRunLineage,
  runDirFor,
  threadDirFor,
} from "./thread-tree-store.js";
import { atomicWriteFile } from "../state/state-file-utils.js";
import { normalizeString } from "../core/normalize.js";
import { tryReadRunEventsFromDb } from "../record-plane/record-reader.js";

const PROJECTION_VERSION = 1;

// 与 run-event-recorder 的注册表同名同值;字面量重复而非 import,保持依赖单向。
const TYPE_RUN_TRIGGERED = "run_triggered";
const TYPE_CONTRACT_CREATED = "contract_created";
const TYPE_TURN_STARTED = "turn_started";
const TYPE_CLOSED = "closed";
const TYPE_RUN_CLOSED = "run_closed";

const dirtyRuns = new Set(); // runDir 集合;recorder 每批落盘后标脏

export function markRunProjectionDirty(lineage) {
  dirtyRuns.add(runDirFor(lineage));
}

// 读方 on-demand 入口:脏 或 run.json 缺失 → 编;否则直接用现有投影。
export async function compileRunProjectionsIfDirty(lineage) {
  const runDir = runDirFor(lineage);
  if (!dirtyRuns.has(runDir)) {
    const hasRunJson = await stat(join(runDir, "run.json")).then(() => true).catch(() => false);
    if (hasRunJson) return { compiled: false };
  }
  const result = await compileRunProjections(lineage);
  return { compiled: true, ...result };
}

// 全量编译:run.json + participants/agents.json + 回合文件 + thread.json。
export async function compileRunProjections(lineage) {
  const { threadId, runId } = requireRunLineage(lineage);
  const runDir = runDirFor({ threadId, runId });
  const events = await readEventsForProjection({ threadId, runId });

  const run = buildRunProjection({ threadId, runId }, events);
  const roster = buildAgentsProjection(events);
  const turns = buildTurnProjections(events);

  const participantsDir = join(runDir, RUN_PARTICIPANTS_DIRNAME);
  await mkdir(participantsDir, { recursive: true });
  await atomicWriteFile(join(runDir, "run.json"), serializeProjection(run));
  await atomicWriteFile(join(participantsDir, "agents.json"), serializeProjection(roster));
  for (const turn of turns) {
    if (!isSafeSegment(turn.agentId)) continue; // 防御:目录名=agentId 原名(§十四),异常名跳过不拖垮编译
    const agentDir = join(participantsDir, turn.agentId);
    await mkdir(agentDir, { recursive: true });
    await atomicWriteFile(join(agentDir, `turn-${padSeq(turn.seq)}.json`), serializeProjection(turn));
  }

  const thread = await buildThreadProjection({ threadId }, { runId, run });
  await atomicWriteFile(join(threadDirFor({ threadId }), "thread.json"), serializeProjection(thread));

  dirtyRuns.delete(runDir);
  return { runDir, projectedThroughSeq: run.projectedThroughSeq, turnCount: turns.length };
}

// ---- 事件账读取(只读已落库前缀) ----

async function readEventsForProjection(lineage) {
  const fromDb = tryReadRunEventsFromDb(lineage.runId);
  if (fromDb === null) {
    // DB 缺席/不可读:抛错让编译失败(投影保持脏)——空事件会把好投影洗白。
    throw new Error(`records DB unavailable, projection compile aborted for run ${lineage.runId}`);
  }
  return fromDb;
}

// ---- 纯编译函数(事件账 → 投影形状;禁止墙钟/随机,保重编幂等) ----

function buildRunProjection({ threadId, runId }, events) {
  const trigger = events.find((event) => event.type === TYPE_RUN_TRIGGERED) || null;
  const runClosedEvent = events.findLast((event) => event.type === TYPE_RUN_CLOSED) || null;
  const created = [];
  const closedIds = [];
  const closedSet = new Set();
  for (const event of events) {
    const contractId = normalizeString(event?.contractId);
    if (!contractId) continue;
    if (event.type === TYPE_CONTRACT_CREATED && !created.includes(contractId)) {
      created.push(contractId);
    } else if (event.type === TYPE_CLOSED && !closedSet.has(contractId)) {
      closedSet.add(contractId);
      closedIds.push(contractId);
    }
  }
  return {
    projectionVersion: PROJECTION_VERSION,
    threadId,
    runId,
    trigger: trigger
      ? { seq: trigger.seq, ts: trigger.ts ?? null, payload: trigger.payload ?? null }
      : null,
    closed: Boolean(runClosedEvent),
    closedSummary: runClosedEvent
      ? { seq: runClosedEvent.seq, ts: runClosedEvent.ts ?? null, payload: runClosedEvent.payload ?? null }
      : null,
    contracts: {
      created,
      closed: closedIds,
      open: created.filter((id) => !closedSet.has(id)),
    },
    eventCount: events.length,
    projectedThroughSeq: events.length ? events[events.length - 1].seq : 0,
    firstTs: events.length ? events[0].ts ?? null : null,
    lastTs: events.length ? events[events.length - 1].ts ?? null : null,
    externalMounts: [], // §十一钩④:字段位预留(批④ thread 级挂载),本批恒空
  };
}

function buildAgentsProjection(events) {
  const byAgent = new Map();
  for (const event of events) {
    const agentId = normalizeString(event?.agentId);
    if (!agentId) continue;
    let record = byAgent.get(agentId);
    if (!record) {
      record = { agentId, firstSeq: event.seq, lastSeq: event.seq, turnCount: 0, contractIds: [] };
      byAgent.set(agentId, record);
    }
    record.lastSeq = event.seq;
    if (event.type === TYPE_TURN_STARTED) record.turnCount += 1;
    const contractId = normalizeString(event?.contractId);
    if (contractId && !record.contractIds.includes(contractId)) record.contractIds.push(contractId);
  }
  return {
    projectionVersion: PROJECTION_VERSION,
    agents: [...byAgent.values()].sort((a, b) => a.firstSeq - b.firstSeq),
  };
}

// 回合切分:agent 的 turn_started 到该 agent 下一次 turn_started 前为一回合;
// 回合文件只存事件指针 {seq, type, contractId?}(§十四),不复制载荷。
function buildTurnProjections(events) {
  const turnStarts = events.filter(
    (event) => event.type === TYPE_TURN_STARTED && normalizeString(event?.agentId),
  );
  return turnStarts.map((turnStart) => {
    const agentId = normalizeString(turnStart.agentId);
    const nextStart = turnStarts.find(
      (candidate) => normalizeString(candidate.agentId) === agentId && candidate.seq > turnStart.seq,
    );
    const attributed = events.filter(
      (event) =>
        normalizeString(event?.agentId) === agentId
        && event.seq >= turnStart.seq
        && (!nextStart || event.seq < nextStart.seq),
    );
    return {
      projectionVersion: PROJECTION_VERSION,
      agentId,
      seq: turnStart.seq,
      ts: turnStart.ts ?? null,
      sessionKey: normalizeString(turnStart.sessionKey),
      contractId: normalizeString(turnStart.contractId),
      causeRefs: Array.isArray(turnStart.causeRefs) ? turnStart.causeRefs : [],
      events: attributed.map((event) => ({
        seq: event.seq,
        type: event.type,
        ...(normalizeString(event?.contractId) ? { contractId: event.contractId } : {}),
      })),
      assemblyRef: null, // §十四:assembly/{hash}.txt 指针位,装配快照本批不落
    };
  });
}

// thread.json:run 清单(目录名排序 ≈ 时间近似序,§九"ls 天然近似有序")+ 续接谱系槽位。
// origin/continuedFrom 取最早 run 的 run_triggered payload 同名字段(§三:来源+续接谱系)。
async function buildThreadProjection({ threadId }, current) {
  const runsDir = join(threadDirFor({ threadId }), "runs");
  let runNames = [];
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    runNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    runNames = [];
  }
  if (!runNames.includes(current.runId)) runNames.push(current.runId);

  const sources = [];
  for (const runId of runNames) {
    if (runId === current.runId) {
      sources.push({ runId, runJson: current.run });
      continue;
    }
    sources.push({ runId, runJson: await readJsonOrNull(join(runsDir, runId, "run.json")) });
  }
  const firstTrigger = sources.find((source) => source.runJson?.trigger)?.runJson.trigger ?? null;
  return {
    projectionVersion: PROJECTION_VERSION,
    threadId,
    origin: firstTrigger?.payload?.origin ?? null,
    continuedFrom: firstTrigger?.payload?.continuedFrom ?? null,
    runs: sources.map(({ runId, runJson }) => ({
      runId,
      closed: runJson ? Boolean(runJson.closed) : null, // null = 该 run 尚未编译投影
      projectedThroughSeq: runJson?.projectedThroughSeq ?? null,
    })),
  };
}

// ---- 小工具 ----

function serializeProjection(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function padSeq(seq) {
  return String(seq).padStart(4, "0");
}

function isSafeSegment(value) {
  return typeof value === "string" && value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}
