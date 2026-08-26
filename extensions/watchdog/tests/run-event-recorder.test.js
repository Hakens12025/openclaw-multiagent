// Tests: lib/archive/run-event-recorder.js — run 事件账唯一写者(备忘录142 §八/§九/§十,GAP-05;
// 文件账退役批起 records DB 是唯一真值)。
//
// 锁六件事:
//   ① seq per-run 单调(1 起)、返回 {seq, ref:{runId,seq}}、行 schema 字段齐全且可选位缺省不落键;
//   ② group commit:同窗并发追加全部持久化且按 seq 有序;
//   ③ causeRefs 不变量:同 run 内 causeRefs[].seq < seq,违例 reject 且不烧号(§十施工断言);
//      畸形 ref 拒收;跨 run 引用放行(全局地址 {runId,seq});
//   ④ 类型注册表:未知名拒收,保留名单(§十一钩③ agent-group 族)注册即禁用;
//   ⑤ crash 恢复:首触从 DB MAX(seq) 重建计数(原文件坏尾行扫描语义的 DB 平移);
//   ⑥ deriveRunOpenContracts(GAP-02):created 无对应 closed 即 open;
//      run_closed 必编投影(§十二.1)。
//
// Run: node --test tests/run-event-recorder.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 防污染:一切 IO 前种进临时目录(事件账真值在 records DB,必须一并种)
const SANDBOX = mkdtempSync(join(tmpdir(), "run-event-recorder-test-"));
process.env.OPENCLAW_THREADS_DIR = join(SANDBOX, "threads");
process.env.OPENCLAW_CONTRACT_INDEX_FILE = join(SANDBOX, "contract-index.jsonl");
process.env.OPENCLAW_RECORD_DB = join(SANDBOX, "records.db");

import {
  RESERVED_RUN_EVENT_TYPES,
  RUN_EVENT_TYPES,
  appendRunEvent,
  deriveRunOpenContracts,
  flushRunEvents,
} from "../lib/archive/run-event-recorder.js";
import { runDirFor } from "../lib/archive/thread-tree-store.js";
import { tryReadRunEventsFromDb } from "../lib/record-plane/record-reader.js";
import { writeRunEvents } from "../lib/record-plane/record-writer.js";
import { addSseClient, removeSseClient } from "../lib/transport/sse.js";

async function readParsedLines(lineage) {
  const rows = tryReadRunEventsFromDb(lineage.runId);
  assert.notEqual(rows, null, "沙箱 records DB 必须可读");
  return rows;
}

test("seq per-run 单调,返回 {seq, ref},行 schema 齐全且可选位缺省不落键", async () => {
  const lineage = { threadId: "t-seq", runId: "r-1-seq" };
  const first = await appendRunEvent({
    lineage,
    type: RUN_EVENT_TYPES.RUN_TRIGGERED,
    payload: { origin: "test" },
  });
  assert.deepEqual(first, { seq: 1, ref: { runId: "r-1-seq", seq: 1 } });

  const second = await appendRunEvent({
    lineage,
    type: RUN_EVENT_TYPES.CONTRACT_CREATED,
    contractId: "TC-seq-1",
    agentId: "worker-a",
    sessionKey: "sess-1",
  });
  assert.equal(second.seq, 2);

  const third = await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.CLAIMED, contractId: "TC-seq-1" });
  assert.equal(third.seq, 3);

  const lines = await readParsedLines(lineage);
  assert.deepEqual(lines.map((line) => line.seq), [1, 2, 3]);
  for (const line of lines) {
    assert.equal(line.threadId, "t-seq");
    assert.equal(line.runId, "r-1-seq");
    assert.ok(Number.isFinite(line.ts));
  }
  assert.equal(lines[0].type, "run_triggered");
  assert.deepEqual(lines[0].payload, { origin: "test" });
  assert.ok(!("contractId" in lines[0])); // 可选位缺省不落键
  assert.ok(!("causeRefs" in lines[0]));
  assert.equal(lines[1].contractId, "TC-seq-1");
  assert.equal(lines[1].agentId, "worker-a");
  assert.equal(lines[1].sessionKey, "sess-1");
  assert.ok(!("payload" in lines[2]));
});

