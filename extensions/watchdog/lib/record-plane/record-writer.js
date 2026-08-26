// lib/record-plane/record-writer.js — 记录面真值写层(文件账退役批起,DB 是唯一真值)。
//
// 两个写点:
//   run-event-recorder group commit → writeRunEvents(entries[]) 单事务批量插入
//   session-trace-store appendRecord → writeTraceEvent(entry, anchor) 单条插入
//
// 失败纪律按账本分层(与文件时代一一对应):
//   run_event(事实账)—— writeRunEvents 失败【外抛】(事务回滚),由 recorder 的
//     "整批退回 buffer 头重试"纪律兜住:事实账是执行面的地基,不许"写不进就算了"。
//   trace_event(证据账)—— 证据面弱于执行面:写失败/撞 (sessionKey,seq) 唯一索引
//     (双写者形态)→ console.error 报警 + 原行入 record_rejected,绝不阻断 agent
//     执行流。record_rejected 即证据隔离账,行不丢,只是没进正账。
//
// 冲突语义(149 H3:禁止裸 INSERT OR IGNORE):两类身份撞号都是 throw,只是
// run_event 的 throw 穿透给调用方重试,trace_event 的 throw 落 record_rejected。
//
// 全局序(阶段2 方案 c)不变:gseq ≡ AUTOINCREMENT id。批插在同一事务内按数组序
// 执行,id 顺序 = 到达顺序;bootId 进程级发行(randomUUID),首次写库登记 boots。
//
// 真值查询(供 recorder/store 的 hydrate 与 GC 关账门/孤儿判定):一律走
// openDatabase 写连接——这些是事实判定,不许"读不到就当没有"的宽容回退。

import { randomUUID } from "node:crypto";

import { openDatabase, resolveRecordDbPath } from "./database.js";

const INSERT_RUN_SQL = `
  INSERT INTO records (kind, threadId, runId, sessionKey, contractId, seq, bootId, ts, type, payload, synthesized, causeRefs)
  VALUES ('run_event', $threadId, $runId, $sessionKey, $contractId, $seq, $bootId, $ts, $type, $payload, $synthesized, $causeRefs)
`;
const INSERT_TRACE_SQL = `
  INSERT INTO records (kind, sessionKey, contractId, seq, bootId, ts, hash, prevHash, name, payload, synthesized, anchorRunId, anchorSeq)
  VALUES ('trace_event', $sessionKey, $contractId, $seq, $bootId, $ts, $hash, $prevHash, $name, $payload, $synthesized, $anchorRunId, $anchorSeq)
`;
const INSERT_REJECTED_SQL = `
  INSERT INTO record_rejected (source, reason, line, ts) VALUES ($source, $reason, $line, $ts)
`;
const INSERT_BOOT_SQL = `
  INSERT INTO boots (bootId, startedAt) VALUES ($bootId, $startedAt)
  ON CONFLICT(bootId) DO NOTHING
`;

// ---- 真值查询 SQL(hydrate / GC 关账门 / 孤儿判定) ----
const SELECT_RUN_MAX_SEQ_SQL = `
  SELECT MAX(seq) AS maxSeq FROM records WHERE kind = 'run_event' AND runId = ?
`;
const SELECT_TRACE_MAX_SEQ_SQL = `
  SELECT MAX(seq) AS maxSeq FROM records WHERE kind = 'trace_event' AND sessionKey = ?
`;
const SELECT_RUN_EXISTS_SQL = `
  SELECT 1 AS hit FROM records WHERE kind = 'run_event' AND runId = ? LIMIT 1
`;
const SELECT_CONTRACT_EVENT_SQL = (typeCount) => `
  SELECT 1 AS hit FROM records
  WHERE kind = 'run_event' AND runId = $runId AND contractId = $contractId
    AND type IN (${Array.from({ length: typeCount }, (_, i) => `$t${i}`).join(", ")})
  LIMIT 1
`;
const SELECT_CREATED_CONTRACTS_SQL = `
  SELECT contractId, MIN(seq) AS firstSeq FROM records
  WHERE kind = 'run_event' AND runId = ? AND type = 'contract_created' AND contractId IS NOT NULL
  GROUP BY contractId ORDER BY firstSeq ASC
`;
const SELECT_CLOSED_CONTRACTS_SQL = `
  SELECT DISTINCT contractId FROM records
  WHERE kind = 'run_event' AND runId = ? AND type = 'closed' AND contractId IS NOT NULL
`;

