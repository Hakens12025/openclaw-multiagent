// session-trace-store.js — append-only per-session evidence ledger (spec §3;
// 文件账退役批起 records DB 的 trace_event 行是唯一真值,哈希链随文件层退役)。
// open/seq/close 哨兵 + (sessionKey,seq) 唯一索引守完整性:同一 session 的第二次
// seq 发行(双写者)被 DB 当场拒 → record_rejected + console.error 报警。
// Callers must treat every export as non-critical: evidence failures are
// swallowed by the bridge layer and must never block execution.
//
// per-session append queue: parallel tool calls make appendRecord re-entrant,
// and the read-state → assign-seq → write window would hand out duplicate seqs.
// Promise-chaining serializes it.

import { getRunSeqWatermark } from "../archive/run-event-recorder.js";
import { resolveContractHome } from "../archive/thread-tree-store.js";
import { getTraceMaxSeq, writeTraceEvent } from "../record-plane/record-writer.js";
import { tryReadTraceEventsFromDb } from "../record-plane/record-reader.js";
import { TRACE_SENTINELS } from "./trace-event-schema.js";

const TRACE_VERSION = 1;
// sessionKey → { seq }:seq 计数器常驻内存,首触从 DB 重建(getTraceMaxSeq)。
const sessions = new Map();
// sessionKey → 本进程见过的关联合约(阶段2.2 锚点解析用):凡条目自带 contractId
// 即记下(open 哨兵/证据桥工具事件都带)。同进程同 session 的账本自述,不是猜;
// 进程重启后自然为空 —— 锚点是弱语义影子,宁缺不补。close 时随 sessions 一起清。
const sessionContracts = new Map();
const appendQueues = new Map(); // sessionKey -> Promise

function enqueueAppend(sessionKey, work) {
  const prior = appendQueues.get(sessionKey) || Promise.resolve();
  const next = prior.then(work, work);
  appendQueues.set(sessionKey, next.catch(() => {}));
  return next;
}

// 首触重建:从 DB 取该 session 已落账的最大 seq。无行 → -1(开新账)。
// DB 打不开 → 外抛(证据面弱于执行面,由 evidence-bridge 吞掉;不造假续接)。
async function loadSessionState(sessionKey) {
  if (sessions.has(sessionKey)) return sessions.get(sessionKey);
  const maxSeq = getTraceMaxSeq(sessionKey);
  const state = { seq: Number.isInteger(maxSeq) && maxSeq >= 0 ? maxSeq : -1 };
  sessions.set(sessionKey, state);
  return state;
}

// 阶段2.2 跨账本锚点(148 §二 2.2,happened-during 弱语义,非因果):
// 合约 →(契约索引同步内存查询)→ 所属 run →(recorder 内存水位)→ 最新 seq。
// 任一环节缺席 → null(锚点列留 NULL,不造假);解析失败同 —— 证据面弱于执行面。
function resolveTraceAnchor(contractId) {
  if (!contractId) return null;
  try {
    const home = resolveContractHome(contractId);
    if (!home?.runId) return null;
    const seq = getRunSeqWatermark(home.runId);
    if (!Number.isInteger(seq) || seq < 1) return null;
    return { anchorRunId: home.runId, anchorSeq: seq };
  } catch {
    return null;
  }
}

function appendRecord(sessionKey, recordOrFactory) {
  return enqueueAppend(sessionKey, async () => {
    const state = await loadSessionState(sessionKey);
    const record = typeof recordOrFactory === "function"
      ? recordOrFactory(state)
      : recordOrFactory;
    const entry = {
      seq: state.seq + 1,
      traceVersion: TRACE_VERSION,
      ...record,
    };
    // 真值写(records DB):失败/撞 (sessionKey,seq) 唯一索引在 writer 内报警 +
    // 入 record_rejected,绝不阻断执行流(证据面弱于执行面)。内存 seq 照常推进,
    // 被拒行留在 record_rejected 隔离账,不丢。
    // 阶段2.2:写入时刻解析跨账本锚点 —— 条目自带的 contractId 优先,否则用本
    // session 此前账本自述过的合约(close 哨兵等无 contractId 的条目)。
    if (entry.contractId) sessionContracts.set(sessionKey, entry.contractId);
    const anchor = resolveTraceAnchor(entry.contractId ?? sessionContracts.get(sessionKey));
    writeTraceEvent(entry, anchor);
    sessions.set(sessionKey, { seq: entry.seq });
    return entry;
  });
}

