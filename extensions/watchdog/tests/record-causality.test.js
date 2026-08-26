// Tests: lib/record-plane/ — 阶段2 余量(148 §二 2.2/2.3/2.4):
// 跨账本锚点(happened-during)+ 真因果边落库 + 因果校验器 + 老库幂等补列。
//
// 锁七件事:
//   ① 锚点落库:trace 双写时带写入时刻的 {anchorRunId, anchorSeq} ——
//      sessionKey →(账本自述的 contractId)→ 契约索引 → runId → recorder 内存水位;
//   ② 锚点跟随水位推进;条目无 contractId 时用 session 自述过的合约(记忆);
//   ③ session 无合约关联 → 锚点 NULL(宁缺不猜);
//   ④ run_event 的 causeRefs(jsonl 已有)如实落库;
//   ⑤ 校验器抓"引用不存在的 seq"(missing_ref)与"同 run 方向反了"(seq_order),
//      干净账零违例;
//   ⑥ 老库幂等补列:旧 schema 库 openDatabase 两次不炸且列齐;
//   ⑦ 对账器输出末尾含因果校验行,违例点名且退出码 1。
//
// 每个用例开私有 records 库( OPENCLAW_RECORD_DB 换路径,连接按路径分键 ),
// 互不污染也不污染 npm test 的共享库。
//
// Run: node --test tests/record-causality.test.js


import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { closeRecordDatabasesForTests, openDatabase } from "../lib/record-plane/database.js";
import { closeRecordReadersForTests } from "../lib/record-plane/record-reader.js";
import { shadowRunEvent } from "../lib/record-plane/record-writer.js";
import { validateCausality } from "../lib/record-plane/validate-causality.js";
import {
  RUN_EVENT_TYPES,
  appendRunEvent,
  getRunSeqWatermark,
} from "../lib/archive/run-event-recorder.js";
import { recordContractHome } from "../lib/archive/thread-tree-store.js";
import { appendTraceEvent } from "../lib/evidence/session-trace-store.js";

const SCRIPTS_DIR = new URL("../scripts/", import.meta.url).pathname;

// 换私有 records 库并返回路径(写入侧每次写入惰性 resolveRecordDbPath,换即生效)。
function usePrivateDb(label) {
  const dbPath = join(mkdtempSync(join(tmpdir(), `record-causality-${label}-`)), "records.db");
  process.env.OPENCLAW_RECORD_DB = dbPath;
  return dbPath;
}

function traceAnchorRows(dbPath, sessionKey) {
  const db = openDatabase(dbPath);
  return db.prepare(
    "SELECT seq, anchorRunId, anchorSeq FROM records WHERE kind = 'trace_event' AND sessionKey = ? ORDER BY id",
  ).all(sessionKey);
}

// ── ① ② 锚点落库且跟随水位;无 contractId 条目用 session 记忆 ─────────────────

test("anchor: trace shadow rows carry {anchorRunId, anchorSeq} of the owning run's watermark", async () => {
  const dbPath = usePrivateDb("anchor");
  const lineage = { threadId: "t-caus-anchor", runId: "r-caus-anchor" };
  const contractId = "c-caus-anchor";
  await recordContractHome(contractId, lineage);

  // run 水位 = 0(未触达)→ 此刻写 trace 锚点应 NULL(水位未发行,宁缺不猜)
  const sessionKey = "agent:worker:caus-anchor";
  await appendTraceEvent(sessionKey, {
    sessionKey, kind: "internal", name: "read", contractId, agentId: "worker", ts: Date.now(),
  });
  let rows = traceAnchorRows(dbPath, sessionKey);
  assert.ok(rows.length >= 2); // lazy open 哨兵 + 本体
  for (const row of rows) {
    assert.equal(row.anchorRunId, null, "no run events yet → anchor must stay NULL");
    assert.equal(row.anchorSeq, null);
  }

  // 发两个 run 事件 → 水位 2
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.RUN_TRIGGERED, contractId });
  await appendRunEvent({
    lineage, type: RUN_EVENT_TYPES.CONTRACT_CREATED, contractId,
    causeRefs: [{ runId: lineage.runId, seq: 1 }],
  });
  assert.equal(getRunSeqWatermark(lineage.runId), 2);

  // 带 contractId 的 trace 事件 → 锚点 {r-caus-anchor, 2}
  await appendTraceEvent(sessionKey, {
    sessionKey, kind: "internal", name: "write", contractId, agentId: "worker", ts: Date.now(),
  });
  // 不带 contractId 的条目 → session 记忆兜底,同锚点
  await appendTraceEvent(sessionKey, {
    sessionKey, kind: "internal", name: "read", agentId: "worker", ts: Date.now(),
  });
  rows = traceAnchorRows(dbPath, sessionKey);
  const anchored = rows.filter((row) => row.anchorRunId !== null);
  assert.equal(anchored.length, 2);
  for (const row of anchored) {
    assert.equal(row.anchorRunId, lineage.runId);
    assert.equal(row.anchorSeq, 2);
  }

  // 水位推进 → 新锚点跟随
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.DISPATCHED, contractId });
  await appendTraceEvent(sessionKey, {
    sessionKey, kind: "internal", name: "read", contractId, agentId: "worker", ts: Date.now(),
  });
  rows = traceAnchorRows(dbPath, sessionKey);
  assert.equal(rows.at(-1).anchorSeq, 3);
});