// DatabaseSync → prepared statements(WeakMap 绑连接对象:连接关闭被 GC 后语句
// 缓存随之失效,不会出现"语句绑着已关连接"的陈旧态)。
const statementCache = new WeakMap();
// open 失败的路径记一笔,warn 一次后容错写变 no-op(不刷屏;严格写仍照抛)。
const failedPaths = new Set();

// 进程级 boot 号:本进程首次写库时发行并登记 boots 表;重启 = 新进程 = 新 bootId,
// 同库 gseq(≡ id)延续增长 —— "跨重启连续"就锁在这两个量上。
let processBootId = null;
// 已登记过 boot 行的库路径(每进程每库只插一次,其后跳过)。
const bootRegisteredPaths = new Set();

export function getRecordBootId() {
  if (!processBootId) processBootId = randomUUID();
  return processBootId;
}

// 登记本进程 boot 行。失败只 warn,绝不挡事件本体写入。
function ensureBootRegistered(stmts, dbPath) {
  if (bootRegisteredPaths.has(dbPath)) return;
  try {
    stmts.insertBoot.run({ bootId: getRecordBootId(), startedAt: Date.now() });
    bootRegisteredPaths.add(dbPath);
  } catch (error) {
    console.warn(`[record-plane] boot registration failed (non-blocking): ${error?.message || error}`);
  }
}

function statementsFor(dbPath) {
  const db = openDatabase(dbPath);
  let stmts = statementCache.get(db);
  if (!stmts) {
    stmts = {
      db,
      insertRun: db.prepare(INSERT_RUN_SQL),
      insertTrace: db.prepare(INSERT_TRACE_SQL),
      insertRejected: db.prepare(INSERT_REJECTED_SQL),
      insertBoot: db.prepare(INSERT_BOOT_SQL),
    };
    statementCache.set(db, stmts);
  }
  return stmts;
}

// 149 §二 判据:synthesized:true 字段(runtime 合成记账,见 evidence-bridge)之外,
// 测试合成事件的实测定性是 agentId/sessionKey 带 -probe- / -proto- 段
// (worker-proto-probe-<ts> / planner-proto-tail-<ts> / model-probe-<slug> 一族)。
const PROBE_PATTERN = /-(?:proto|probe)-/i;

export function isSynthesizedRecord({ synthesized = false, agentId = "", sessionKey = "" } = {}) {
  if (synthesized === true) return true;
  return PROBE_PATTERN.test(String(agentId || "")) || PROBE_PATTERN.test(String(sessionKey || ""));
}