export async function openSessionTrace(sessionKey, { agentId = "unknown", contractId = null } = {}) {
  return appendRecord(sessionKey, {
    kind: TRACE_SENTINELS.OPEN,
    sessionKey, agentId,
    ...(contractId ? { contractId } : {}),
    ts: Date.now(),
  });
}

export async function appendTraceEvent(sessionKey, event) {
  // 自愈开账:open 哨兵只在 before_agent_start 写,主会话与复用会话走不到那里,
  // 账本会永久缺开哨兵(考官恒判 incomplete)。首条记录非 open 时就地补一条,
  // 让"谁写谁开账"成为账本自身的不变式。
  const state = await loadSessionState(sessionKey);
  if (state.seq < 0) {
    await appendRecord(sessionKey, {
      kind: TRACE_SENTINELS.OPEN,
      sessionKey,
      agentId: event?.agentId || "unknown",
      ...(event?.contractId ? { contractId: event.contractId } : {}),
      lazy: true,
      ts: event?.ts || Date.now(),
    });
  }
  return appendRecord(sessionKey, event);
}

export async function closeSessionTrace(sessionKey, { success = null } = {}) {
  // eventCount is computed inside the queue (record factory) so in-flight
  // appends from parallel tool calls are counted before the close lands.
  const entry = await appendRecord(sessionKey, (state) => ({
    kind: TRACE_SENTINELS.CLOSE,
    sessionKey,
    ...(success === null ? {} : { success }),
    eventCount: state.seq + 2,
    ts: Date.now(),
  }));
  sessions.delete(sessionKey);
  sessionContracts.delete(sessionKey);
  appendQueues.delete(sessionKey);
  return entry;
}

// 完整性判定(records 序列):seq 从 0 连续 + 首尾哨兵。哈希链判定随文件层退役
// (fork 防线 = (sessionKey,seq) 唯一索引,写入侧当场拒)。
export function validateSessionTraceContent(records) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return { complete: false, reason: "empty trace", records: [] };
  for (let i = 0; i < list.length; i++) {
    if (!Number.isInteger(list[i]?.seq) || list[i].seq !== i) {
      return { complete: false, reason: `seq gap at ${i}`, records: list };
    }
  }
  if (list[0].kind !== TRACE_SENTINELS.OPEN) {
    return { complete: false, reason: "missing open sentinel", records: list };
  }
  if (list[list.length - 1].kind !== TRACE_SENTINELS.CLOSE) {
    return { complete: false, reason: "missing close sentinel", records: list };
  }
  return { complete: true, reason: null, records: list };
}

// 哨兵扣减单源:总行数减 open(+close)。布局归本模块所有,消费方勿自算。
export function countTraceEvents(validation) {
  const total = validation?.records?.length || 0;
  return Math.max(0, total - (validation?.complete ? 2 : 1));
}

// 整读+校验(收官批处理用):records DB 读该会话全量记录并判完整性。
// 读不到(DB 缺席)→ null,由调用方决定退化语义。
export function readValidatedSessionTraceSync(sessionKey) {
  const records = tryReadTraceEventsFromDb(sessionKey);
  if (records === null) return null;
  const validation = validateSessionTraceContent(records);
  return { ...validation, eventCount: countTraceEvents(validation) };
}

export function clearSessionTraceMemory() {
  sessions.clear();
  sessionContracts.clear();
}
