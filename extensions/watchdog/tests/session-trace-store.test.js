// Tests: lib/evidence/session-trace-store.js — 证据账(records DB trace_event 行)唯一写者。
// 文件账退役批:哈希链/链尖断言随文件层退役,fork 防线 = (sessionKey,seq) 唯一索引。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "session-trace-test-"));
process.env.OPENCLAW_RECORD_DB = join(SANDBOX, "records.db");

import {
  openSessionTrace, appendTraceEvent, closeSessionTrace,
  validateSessionTraceContent, clearSessionTraceMemory,
} from "../lib/evidence/session-trace-store.js";
import { buildTraceEvent } from "../lib/evidence/trace-event-schema.js";
import { openDatabase } from "../lib/record-plane/database.js";
import { tryReadTraceEventsFromDb } from "../lib/record-plane/record-reader.js";
import { writeTraceEvent } from "../lib/record-plane/record-writer.js";

test.afterEach(() => { clearSessionTraceMemory(); });

function dbRows(sessionKey) {
  const rows = tryReadTraceEventsFromDb(sessionKey);
  assert.notEqual(rows, null, "沙箱 records DB 必须可读");
  return rows;
}

test("open → append → close produces a contiguous seq-run episode", async () => {
  const sessionKey = "agent:worker:c:TC-9";
  await openSessionTrace(sessionKey, { agentId: "worker", contractId: "TC-9" });
  await appendTraceEvent(sessionKey, buildTraceEvent({
    kind: "internal", channel: "fc", name: "write",
    argsDigest: { path: "/tmp/x" }, outcome: "ok",
    agentId: "worker", sessionKey,
  }));
  await closeSessionTrace(sessionKey, { success: true });

  const records = dbRows(sessionKey);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.seq), [0, 1, 2]);
  assert.equal(records[0].kind, "session_open");
  assert.equal(records[2].kind, "session_close");
  assert.equal(records[2].eventCount, 3);
  assert.ok(!("hash" in records[1]), "哈希链已随文件层退役,新行不带 hash");

  const verdict = validateSessionTraceContent(records);
  assert.equal(verdict.complete, true);
});

test("concurrent appends stay seq-contiguous (parallel tool calls)", async () => {
  const sessionKey = "agent:worker:c:TC-11";
  await openSessionTrace(sessionKey, { agentId: "worker" });
  await Promise.all([1, 2, 3, 4, 5].map((n) => appendTraceEvent(sessionKey, buildTraceEvent({
    kind: "internal", channel: "fc", name: "read",
    argsDigest: { path: `/tmp/f${n}` }, outcome: "ok",
    agentId: "worker", sessionKey,
  }))));
  await closeSessionTrace(sessionKey, { success: true });

  const verdict = validateSessionTraceContent(dbRows(sessionKey));
  assert.equal(verdict.complete, true, `expected complete, got: ${verdict.reason}`);
  assert.deepEqual(verdict.records.map((r) => r.seq), [0, 1, 2, 3, 4, 5, 6]);
});

test("missing close sentinel → incomplete; seq gap records → incomplete", async () => {
  const sessionKey = "agent:worker:c:TC-10";
  await openSessionTrace(sessionKey, { agentId: "worker" });
  // 只开账未关:缺 close 哨兵
  const openOnly = validateSessionTraceContent(dbRows(sessionKey));
  assert.equal(openOnly.complete, false);
  assert.match(openOnly.reason, /missing close sentinel/);

  // 序列断档(合成记录数组直接喂判定器)
  const gapped = validateSessionTraceContent([
    { seq: 0, kind: "session_open" },
    { seq: 2, kind: "internal", name: "read" },
  ]);
  assert.equal(gapped.complete, false);
  assert.match(gapped.reason, /seq gap/);
});

test("第二个写者(同 session 同 seq 再发行)→ 唯一索引当场拒 + 报警 + 入 record_rejected", async () => {
  const sessionKey = "agent:worker:c:TC-fork";
  const alarms = [];
  const originalError = console.error;
  console.error = (msg) => alarms.push(String(msg));
  try {
    await openSessionTrace(sessionKey, { agentId: "worker", contractId: "TC-fork" });
    // 模拟第二个写者:绕过 store 直接往库插同一 session 的下一 seq 行(D-H fork 形态)。
    // rogue 行先插成功;store 的内存 seq 不知道它,随后发行的合法行撞 (sessionKey,seq)
    // 唯一索引 → 报警 + 入 record_rejected。语义 = 双写者从不静默交错:后到者显形。
    writeTraceEvent({
      seq: 1, traceVersion: 1, kind: "internal", name: "forged",
      sessionKey, agentId: "rogue", ts: Date.now(),
    });

    const entry = await appendTraceEvent(sessionKey, buildTraceEvent({
      kind: "internal", channel: "fc", name: "edit", outcome: "ok",
      agentId: "worker", sessionKey,
    }));

    assert.equal(entry.seq, 1, "store 内存 seq 推进不受 rogue 行影响");
    assert.ok(alarms.some((m) => m.includes("trace_event write rejected")), "撞唯一索引必须当场报警");
    const db = openDatabase();
    const rejected = db.prepare(
      "SELECT * FROM record_rejected WHERE line LIKE ?",
    ).all(`%${sessionKey}%`);
    assert.equal(rejected.length, 1, "被拒行入 record_rejected,不静默吞");
    // 正账:open(seq 0) + 先插成功的 rogue(seq 1);合法 edit 行在隔离账
    const rows = dbRows(sessionKey);
    assert.deepEqual(rows.map((r) => r.seq), [0, 1]);
    assert.equal(rows[1].name, "forged");
  } finally {
    console.error = originalError;
  }
});

test("crash 恢复:首触从 DB MAX(seq) 重建,续号不重", async () => {
  const sessionKey = "agent:worker:c:TC-resume";
  // 上一"进程"的遗产:直接落 0..1 两行
  writeTraceEvent({ seq: 0, kind: "session_open", sessionKey, agentId: "worker", ts: 1 });
  writeTraceEvent({ seq: 1, kind: "internal", name: "read", sessionKey, agentId: "worker", ts: 2 });

  const entry = await appendTraceEvent(sessionKey, buildTraceEvent({
    kind: "internal", channel: "fc", name: "write", outcome: "ok",
    agentId: "worker", sessionKey,
  }));
  assert.equal(entry.seq, 2, "重建自 DB maxSeq=1 → 下一 seq 2");
});