// ── ③ session 无合约关联 → 锚点 NULL ─────────────────────────────────────────

test("anchor: session without any contract association leaves anchor NULL", async () => {
  const dbPath = usePrivateDb("orphan");
  const sessionKey = "agent:worker:caus-orphan";
  await appendTraceEvent(sessionKey, {
    sessionKey, kind: "internal", name: "read", agentId: "worker", ts: Date.now(),
  });
  const rows = traceAnchorRows(dbPath, sessionKey);
  assert.ok(rows.length >= 2); // lazy open + 本体
  for (const row of rows) {
    assert.equal(row.anchorRunId, null);
    assert.equal(row.anchorSeq, null);
  }
});

// ── ④ causeRefs 落库(经 recorder 真链路 + 直接影子写) ────────────────────────

test("causeRefs: run_event shadow rows land causeRefs from the jsonl entry", async () => {
  const dbPath = usePrivateDb("causerefs");
  const lineage = { threadId: "t-caus-refs", runId: "r-caus-refs" };
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.RUN_TRIGGERED, contractId: "c-caus-refs" });
  await appendRunEvent({
    lineage, type: RUN_EVENT_TYPES.CONTRACT_CREATED, contractId: "c-caus-refs",
    causeRefs: [{ runId: lineage.runId, seq: 1 }],
  });
  const db = openDatabase(dbPath);
  const rows = db.prepare(
    "SELECT seq, causeRefs FROM records WHERE kind = 'run_event' AND runId = ? ORDER BY seq",
  ).all(lineage.runId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].causeRefs, null); // run_triggered 无前因
  assert.deepEqual(JSON.parse(rows[1].causeRefs), [{ runId: lineage.runId, seq: 1 }]);
});

// ── ⑤ 校验器:missing_ref / seq_order 被抓,干净账零违例 ──────────────────────

test("validate-causality: clean ledger reports zero violations", () => {
  const dbPath = usePrivateDb("clean");
  shadowRunEvent({ seq: 1, ts: Date.now(), threadId: "t-caus-ok", runId: "r-caus-ok", type: "run_triggered" });
  shadowRunEvent({
    seq: 2, ts: Date.now(), threadId: "t-caus-ok", runId: "r-caus-ok", type: "contract_created",
    causeRefs: [{ runId: "r-caus-ok", seq: 1 }],
  });
  const result = validateCausality(dbPath);
  assert.ok(result);
  assert.equal(result.rows, 1); // 只有 seq2 带边
  assert.equal(result.edges, 1);
  assert.deepEqual(result.violations, []);
});

test("validate-causality: catches missing_ref (referenced seq not in the ledger)", () => {
  const dbPath = usePrivateDb("missing");
  shadowRunEvent({ seq: 1, ts: Date.now(), threadId: "t-caus-miss", runId: "r-caus-miss", type: "run_triggered" });
  shadowRunEvent({
    seq: 5, ts: Date.now(), threadId: "t-caus-miss", runId: "r-caus-miss", type: "closed",
    causeRefs: [{ runId: "r-caus-miss", seq: 3 }], // seq 3 从未入帐;3 < 5 方向不违例
  });
  const result = validateCausality(dbPath);
  assert.ok(result);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].type, "missing_ref");
  assert.equal(result.violations[0].runId, "r-caus-miss");
  assert.equal(result.violations[0].seq, 5);
  assert.deepEqual(result.violations[0].causeRef, { runId: "r-caus-miss", seq: 3 });
});

test("validate-causality: catches seq_order (same-run causeRef.seq >= row seq)", () => {
  const dbPath = usePrivateDb("order");
  shadowRunEvent({
    seq: 7, ts: Date.now(), threadId: "t-caus-ord", runId: "r-caus-ord", type: "closed",
    causeRefs: [{ runId: "r-caus-ord", seq: 7 }], // 自引用:取等即违例;存在性成立(就是自己)
  });
  const result = validateCausality(dbPath);
  assert.ok(result);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].type, "seq_order");
  assert.deepEqual(result.violations[0].causeRef, { runId: "r-caus-ord", seq: 7 });
});