function safePayload(value) {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

function runEventParams(entry, bootId) {
  return {
    threadId: entry?.threadId ?? null,
    runId: entry?.runId ?? null,
    sessionKey: entry?.sessionKey ?? null,
    contractId: entry?.contractId ?? null,
    seq: Number.isInteger(entry?.seq) ? entry.seq : null,
    bootId,
    ts: Number.isInteger(entry?.ts) ? entry.ts : Date.now(),
    type: entry?.type ?? null,
    payload: safePayload(entry),
    synthesized: isSynthesizedRecord(entry || {}) ? 1 : 0,
    causeRefs: Array.isArray(entry?.causeRefs) && entry.causeRefs.length
      ? JSON.stringify(entry.causeRefs)
      : null,
  };
}

function traceEventParams(entry, anchor, bootId) {
  return {
    sessionKey: entry?.sessionKey ?? null,
    contractId: entry?.contractId ?? null,
    seq: Number.isInteger(entry?.seq) ? entry.seq : null,
    bootId,
    ts: Number.isInteger(entry?.ts) ? entry.ts : Date.now(),
    hash: entry?.hash ?? null,
    prevHash: entry?.prevHash ?? null,
    // 工具名优先;open/close 哨兵没有 name,落哨兵 kind 保持可查询。
    name: entry?.name ?? entry?.kind ?? null,
    payload: safePayload(entry),
    synthesized: isSynthesizedRecord(entry || {}) ? 1 : 0,
    anchorRunId: anchor?.anchorRunId ?? null,
    anchorSeq: Number.isInteger(anchor?.anchorSeq) ? anchor.anchorSeq : null,
  };
}

// 拒收入账:原行全文 + 原因 + 来源。自身失败只 warn,永不递归、永不外抛。
function recordRejected(stmts, { source, reason, line }) {
  try {
    stmts.insertRejected.run({
      source: String(source || "unknown"),
      reason: String(reason || "unknown").slice(0, 1000),
      line: typeof line === "string" ? line : safePayload(line),
      ts: Date.now(),
    });
  } catch (error) {
    console.warn(`[record-plane] record_rejected insert failed (non-blocking): ${error?.message || error}`);
  }
}

// ── run 事件真值写:单事务批量插入(文件账退役批) ─────────────────────────────
// entry 形状同文件时代({seq, ts, threadId, runId, type, contractId?, sessionKey?,
// agentId?, payload?, causeRefs?})。失败:事务回滚 + 【外抛】——调用方(recorder
// group commit)以整批退回重试兜住,事实账没有容错降级。成功返回与入参同序的
// [{ gseq, bootId }](gseq = 各行 AUTOINCREMENT id = 全局序)。
export function writeRunEvents(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const dbPath = resolveRecordDbPath();
  const stmts = statementsFor(dbPath);
  const { db } = stmts;
  ensureBootRegistered(stmts, dbPath);
  const bootId = getRecordBootId();
  const params = entries.map((entry) => runEventParams(entry, bootId));
  db.exec("BEGIN");
  try {
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const result = stmts.insertRun.run(params[i]);
      out.push({ gseq: Number(result.lastInsertRowid), bootId });
    }
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* 连接已坏,回滚失败随外抛一起显形 */ }
    throw error;
  }
}

// ── trace 事件真值写:单条插入(证据账,容错) ─────────────────────────────────
// entry = session-trace-store 的原始行({seq, sessionKey, kind/name, ts, ...});
// anchor(可选)= { anchorRunId, anchorSeq }:写入时刻该 session 关联合约所属 run
// 的事件账水位(happened-during 弱语义,由 session-trace-store 解析好传入)。
// 成功返回 { gseq, bootId };失败/撞 (sessionKey,seq) 唯一索引(双写者)返回
// undefined,原行入 record_rejected + console.error —— 证据面绝不反噬执行面。
export function writeTraceEvent(entry, anchor = null) {
  const dbPath = resolveRecordDbPath();
  if (failedPaths.has(dbPath)) return undefined;
  let stmts = null;
  try {
    stmts = statementsFor(dbPath);
    ensureBootRegistered(stmts, dbPath);
    const bootId = getRecordBootId();
    const result = stmts.insertTrace.run(traceEventParams(entry, anchor, bootId));
    return { gseq: Number(result.lastInsertRowid), bootId };
  } catch (error) {
    if (!stmts) {
      failedPaths.add(dbPath);
      console.error(`[record-plane] open failed for ${dbPath}, trace writes disabled (non-blocking): ${error?.message || error}`);
      return undefined;
    }
    console.error(`[record-plane] trace_event write rejected (non-blocking): ${error?.message || error}`);
    recordRejected(stmts, { source: "session-trace-store", reason: error?.message || error, line: entry });
    return undefined;
  }
}

// ── 真值查询(写连接;open 失败照抛 = 事实判定不许静默降级) ────────────────────

// run 事件账 seq 水位(recorder 首触 hydrate/crash 恢复):无行 → 0。
export function getRunMaxSeq(runId) {
  const stmts = statementsFor(resolveRecordDbPath());
  const row = stmts.db.prepare(SELECT_RUN_MAX_SEQ_SQL).get(String(runId ?? ""));
  return Number.isInteger(row?.maxSeq) ? row.maxSeq : 0;
}

