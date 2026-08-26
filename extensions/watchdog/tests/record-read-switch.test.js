// tests/record-read-switch.test.js — 读面终态(文件账退役批):records DB 是唯一读源。
//
// 锁五件事:
//   ① 双写期一致性:同一组事件经 appendRunEvent/appendTraceEvent 落账,
//      run-join 从 DB 读出的拼接结果完整(文件侧对照,文件停写后此段改锁 DB 单源);
//   ② 无回落:DB 无行 → db 空结果 + 缺口点名;DB 整体缺席 → none 如实报缺,
//      不再回落文件(文件账已退役);
//   ③ 序:乱序到达时 DB 读按 (seq,id) 排;trace 同 (sessionKey,seq) 二次发行
//      (双写者)被唯一索引当场拒,只留首条;
//   ④ run-tree-inspect:inspect.run_events 从 DB 读,分页语义不变,source=db|none;
//   ⑤ record-reconcile:账实相符 exit 0,文件多一行 exit 1 且差异清单点名。
//
// 沙箱纪律:seed-tree-stores 首条 import;runId/sessionKey 带进程唯一后缀防跨文件撞车
// (npm test 下全部测试进程共享同一沙箱 DB 路径)。


import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { joinRunRecords } from "../lib/archive/run-join.js";
import { readRunEvents } from "../lib/archive/run-tree-inspect.js";
import { appendRunEvent, flushRunEvents } from "../lib/archive/run-event-recorder.js";
import { runDirFor } from "../lib/archive/thread-tree-store.js";
import { appendTraceEvent } from "../lib/evidence/session-trace-store.js";
import { buildTraceEvent } from "../lib/evidence/trace-event-schema.js";
import { shadowRunEvent, shadowTraceEvent, writeRunEvents } from "../lib/record-plane/record-writer.js";
import {
  closeRecordReadersForTests,
  tryReadTraceEventsFromDb,
} from "../lib/record-plane/record-reader.js";

const UNIQ = `${process.pid}-${Date.now()}`;
const AGENT = "readswitch-probe-agent";

// ── ① 单源:真值写面落库,DB 读法拼出完整视图 ─────────────────────────────────

test("run-join:真值写面落库,事件与证据从 DB 读出拼成完整视图", async () => {
  const lineage = { threadId: `t-rswitch-${UNIQ}`, runId: `r-rswitch-${UNIQ}` };
  const contractId = `TC-RSWITCH-${UNIQ}`;
  const sessionKey = `agent:${AGENT}:contract:${contractId.toLowerCase()}`;

  await appendRunEvent({ lineage, type: "run_triggered", contractId, payload: { origin: "read-switch" } });
  await appendRunEvent({ lineage, type: "contract_created", contractId, agentId: AGENT, sessionKey });
  await appendRunEvent({
    lineage, type: "collected", contractId, agentId: AGENT, sessionKey,
    causeRefs: [{ runId: lineage.runId, seq: 2 }],
  });
  await flushRunEvents(lineage);
  await appendTraceEvent(sessionKey, buildTraceEvent({
    kind: "internal", channel: "fc", name: "read", outcome: "ok",
    agentId: AGENT, sessionKey, contractId,
    args: { path: "inbox/contract.json" },
  }));
  await appendTraceEvent(sessionKey, buildTraceEvent({
    kind: "internal", channel: "fc", name: "write", outcome: "ok",
    agentId: AGENT, sessionKey, contractId,
    args: { path: "outbox/report.md" },
  }));

  const joined = joinRunRecords(lineage);
  assert.equal(joined.recordSource.events, "db", "事件账唯一来源 = records DB");
  assert.equal(joined.recordSource.traces, "db", "证据账唯一来源 = records DB");

  assert.equal(joined.events.length, 3);
  assert.deepEqual(joined.events.map((e) => e.seq), [1, 2, 3], "事件按 seq 升序");

  const trace = joined.traces[0];
  assert.equal(joined.traces.length, 1);
  assert.equal(trace.source, "db");
  assert.equal(trace.file, null, "DB 读法无文件路径");
  const dbTrace = tryReadTraceEventsFromDb(sessionKey);
  assert.notEqual(dbTrace, null);
  assert.deepEqual(trace.calls, dbTrace, "拼接的证据腿 = DB 该会话全量(session_open 哨兵也算)");

  // 时间线条目数 = 事件 + 证据,跨店 ts 近似轴不变
  assert.equal(joined.timeline.length, joined.events.length + dbTrace.length);
  assert.equal(joined.stats.toolCalls, 2, "session_open 哨兵不算工具调用");
});

// ── ② 无回落:DB 缺席/无行时如实报缺,不再回落文件(文件账已退役) ───────────────