test("validate-causality: catches bad_ref (malformed causeRef shape)", () => {
  const dbPath = usePrivateDb("badref");
  shadowRunEvent({
    seq: 1, ts: Date.now(), threadId: "t-caus-bad", runId: "r-caus-bad", type: "closed",
    causeRefs: [{ runId: "r-caus-bad" }], // 缺 seq
  });
  const result = validateCausality(dbPath);
  assert.ok(result);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].type, "bad_ref");
});

// ── ⑥ 老库幂等补列:旧 schema 库 openDatabase 两次,不炸且列齐 ────────────────

test("migration: openDatabase on a pre-stage2 schema db adds columns idempotently", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "record-old-schema-")), "records.db");
  // 造阶段1 旧 schema(无 anchorRunId/anchorSeq/causeRefs)
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('run_event', 'trace_event')),
      threadId TEXT, runId TEXT, sessionKey TEXT, contractId TEXT,
      seq INTEGER, bootId TEXT, gseq INTEGER, ts INTEGER NOT NULL,
      hash TEXT, prevHash TEXT, type TEXT, name TEXT,
      payload TEXT NOT NULL, synthesized INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE record_rejected (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT, reason TEXT NOT NULL, line TEXT NOT NULL, ts INTEGER NOT NULL
    );
    CREATE TABLE boots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bootId TEXT UNIQUE, startedAt INTEGER NOT NULL
    );
  `);
  raw.close();

  const expected = ["anchorRunId", "anchorSeq", "causeRefs"];
  const columnNames = (db) => db.prepare("PRAGMA table_info(records)").all().map((c) => c.name);

  const first = openDatabase(dbPath); // 第一次:ALTER 真实执行
  for (const col of expected) assert.ok(columnNames(first).includes(col), `first open must add ${col}`);

  closeRecordDatabasesForTests(); // 忘掉缓存连接,逼第二次真跑 ALTER
  const second = openDatabase(dbPath); // 第二次:列已存在 → 吞 duplicate 错,不炸
  for (const col of expected) assert.ok(columnNames(second).includes(col), `second open keeps ${col}`);

  // 老行仍在,新列 NULL
  const direct = openDatabase(dbPath);
  direct.prepare(
    "INSERT INTO records (kind, runId, seq, ts, payload) VALUES ('run_event', 'r-old', 1, 1, '{}')",
  ).run();
  const row = direct.prepare("SELECT anchorRunId, anchorSeq, causeRefs FROM records WHERE runId = 'r-old'").get();
  // node:sqlite 返回 null 原型对象,逐字段比
  assert.equal(row.anchorRunId, null);
  assert.equal(row.anchorSeq, null);
  assert.equal(row.causeRefs, null);
});

// ── ⑦ 对账器:输出末尾含因果校验行,违例点名且退出码 1 ────────────────────────

function runReconcile(dbPath) {
  try {
    const stdout = execFileSync(process.execPath, [join(SCRIPTS_DIR, "record-reconcile.js")], {
      env: { ...process.env, OPENCLAW_RECORD_DB: dbPath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout || "") };
  }
}

test("reconcile: clean causality ends with 0-violation line", () => {
  const dbPath = usePrivateDb("recon-clean");
  shadowRunEvent({ seq: 1, ts: Date.now(), threadId: "t-caus-rc", runId: "r-caus-rc", type: "run_triggered" });
  shadowRunEvent({
    seq: 2, ts: Date.now(), threadId: "t-caus-rc", runId: "r-caus-rc", type: "closed",
    causeRefs: [{ runId: "r-caus-rc", seq: 1 }],
  });
  closeRecordReadersForTests(); // 前序用例的只读连接别占着同名路径(路径各异,防御式)
  const { stdout } = runReconcile(dbPath);
  // 文件侧无对应 jsonl → 对账必有差异,退出码必 1;本用例只锁因果行口径。
  assert.match(stdout, /因果校验\s+0 违例/);
});

test("reconcile: violations are named and exit code is 1", () => {
  const dbPath = usePrivateDb("recon-bad");
  shadowRunEvent({
    seq: 5, ts: Date.now(), threadId: "t-caus-rb", runId: "r-caus-rb", type: "closed",
    causeRefs: [{ runId: "r-caus-rb", seq: 3 }],
  });
  const { code, stdout } = runReconcile(dbPath);
  assert.equal(code, 1);
  assert.match(stdout, /因果校验\s+1 违例/);
  assert.match(stdout, /\[missing_ref\] r-caus-rb#5 → causeRef \{r-caus-rb, 3\}/);
});
