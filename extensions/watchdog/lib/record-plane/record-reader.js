// lib/record-plane/record-reader.js — 记录面读侧唯一入口(阶段1 读面切换,148 §二 / 150 §十二)。
//
// 与 record-writer(双写影子)对称:写面在 recorder/store 落盘时同步影子写,
// 读面从这里只读取出。纪律:
// - 【只读打开】DatabaseSync { readOnly: true },读面绝不写库;DDL 与
//   journal_mode/synchronous 这类写性 PRAGMA 一概不跑(只读连接上也跑不了)。
// - 【失败不炸】DB 文件缺席、打不开、查询失败一律返回 null,由调用方回落文件读
//   (双写验证期垫片)——影子缺席不许拖垮排障工具,正如影子写失败不反噬主流程。
// - 【排序铁律】(142 §九):run_event 按 (seq, id)、trace_event 按 (seq, id) 排,
//   ts 永不作排序键。D-H 定谳 trace 的 seq 可 fork,撞号时以 id(插入序)兜底保确定性。
// - payload 是双写写入的原事件 JSON 全文,JSON.parse 后与原文件行等价;
//   坏行(理论上不该有)防御式跳过,与文件读侧的坏行纪律一致。
// - 测试护栏与写面同一条:node --test 下拒开生产默认库路径。

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { assertNotProductionInTests, resolveRecordDbPath } from "./database.js";

const SELECT_RUN_EVENTS_SQL = `
  SELECT payload FROM records
  WHERE kind = 'run_event' AND runId = ?
  ORDER BY seq ASC, id ASC
`;
const SELECT_TRACE_EVENTS_SQL = `
  SELECT payload FROM records
  WHERE kind = 'trace_event' AND sessionKey = ?
  ORDER BY seq ASC, id ASC
`;
// 带锚点/全局序的 trace 行读(inspect.trace surface 专用):payload 之外补
// gseq(≡ id)与 anchorRunId/anchorSeq —— 时间线按锚点把证据行插回事件之后,
// 没有这两列前端只能拿 ts 近似贴,违背"店内权威序"纪律。
const SELECT_TRACE_ROWS_SQL = `
  SELECT id, anchorRunId, anchorSeq, payload FROM records
  WHERE kind = 'trace_event' AND sessionKey = ?
  ORDER BY seq ASC, id ASC
`;
const SELECT_RUN_MAX_TS_SQL = `
  SELECT MAX(ts) AS maxTs FROM records WHERE kind = 'run_event' AND runId = ?
`;
const SELECT_RECENT_TRACE_SESSIONS_SQL = `
  SELECT sessionKey, MAX(id) AS lastId, MAX(ts) AS lastTs, COUNT(*) AS rowCount
  FROM records WHERE kind = 'trace_event' AND sessionKey IS NOT NULL
  GROUP BY sessionKey ORDER BY lastId DESC LIMIT ?
`;
// 全局序水位(阶段2):gseq ≡ records.id 派生,列不填。
const SELECT_GLOBAL_RANGE_SQL = `
  SELECT MIN(id) AS minGseq, MAX(id) AS maxGseq, COUNT(*) AS rowCount FROM records
`;
const SELECT_BOOTS_COUNT_SQL = `SELECT COUNT(*) AS c FROM boots`;

// dbPath → 只读连接。与写面连接分开缓存:读写打开模式不同,不可混用。
const readConnections = new Map();
// 打开失败的路径记一笔,其后直接判缺席(不反复撞同一个坏路径;工具进程短命,无需重试)。
const failedReadPaths = new Set();

// 只读打开记录面 DB。文件缺席或打开失败返回 null(调用方回落文件读)。
export function openReadOnlyDatabase(dbPath = resolveRecordDbPath()) {
  const cached = readConnections.get(dbPath);
  if (cached) return cached;
  if (failedReadPaths.has(dbPath)) return null;
  assertNotProductionInTests(dbPath);
  if (dbPath !== ":memory:" && !existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    readConnections.set(dbPath, db);
    return db;
  } catch {
    failedReadPaths.add(dbPath);
    return null;
  }
}

function parsePayloads(rows) {
  const out = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.payload));
    } catch {
      // 影子行 payload 损坏:跳过(同文件读侧的坏行纪律),不拖垮整段读取
    }
  }
  return out;
}

// run 事件账按 runId 取全量,按 (seq, id) 升序(= 文件序语义)。
// 返回解析后的事件数组(DB 可查但无行 → []);DB 不可用/查询失败 → null(回落文件)。
export function tryReadRunEventsFromDb(runId, dbPath) {
  const db = openReadOnlyDatabase(dbPath);
  if (!db) return null;
  try {
    return parsePayloads(db.prepare(SELECT_RUN_EVENTS_SQL).all(String(runId)));
  } catch {
    return null;
  }
}