test("per-run 计数独立:两条 run 各自从 1 起", async () => {
  const lineageA = { threadId: "t-iso", runId: "r-1-aa" };
  const lineageB = { threadId: "t-iso", runId: "r-2-bb" };
  const a = await appendRunEvent({ lineage: lineageA, type: RUN_EVENT_TYPES.RUN_TRIGGERED });
  const b = await appendRunEvent({ lineage: lineageB, type: RUN_EVENT_TYPES.RUN_TRIGGERED });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 1);
});

test("group commit(GAP-05):同窗并发追加全部持久化,按 seq 有序", async () => {
  const lineage = { threadId: "t-batch", runId: "r-1-batch" };
  const results = await Promise.all([
    appendRunEvent({ lineage, type: RUN_EVENT_TYPES.RUN_TRIGGERED }),
    appendRunEvent({ lineage, type: RUN_EVENT_TYPES.CONTRACT_CREATED, contractId: "TC-b-1" }),
    appendRunEvent({ lineage, type: RUN_EVENT_TYPES.DISPATCHED, contractId: "TC-b-1" }),
    appendRunEvent({ lineage, type: RUN_EVENT_TYPES.CLAIMED, contractId: "TC-b-1" }),
    appendRunEvent({ lineage, type: RUN_EVENT_TYPES.TURN_STARTED, contractId: "TC-b-1", agentId: "worker-a" }),
  ]);
  assert.deepEqual(results.map((result) => result.seq), [1, 2, 3, 4, 5]);
  const lines = await readParsedLines(lineage);
  assert.deepEqual(lines.map((line) => line.seq), [1, 2, 3, 4, 5]);
});

test("causeRefs 不变量(§十):同 run 前序引用放行,违例 reject 且不烧号,畸形拒收,跨 run 放行", async () => {
  const lineage = { threadId: "t-cause", runId: "r-1-cause" };
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.RUN_TRIGGERED }); // seq 1

  const withRefs = await appendRunEvent({
    lineage,
    type: RUN_EVENT_TYPES.CONTRACT_CREATED,
    contractId: "TC-c-1",
    causeRefs: [{ runId: "r-1-cause", seq: 1 }],
  }); // seq 2
  assert.equal(withRefs.seq, 2);

  // 违例:同 run 引用未来 seq —— 这是 bug,reject 不落账
  await assert.rejects(
    appendRunEvent({
      lineage,
      type: RUN_EVENT_TYPES.DISPATCHED,
      causeRefs: [{ runId: "r-1-cause", seq: 99 }],
    }),
    /violates causal order/,
  );

  // 畸形 ref:缺 runId / 非数组
  await assert.rejects(
    appendRunEvent({ lineage, type: RUN_EVENT_TYPES.DISPATCHED, causeRefs: [{ seq: 1 }] }),
    /must be \{runId, seq>=1\}/,
  );
  await assert.rejects(
    appendRunEvent({ lineage, type: RUN_EVENT_TYPES.DISPATCHED, causeRefs: "seq-1" }),
    /must be an array/,
  );

  // 违例未烧号:下一个合法事件仍拿 seq 3(账上无空洞)
  const next = await appendRunEvent({
    lineage,
    type: RUN_EVENT_TYPES.DISPATCHED,
    contractId: "TC-c-1",
    causeRefs: [{ runId: "r-0-other", seq: 999 }], // 跨 run 引用:全局地址,放行
  });
  assert.equal(next.seq, 3);

  const lines = await readParsedLines(lineage);
  assert.deepEqual(lines.map((line) => line.seq), [1, 2, 3]);
  assert.deepEqual(lines[1].causeRefs, [{ runId: "r-1-cause", seq: 1 }]);
  assert.deepEqual(lines[2].causeRefs, [{ runId: "r-0-other", seq: 999 }]);
});

