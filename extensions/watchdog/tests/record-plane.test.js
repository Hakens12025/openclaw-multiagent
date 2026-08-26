// Tests: lib/record-plane/ — 记录面真值层(文件账退役批:records DB 是唯一真值)。
//
// 锁六件事:
//   ① 店根门卫守卫(§13):测试进程 resolveRecordDbPath 恒离生产(显式种子或沙箱)
//      改道;测试进程显式打开真 control-plane/records.db 会被护栏拒掉;
//   ② schema 幂等:重复 open / 重开连接不炸,表与索引在;
//   ③ 真值写 run_event:appendRunEvent 落库整行(payload=原事件全文),
//      文件侧不再产生 events.jsonl;
//   ④ 真值写 trace_event:appendTraceEvent 落库(自愈开账哨兵随行),
//      探针 agentId 置 synthesized=1(149 §二 判据);
//   ⑤ 冲突语义(H3):身份撞号 throw → 入 record_rejected 不丢弃;trace 身份键 =
//      (sessionKey, seq)(文件账退役批,同 seq 再发行 = 双写者显形);
//   ⑥ 失败纪律分层:DB 不可用时 run_event(事实账)严格 reject;trace_event
//      (证据账)同样 reject、由 evidence-bridge 吞掉——证据面弱于执行面。
//
// Run: node --test tests/record-plane.test.js


import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeRecordDatabasesForTests,
  openDatabase,
  resolveRecordDbPath,
} from "../lib/record-plane/database.js";
import {
  clearRecordWriterStateForTests,
  isSynthesizedRecord,
  shadowRunEvent,
  shadowTraceEvent,
} from "../lib/record-plane/record-writer.js";
import {
  RUN_EVENT_TYPES,
  appendRunEvent,
  flushRunEvents,
} from "../lib/archive/run-event-recorder.js";
import { runDirFor } from "../lib/archive/thread-tree-store.js";
import { appendTraceEvent } from "../lib/evidence/session-trace-store.js";
import { buildTraceEvent } from "../lib/evidence/trace-event-schema.js";
import { tryReadRunEventsFromDb, tryReadTraceEventsFromDb } from "../lib/record-plane/record-reader.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";

const PRODUCTION_DB_PATH = join(CONTROL_PLANE_PATHS.root, "records.db");

function allRows(db, sql, ...args) {
  return db.prepare(sql).all(...args);
}

// ── ① 种子隔离守卫 ────────────────────────────────────────────────────────────

test("guard: record DB path resolves away from production under node --test (店根门卫 §13)", () => {
  // 门卫三级:显式种子(若设)优先,否则测试进程沙箱;两者都绝不落生产库。
  const resolved = resolveRecordDbPath();
  if (process.env.OPENCLAW_RECORD_DB) assert.equal(resolved, process.env.OPENCLAW_RECORD_DB);
  assert.notEqual(resolved, PRODUCTION_DB_PATH);
});

test("guard: opening the production records.db under node --test throws", () => {
  // 店根门卫(§13)下默认解析在测试进程恒落沙箱;能到生产库的只剩显式传路——账店 fail-loud 门照拦。
  assert.throws(() => openDatabase(PRODUCTION_DB_PATH), /refusing to open production records\.db/);
});

// ── ② schema 幂等 ────────────────────────────────────────────────────────────