test("run-join:DB 无行 → source=db 空结果 + 缺口点名(不回落文件)", async () => {
  const stamp = `${UNIQ}-hole`;
  const lineage = { threadId: `t-${stamp}`, runId: `r-${stamp}` };
  const sessionKey = `agent:${AGENT}:contract:tc-hole-${process.pid}`;
  mkdirSync(runDirFor(lineage), { recursive: true });

  const joined = joinRunRecords(lineage);
  assert.equal(joined.recordSource.events, "db", "库可查无行 → db 空结果");
  assert.deepEqual(joined.events, []);
  assert.ok(joined.gaps.some((g) => g.what === "run_event"), "事件账缺口要点名");
  assert.ok(joined.stats.toolCalls === 0);
  void sessionKey;
});

test("run-join:DB 文件整体缺席 → source=none 如实报缺", async () => {
  const stamp = `${UNIQ}-nodb`;
  const lineage = { threadId: `t-${stamp}`, runId: `r-${stamp}` };
  mkdirSync(runDirFor(lineage), { recursive: true });

  const seeded = process.env.OPENCLAW_RECORD_DB;
  process.env.OPENCLAW_RECORD_DB = join(tmpdir(), `record-read-switch-missing-${UNIQ}`, "records.db");
  closeRecordReadersForTests();
  try {
    const joined = joinRunRecords(lineage);
    assert.equal(joined.recordSource.events, "none", "DB 缺席 → none,没有可回落的东西");
    assert.deepEqual(joined.events, []);
    assert.ok(joined.gaps.some((g) => g.reason.includes("DB 缺席")), "DB 缺席要点名");
  } finally {
    if (seeded === undefined) delete process.env.OPENCLAW_RECORD_DB; // 守恒恢复:undefined 写回会变字符串 "undefined"(cwd 脏库根因)
    else process.env.OPENCLAW_RECORD_DB = seeded;
    closeRecordReadersForTests();
  }
});

// ── ③ 序:乱序到达按 (seq,id) 纠正;同 seq 二次发行被唯一索引当场拒 ──────────────

test("run-join:事件乱序到达时 DB 读按 seq 升序(到达序语义),不落 ts 排序", async () => {
  const stamp = `${UNIQ}-ooo`;
  const lineage = { threadId: `t-${stamp}`, runId: `r-${stamp}` };
  mkdirSync(runDirFor(lineage), { recursive: true });
  // 乱序:seq 2 先于 seq 1 落库
  const late = { seq: 2, ts: 1_700_000_200_000, threadId: lineage.threadId, runId: lineage.runId, type: "closed" };
  const early = { seq: 1, ts: 1_700_000_200_999, threadId: lineage.threadId, runId: lineage.runId, type: "run_triggered" };
  shadowRunEvent(late);
  shadowRunEvent(early);

  const joined = joinRunRecords(lineage);
  assert.equal(joined.recordSource.events, "db");
  assert.deepEqual(joined.events.map((e) => e.seq), [1, 2], "DB 读按 seq 升序,与插入物理序无关");
  assert.deepEqual(joined.events, [early, late]);
});

test("run-join:trace 同 (sessionKey,seq) 二次发行(双写者)被唯一索引当场拒;无 contractId 的会话合法", async () => {
  const stamp = `${UNIQ}-fork`;
  const lineage = { threadId: `t-${stamp}`, runId: `r-${stamp}` };
  const sessionKey = `agent:${AGENT}:fork-${process.pid}`; // 无 contractId 段
  mkdirSync(runDirFor(lineage), { recursive: true });
  // 事件账带上该 sessionKey(joinRunRecords 以事件账的 sessionKey 集合为证据拼接口径)
  shadowRunEvent({ seq: 1, ts: 1_700_000_300_000, threadId: lineage.threadId, runId: lineage.runId, type: "turn_started", agentId: AGENT, sessionKey });
  // 同一 session 账上 seq=5 被发行两次 = D-H 双写者形态:首条留存,第二条撞
  // uq_records_trace_seq → record_rejected 显形,不再"两行都留"
  const first = { seq: 5, ts: 1_700_000_300_010, sessionKey, agentId: AGENT, kind: "internal", channel: "fc", name: "read", outcome: "refused" };
  const second = { seq: 5, ts: 1_700_000_300_020, sessionKey, agentId: AGENT, kind: "internal", channel: "fc", name: "read", outcome: "ok" };
  shadowTraceEvent(first);
  shadowTraceEvent(second);

  const joined = joinRunRecords(lineage);
  assert.equal(joined.recordSource.traces, "db");
  const trace = joined.traces.find((t) => t.sessionKey === sessionKey);
  assert.ok(trace, "该会话的证据要拼上");
  assert.equal(trace.calls.length, 1, "同 seq 二次发行只留首条");
  assert.equal(trace.calls[0].contractId ?? null, null, "无 contractId 的会话是合法形态");
});

// ── ④ run-tree-inspect:DB 唯一来源,分页/来源字段如实 ──────────────────────────