// trace 证据账 seq 水位(session-trace-store 首触 hydrate):无行 → null(开新账)。
export function getTraceMaxSeq(sessionKey) {
  const stmts = statementsFor(resolveRecordDbPath());
  const row = stmts.db.prepare(SELECT_TRACE_MAX_SEQ_SQL).get(String(sessionKey ?? ""));
  return Number.isInteger(row?.maxSeq) ? row.maxSeq : null;
}

// run 是否已有任何事件(run-event-wiring trigger:"auto" 探针,原 stat 语义)。
export function runHasEvents(runId) {
  const stmts = statementsFor(resolveRecordDbPath());
  return stmts.db.prepare(SELECT_RUN_EXISTS_SQL).get(String(runId ?? "")) != null;
}

// 合约级事件查询(crash-recovery 孤儿判定):该合约在本 run 账上是否出现过给定
// 类型事件。types 空数组恒 false(与文件时代签名一致)。
export function hasRunEventForContract(runId, contractId, types = []) {
  const ids = Array.isArray(types) ? types.map(String) : [];
  if (!contractId || ids.length === 0) return false;
  const stmts = statementsFor(resolveRecordDbPath());
  const params = { runId: String(runId ?? ""), contractId: String(contractId) };
  ids.forEach((type, i) => { params[`t${i}`] = type; });
  return stmts.db.prepare(SELECT_CONTRACT_EVENT_SQL(ids.length)).get(params) != null;
}

// GAP-02 run 关账判定辅助:contract_created 无对应 closed 的合约,按首次 created
// 序返回(空数组 = 可落 run_closed)。语义逐条对齐文件时代 deriveRunOpenContracts。
export function deriveOpenContracts(runId) {
  const stmts = statementsFor(resolveRecordDbPath());
  const runIdStr = String(runId ?? "");
  const created = stmts.db.prepare(SELECT_CREATED_CONTRACTS_SQL).all(runIdStr);
  if (!created.length) return [];
  const closed = new Set(
    stmts.db.prepare(SELECT_CLOSED_CONTRACTS_SQL).all(runIdStr).map((row) => row.contractId),
  );
  return created.map((row) => row.contractId).filter((id) => !closed.has(id));
}

// ── 单条容错写(测试/工具用;生产写点走上面的批量与真值接口) ──────────────────
// run 侧单条容错语义:失败/撞 (runId,seq) → record_rejected + console.error,
// 不外抛。生产路径(run-event-recorder)用 writeRunEvents 的严格批插。

export function shadowRunEvent(entry) {
  try {
    return writeRunEvents([entry])[0];
  } catch (error) {
    const stmts = safeStatementsForRejected();
    if (stmts) {
      console.error(`[record-plane] run_event shadow write rejected (non-blocking): ${error?.message || error}`);
      recordRejected(stmts, { source: "run-event-recorder", reason: error?.message || error, line: entry });
    } else {
      console.error(`[record-plane] run_event shadow write failed (non-blocking): ${error?.message || error}`);
    }
    return undefined;
  }
}

// 旧名别名 = writeTraceEvent(测试沿用旧名)。
export function shadowTraceEvent(entry, anchor = null) {
  return writeTraceEvent(entry, anchor);
}

function safeStatementsForRejected() {
  try {
    return statementsFor(resolveRecordDbPath());
  } catch {
    return null;
  }
}

// 测试用:清掉失败记名(语句缓存是 WeakMap,随连接关闭自然失效,无需清)。
export function clearRecordWriterStateForTests() {
  failedPaths.clear();
}

// 测试用:清进程级 boot 号与登记记名 —— 下一次写入等同"第二个进程/重启后首写",
// 锁"跨重启连续"回归(新 bootId,gseq 不重置)。
export function resetRecordBootIdForTests() {
  processBootId = null;
  bootRegisteredPaths.clear();
}