test("schema is idempotent across reconnect", () => {
  const dir = mkdtempSync(join(tmpdir(), "record-plane-schema-"));
  const dbPath = join(dir, "records.db");
  openDatabase(dbPath);
  closeRecordDatabasesForTests();
  const db = openDatabase(dbPath); // 重开连接重跑 schema.sql,不得炸
  const tables = allRows(db, "SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
    .map((row) => row.name);
  assert.ok(tables.includes("records"));
  assert.ok(tables.includes("record_rejected"));
  assert.ok(tables.includes("uq_records_trace_seq")); // 文件账退役批:身份键 = (sessionKey, seq)
  assert.ok(tables.includes("uq_records_run_identity"));
});

// ── ③ run_event 真值写:records DB 有整行,文件侧不再产生账 ────────────────────

test("appendRunEvent lands in records(kind='run_event') only — no events.jsonl on disk", async () => {
  const lineage = { threadId: "t-recplane-run", runId: "r-recplane-run" };
  const { seq } = await appendRunEvent({
    lineage,
    type: RUN_EVENT_TYPES.RUN_TRIGGERED,
    contractId: "TC-RECPLANE-RUN",
    payload: { origin: "record-plane-test" },
  });
  await flushRunEvents(lineage);

  assert.equal(existsSync(join(runDirFor(lineage), "events.jsonl")), false, "文件账已退役,不再写 events.jsonl");

  const db = openDatabase();
  const rows = allRows(db, "SELECT * FROM records WHERE kind = 'run_event' AND runId = ?", lineage.runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].threadId, lineage.threadId);
  assert.equal(rows[0].seq, seq);
  assert.equal(rows[0].type, RUN_EVENT_TYPES.RUN_TRIGGERED);
  assert.equal(rows[0].contractId, "TC-RECPLANE-RUN");
  assert.equal(rows[0].synthesized, 0);
  assert.ok(rows[0].bootId, "阶段2 起 bootId 由写入进程填充");
  assert.equal(rows[0].gseq, null); // gseq ≡ id 派生,列不填(见 schema.sql 头注)
  const parsed = JSON.parse(rows[0].payload);
  assert.equal(parsed.seq, seq);
  assert.deepEqual(parsed.payload, { origin: "record-plane-test" }); // payload 全文 = 原事件
});

// ── ④ trace_event 真值写 + synthesized 判据 ──────────────────────────────────

test("double write: appendTraceEvent lands in jsonl and records(kind='trace_event') with hash", async () => {
  const sessionKey = "agent:worker:recplane-trace";
  const entry = await appendTraceEvent(sessionKey, buildTraceEvent({
    kind: "internal",
    channel: "fc",
    name: "read",
    outcome: "ok",
    agentId: "worker",
    sessionKey,
  }));

  const rows = tryReadTraceEventsFromDb(sessionKey);
  assert.notEqual(rows, null);
  // 自愈开账(appendTraceEvent 首条非 open 时补 session_open)+ 本条 = 2 行
  assert.equal(rows.length, 2);
  const mine = rows.find((row) => row.name === "read");
  assert.ok(mine, "本条要在正账");
  assert.equal(mine.seq, entry.seq);
  const sentinel = rows.find((row) => row.kind === "session_open");
  assert.ok(sentinel, "open sentinel row must exist");
});

test("synthesized: probe-pattern agentId/sessionKey and explicit flag both mark synthesized=1", async () => {
  assert.equal(isSynthesizedRecord({ agentId: "worker-proto-probe-1724" }), true);
  assert.equal(isSynthesizedRecord({ sessionKey: "agent:planner-proto-tail-9:c" }), true);
  assert.equal(isSynthesizedRecord({ synthesized: true }), true);
  assert.equal(isSynthesizedRecord({ agentId: "worker" }), false);

  const sessionKey = "agent:worker:recplane-synth";
  const entry = await appendTraceEvent(sessionKey, buildTraceEvent({
    kind: "internal",
    channel: "fc",
    name: "read",
    outcome: "ok",
    agentId: "worker-proto-probe-1724",
    sessionKey,
  }));
  const db = openDatabase();
  const shadow = allRows(db, "SELECT * FROM records WHERE kind = 'trace_event' AND sessionKey = ? AND seq = ?", sessionKey, entry.seq)[0];
  assert.equal(shadow.synthesized, 1);
});

// ── ⑤ 冲突语义(H3) ───────────────────────────────────────────────────────────