test("run-tree-inspect:inspect.run_events 从 DB 读,分页/总数正确,source=db", async () => {
  const stamp = `${UNIQ}-tree`;
  const lineage = { threadId: `t-${stamp}`, runId: `r-${stamp}` };
  for (const type of ["run_triggered", "contract_created", "turn_started", "collected", "run_closed"]) {
    await appendRunEvent({ lineage, type });
  }
  await flushRunEvents(lineage);

  const page = await readRunEvents({ ...lineage, afterSeq: 1, limit: 2 });
  assert.equal(page.source, "db");
  assert.equal(page.totalEvents, 5);
  assert.equal(page.latestSeq, 5);
  assert.deepEqual(page.events.map((e) => e.seq), [2, 3], "afterSeq 游标语义不变");
});

test("run-tree-inspect:DB 缺席 → source=none 空结果(不回落文件)", async () => {
  const stamp = `${UNIQ}-treefile`;
  const lineage = { threadId: `t-${stamp}`, runId: `r-${stamp}` };
  mkdirSync(runDirFor(lineage), { recursive: true });

  const seeded = process.env.OPENCLAW_RECORD_DB;
  process.env.OPENCLAW_RECORD_DB = join(tmpdir(), `record-read-switch-none-${UNIQ}`, "records.db");
  closeRecordReadersForTests();
  try {
    const view = await readRunEvents({ ...lineage, limit: 10 });
    assert.equal(view.source, "none", "DB 缺席 → none");
    assert.equal(view.totalEvents, 0);
    assert.equal(view.badLines, 0);
  } finally {
    if (seeded === undefined) delete process.env.OPENCLAW_RECORD_DB; // 守恒恢复:undefined 写回会变字符串 "undefined"(cwd 脏库根因)
    else process.env.OPENCLAW_RECORD_DB = seeded;
    closeRecordReadersForTests();
  }
});

// ── ⑤ record-reconcile:体检器端到端(文件账退役批转型) ────────────────────────

const WATCHDOG_ROOT = join(import.meta.dirname, "..");

function seedReconcileFixture(fixtureRoot) {
  const dbPath = join(fixtureRoot, "records.db");
  const lineage = { threadId: "t-reconcile", runId: `r-reconcile-${UNIQ}` };
  const sessionKey = `agent:${AGENT}:reconcile-${process.pid}`;
  const gapRunId = `r-reconcile-gap-${UNIQ}`;

  // 临时改道环境种子写夹具库,写完恢复
  const seeded = process.env.OPENCLAW_RECORD_DB;
  process.env.OPENCLAW_RECORD_DB = dbPath;
  try {
    // 干净 run:seq 1..2 连续
    writeRunEvents([
      { seq: 1, ts: 1_700_000_500_000, threadId: lineage.threadId, runId: lineage.runId, type: "run_triggered" },
      { seq: 2, ts: 1_700_000_500_010, threadId: lineage.threadId, runId: lineage.runId, type: "run_closed" },
    ]);
    // 干净会话:open(seq 0) + 一条工具事件(seq 1)
    shadowTraceEvent({ seq: 0, ts: 1_700_000_500_005, sessionKey, agentId: AGENT, kind: "session_open" });
    shadowTraceEvent({ seq: 1, ts: 1_700_000_500_006, sessionKey, agentId: AGENT, kind: "internal", channel: "fc", name: "ls", outcome: "ok" });
    // 违例 run:seq 1 后直接跳 3(中洞)
    writeRunEvents([
      { seq: 1, ts: 1_700_000_500_100, threadId: lineage.threadId, runId: gapRunId, type: "run_triggered" },
      { seq: 3, ts: 1_700_000_500_110, threadId: lineage.threadId, runId: gapRunId, type: "run_closed" },
    ]);
  } finally {
    if (seeded === undefined) delete process.env.OPENCLAW_RECORD_DB; // 守恒恢复:undefined 写回会变字符串 "undefined"(cwd 脏库根因)
    else process.env.OPENCLAW_RECORD_DB = seeded;
  }
  return { dbPath, lineage, sessionKey, gapRunId };
}

function runReconcile(fixture) {
  return spawnSync(process.execPath, [join(WATCHDOG_ROOT, "scripts", "record-reconcile.js")], {
    cwd: WATCHDOG_ROOT,
    env: {
      ...process.env,
      OPENCLAW_RECORD_DB: fixture.dbPath,
    },
    encoding: "utf8",
  });
}

test("record-reconcile:健康库体检清单齐全;序断洞违例 exit 1 且点名 runId", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "record-reconcile-"));
  const fixture = seedReconcileFixture(fixtureRoot);

  const out = runReconcile(fixture);
  assert.equal(out.status, 1, "有 seq 断洞应 exit 1");
  assert.match(out.stdout, /run_event_seq_gap/, "违例类型要点名");
  assert.match(out.stdout, new RegExp(fixture.gapRunId), "违例要点名到 runId");
  assert.match(out.stdout, /应有 3 行,实有 2 行/, "洞的大小要写出来");
  assert.match(out.stdout, /record_rejected\s+0 行/, "拒收行数照报");
  assert.match(out.stdout, /gseq \[/, "全局序水位照报");

  // 因果校验段也在(夹具无 causeRefs → 0 违例)
  assert.match(out.stdout, /因果校验\s+0 违例/);
});