// trace 证据账按 sessionKey 取全量,按 (seq, id) 升序。返回语义同上。
export function tryReadTraceEventsFromDb(sessionKey, dbPath) {
  const db = openReadOnlyDatabase(dbPath);
  if (!db) return null;
  try {
    return parsePayloads(db.prepare(SELECT_TRACE_EVENTS_SQL).all(String(sessionKey)));
  } catch {
    return null;
  }
}

// trace 证据账带锚点读(观测面用):payload 展开 + gseq(≡ records.id)/anchorRunId/
// anchorSeq 列随行 —— 时间线按锚点把证据行插回对应事件之后,没有这两列只能
// 拿 ts 近似贴,违背"店内权威序"纪律(142 §九)。返回语义同上(DB 不可用 → null)。
export function tryReadTraceRowsFromDb(sessionKey, dbPath) {
  const db = openReadOnlyDatabase(dbPath);
  if (!db) return null;
  try {
    const out = [];
    for (const row of db.prepare(SELECT_TRACE_ROWS_SQL).all(String(sessionKey))) {
      let payload;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        continue; // 坏行跳过(同 parsePayloads 纪律)
      }
      out.push({
        ...payload,
        gseq: Number(row.id),
        anchorRunId: row.anchorRunId ?? null,
        anchorSeq: Number.isInteger(row.anchorSeq) ? row.anchorSeq : null,
      });
    }
    return out;
  } catch {
    return null;
  }
}

// run 事件账最新 ts(listThreads 展示字段)。无行/DB 不可用 → null。
export function tryReadRunMaxTsFromDb(runId, dbPath) {
  const db = openReadOnlyDatabase(dbPath);
  if (!db) return null;
  try {
    const row = db.prepare(SELECT_RUN_MAX_TS_SQL).get(String(runId));
    return Number.isFinite(row?.maxTs) ? row.maxTs : null;
  } catch {
    return null;
  }
}

// 最近有证据记录的会话(健康巡检抽样用):按最后落账 id 倒序取 N 个
// [{ sessionKey, lastTs, rowCount }]。DB 不可用/查询失败 → null。
export function listRecentTraceSessions({ limit = 40 } = {}, dbPath) {
  const db = openReadOnlyDatabase(dbPath);
  if (!db) return null;
  const capped = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 40;
  try {
    return db.prepare(SELECT_RECENT_TRACE_SESSIONS_SQL).all(capped).map((row) => ({
      sessionKey: row.sessionKey,
      lastTs: Number.isFinite(row.lastTs) ? row.lastTs : null,
      rowCount: Number(row.rowCount ?? 0),
    }));
  } catch {
    return null;
  }
}

// 全局序水位(阶段2,对账/体检用):{ minGseq, maxGseq, rowCount, boots }。
// gseq ≡ records.id(AUTOINCREMENT)派生;boots = boots 元表行数(库老于阶段2、
// 尚无 boots 表时防御式计 0)。空库 min/max 为 null。DB 不可用/查询失败 → null。
export function getGlobalRange(dbPath) {
  const db = openReadOnlyDatabase(dbPath);
  if (!db) return null;
  try {
    const row = db.prepare(SELECT_GLOBAL_RANGE_SQL).get();
    let boots = 0;
    try {
      boots = db.prepare(SELECT_BOOTS_COUNT_SQL).get().c;
    } catch {
      boots = 0; // 老库无 boots 表(只读连接不跑 schema),按 0 报
    }
    return {
      minGseq: row?.minGseq ?? null,
      maxGseq: row?.maxGseq ?? null,
      rowCount: Number(row?.rowCount ?? 0),
      boots: Number(boots),
    };
  } catch {
    return null;
  }
}

// 合约预算哨兵用(2026-08-26):水位 gseq 之后新建的合约数(DISTINCT contractId,
// kind=run_event type=contract_created)。DB 不可用/查询失败 → null(哨兵侧不误杀)。
export function countContractsCreatedSince(sinceId, dbPath) {
  const db = openReadOnlyDatabase(dbPath);
  if (!db) return null;
  try {
    const row = db.prepare(
      "SELECT COUNT(DISTINCT contractId) AS n FROM records WHERE kind = 'run_event' AND type = 'contract_created' AND id > ?",
    ).get(Number(sinceId) || 0);
    return Number(row?.n ?? 0);
  } catch {
    return null;
  }
}

// 测试用:关掉并忘掉全部只读连接与失败记名,不碰库文件。
export function closeRecordReadersForTests() {
  for (const db of readConnections.values()) {
    try { db.close(); } catch { /* 已关 */ }
  }
  readConnections.clear();
  failedReadPaths.clear();
}