test("conflict: trace same (sessionKey, seq) is a second writer, rejected loudly", () => {
  const base = {
    seq: 3, ts: Date.now(), sessionKey: "agent:worker:recplane-replay",
    kind: "internal", name: "read", hash: "hash-replay-1", prevHash: "hash-replay-0",
  };
  shadowTraceEvent(base);
  shadowTraceEvent({ ...base, hash: "hash-replay-2", prevHash: "hash-replay-1" }); // 同 seq 再发行 = 双写者
  const db = openDatabase();
  const rows = allRows(db, "SELECT * FROM records WHERE kind = 'trace_event' AND sessionKey = ?", base.sessionKey);
  assert.equal(rows.length, 1); // 首条留存
  assert.equal(rows[0].hash, "hash-replay-1");
  // 第二发行撞 uq_records_trace_seq → 入 record_rejected,不静默吞(D-H fork 形态显形)
  const rejected = allRows(db, "SELECT * FROM record_rejected WHERE line LIKE ?", "%hash-replay-2%");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /UNIQUE constraint failed/);
});

test("conflict: run_event same (runId, seq) with different content throws into record_rejected", () => {
  const base = { seq: 1, ts: Date.now(), threadId: "t-recplane-conflict", runId: "r-recplane-conflict" };
  shadowRunEvent({ ...base, type: "run_triggered" });
  shadowRunEvent({ ...base, type: "closed" }); // 撞身份键 = bug,不得静默吞
  const db = openDatabase();
  const rows = allRows(db, "SELECT * FROM records WHERE kind = 'run_event' AND runId = ?", base.runId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "run_triggered"); // 首条留存
  const rejected = allRows(db, "SELECT * FROM record_rejected WHERE source = 'run-event-recorder'");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /UNIQUE constraint failed/);
  assert.match(rejected[0].line, /"closed"/); // 原行全文入表不丢弃
});

// ── ⑥ 失败纪律(文件账退役批):DB 是真值,两类账分层 ──────────────────────────
//   run_event(事实账)—— DB 不可用 → appendRunEvent reject(严格,无降级);
//   trace_event(证据账)—— DB 不可用 → appendTraceEvent reject(调用方/
//     evidence-bridge 按纪律吞掉,证据面弱于执行面)。

test("db failure: run_event rejects strictly; trace_event rejects (bridge swallows)", async () => {
  const seeded = process.env.OPENCLAW_RECORD_DB;
  const dir = mkdtempSync(join(tmpdir(), "record-plane-broken-"));
  writeFileSync(join(dir, "not-a-dir"), "x"); // 占住路径,让 mkdir 递归必炸
  process.env.OPENCLAW_RECORD_DB = join(dir, "not-a-dir", "records.db");
  clearRecordWriterStateForTests();
  closeRecordDatabasesForTests();
  try {
    const lineage = { threadId: "t-recplane-broken", runId: "r-recplane-broken" };
    await assert.rejects(
      appendRunEvent({ lineage, type: RUN_EVENT_TYPES.RUN_TRIGGERED }),
      /records\.db|EEXIST|not-a-dir|refusing/i,
      "事实账无降级:DB 打不开必须 reject",
    );
    const sessionKey = "agent:worker:recplane-broken";
    await assert.rejects(
      appendTraceEvent(sessionKey, buildTraceEvent({
        kind: "internal", channel: "fc", name: "read", outcome: "ok",
        agentId: "worker", sessionKey,
      })),
      /records\.db|EEXIST|not-a-dir|refusing/i,
      "证据账不造假续接:DB 打不开同样 reject(由 bridge 吞)",
    );
  } finally {
    if (seeded === undefined) delete process.env.OPENCLAW_RECORD_DB; // 守恒恢复:undefined 写回会变字符串 "undefined"(cwd 脏库根因)
    else process.env.OPENCLAW_RECORD_DB = seeded;
    clearRecordWriterStateForTests();
    closeRecordDatabasesForTests();
  }
});