test("类型注册表:未知名拒收;保留名单(§十一钩③)注册即禁用;缺谱系同步抛", () => {
  const lineage = { threadId: "t-types", runId: "r-1-types" };
  assert.throws(
    () => appendRunEvent({ lineage, type: "nonsense_event" }),
    /unknown run event type/,
  );
  for (const reserved of RESERVED_RUN_EVENT_TYPES) {
    assert.throws(
      () => appendRunEvent({ lineage, type: reserved }),
      /reserved for agent-group/,
    );
  }
  assert.deepEqual(
    RESERVED_RUN_EVENT_TYPES,
    ["group_expanded", "branch_opened", "joined", "branch_cancelled"],
  );
  assert.throws(() => appendRunEvent({ type: RUN_EVENT_TYPES.CLAIMED }), /invalid lineage\.threadId/);
});

test("crash 恢复:首触从 DB MAX(seq) 重建计数,续号不重不跳", async () => {
  // 模拟"进程重启后首触":直接往 DB 落两行(上一进程的遗产),本进程未触达过该 run
  const lineage = { threadId: "t-hydrate", runId: "r-1-hydrate" };
  writeRunEvents([
    { seq: 1, ts: 1, threadId: lineage.threadId, runId: lineage.runId, type: "run_triggered" },
    { seq: 2, ts: 2, threadId: lineage.threadId, runId: lineage.runId, type: "contract_created", contractId: "TC-h-1" },
  ]);

  const appended = await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.CLAIMED, contractId: "TC-h-1" });
  assert.equal(appended.seq, 3, "重建自 DB maxSeq=2 → 下一 seq 3");

  const rows = await readParsedLines(lineage);
  assert.deepEqual(rows.map((line) => line.seq), [1, 2, 3]);
  assert.equal(rows[2].type, "claimed");
  assert.equal(rows[2].contractId, "TC-h-1");
});

test("deriveRunOpenContracts(GAP-02):created 无对应 closed 即 open", async () => {
  const lineage = { threadId: "t-open", runId: "r-1-open" };
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.RUN_TRIGGERED });
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.CONTRACT_CREATED, contractId: "TC-o-1" });
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.CONTRACT_CREATED, contractId: "TC-o-2" });
  assert.deepEqual(await deriveRunOpenContracts(lineage), ["TC-o-1", "TC-o-2"]);

  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.CLOSED, contractId: "TC-o-1" });
  assert.deepEqual(await deriveRunOpenContracts(lineage), ["TC-o-2"]);

  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.CLOSED, contractId: "TC-o-2" });
  assert.deepEqual(await deriveRunOpenContracts(lineage), []);
});

test("run_closed 必编投影(§十二.1):落账 resolve 后 run.json/thread.json 已在", async () => {
  const lineage = { threadId: "t-close", runId: "r-1-close" };
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.RUN_TRIGGERED });
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.RUN_CLOSED, payload: { outcome: "completed" } });
  await flushRunEvents(lineage);

  const runJson = JSON.parse(await readFile(join(runDirFor(lineage), "run.json"), "utf8"));
  assert.equal(runJson.closed, true);
  assert.equal(runJson.runId, "r-1-close");
  const threadJson = JSON.parse(
    await readFile(join(SANDBOX, "threads", "t-close", "thread.json"), "utf8"),
  );
  assert.equal(threadJson.threadId, "t-close");
});

test("live 推流:落账持久(flush)后每事件以 run_event 帧广播给 SSE 客户端", async () => {
  const frames = [];
  const client = { finished: false, destroyed: false, write(chunk) { frames.push(String(chunk)); } };
  addSseClient(client);
  try {
    const lineage = { threadId: "t-live", runId: "r-1-live" };
    await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.RUN_TRIGGERED, payload: { origin: "live-test" } });
    await flushRunEvents(lineage);
    const mine = frames
      .filter((frame) => frame.startsWith("event: run_event\n"))
      .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6, frame.length - 2)))
      .filter((data) => data.runId === "r-1-live");
    assert.equal(mine.length, 1);
    assert.equal(mine[0].seq, 1);
    assert.equal(mine[0].type, "run_triggered");
    assert.equal(mine[0].threadId, "t-live");
    assert.deepEqual(mine[0].payload, { origin: "live-test" });
  } finally {
    removeSseClient(client);
  }
});
