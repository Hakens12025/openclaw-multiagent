// Tests: lib/archive/run-projections.js — 投影编译器(备忘录142 §八/§十二/§十四,批②)。
//
// 锁五件事:
//   ① run.json 形状:触发快照 + 终态汇总 + 合约汇总 + externalMounts:[] 字段位(§十一钩④);
//   ② participants/agents.json 花名册 + turn-{seq04}.json 回合文件形状(§十四:
//      seq 入名、事件只存指针、assemblyRef 指针位);
//   ③ thread.json:run 清单 + 续接谱系槽位(origin/continuedFrom 取最早 run 触发载荷);
//   ④ 投影可 rm 后重编且字节幂等(编译是事件账的确定性纯函数,输出零墙钟);
//   ⑤ compileRunProjectionsIfDirty 三档:干净且在 → 不编;标脏 → 编;投影缺失 → 编。
//
// 事件账走真 recorder 落账(append-only + group commit),目录经环境种子进临时根。
//
// Run: node --test tests/run-projections.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 防污染:一切 IO 前种进临时目录(事件账真值在 records DB,必须一并种)
const SANDBOX = mkdtempSync(join(tmpdir(), "run-projections-test-"));
process.env.OPENCLAW_THREADS_DIR = join(SANDBOX, "threads");
process.env.OPENCLAW_CONTRACT_INDEX_FILE = join(SANDBOX, "contract-index.jsonl");
process.env.OPENCLAW_RECORD_DB = join(SANDBOX, "records.db");

import {
  compileRunProjections,
  compileRunProjectionsIfDirty,
  markRunProjectionDirty,
} from "../lib/archive/run-projections.js";
import { RUN_EVENT_TYPES, appendRunEvent } from "../lib/archive/run-event-recorder.js";
import { runDirFor, threadDirFor } from "../lib/archive/thread-tree-store.js";

// 一条完整生命周期 run(§八事件族全走一遍),回合 turn_started 落在 seq 5。
async function seedLifecycleRun(lineage, { contractId = "TC-proj-1", agentId = "worker-a" } = {}) {
  const { runId } = lineage;
  await appendRunEvent({
    lineage,
    type: RUN_EVENT_TYPES.RUN_TRIGGERED,
    payload: { origin: "qq", continuedFrom: null },
  }); // 1
  await appendRunEvent({
    lineage, type: RUN_EVENT_TYPES.CONTRACT_CREATED, contractId,
    causeRefs: [{ runId, seq: 1 }],
  }); // 2
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.DISPATCHED, contractId, agentId }); // 3
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.CLAIMED, contractId, agentId, sessionKey: "sess-1" }); // 4
  await appendRunEvent({
    lineage, type: RUN_EVENT_TYPES.TURN_STARTED, contractId, agentId, sessionKey: "sess-1",
    causeRefs: [{ runId, seq: 4 }],
  }); // 5
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.DECLARED, contractId, agentId, sessionKey: "sess-1" }); // 6
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.COLLECTED, contractId, agentId, sessionKey: "sess-1" }); // 7
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.CLOSED, contractId, agentId }); // 8
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.TICKET_WRITTEN, contractId }); // 9
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.DELIVERED, contractId }); // 10
  await appendRunEvent({ lineage, type: RUN_EVENT_TYPES.RUN_CLOSED, payload: { outcome: "completed" } }); // 11
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("run.json:触发快照/终态汇总/合约汇总/externalMounts 字段位(§十一钩④)", async () => {
  const lineage = { threadId: "t-run", runId: "r-1-run" };
  await seedLifecycleRun(lineage);
  await compileRunProjections(lineage);

  const runJson = await readJson(join(runDirFor(lineage), "run.json"));
  assert.equal(runJson.projectionVersion, 1);
  assert.equal(runJson.threadId, "t-run");
  assert.equal(runJson.runId, "r-1-run");
  assert.equal(runJson.trigger.seq, 1);
  assert.deepEqual(runJson.trigger.payload, { origin: "qq", continuedFrom: null });
  assert.equal(runJson.closed, true);
  assert.equal(runJson.closedSummary.seq, 11);
  assert.deepEqual(runJson.closedSummary.payload, { outcome: "completed" });
  assert.deepEqual(runJson.contracts, {
    created: ["TC-proj-1"],
    closed: ["TC-proj-1"],
    open: [],
  });
  assert.equal(runJson.eventCount, 11);
  assert.equal(runJson.projectedThroughSeq, 11);
  assert.ok(Number.isFinite(runJson.firstTs));
  assert.ok(Number.isFinite(runJson.lastTs));
  assert.deepEqual(runJson.externalMounts, []); // §十一钩④:字段位恒在恒空
});

test("agents.json 花名册 + turn-{seq04}.json 回合文件形状(§十四)", async () => {
  const lineage = { threadId: "t-part", runId: "r-1-part" };
  await seedLifecycleRun(lineage);
  await compileRunProjections(lineage);

  const participantsDir = join(runDirFor(lineage), "participants");
  const roster = await readJson(join(participantsDir, "agents.json"));
  assert.equal(roster.projectionVersion, 1);
  assert.equal(roster.agents.length, 1);
  assert.deepEqual(roster.agents[0], {
    agentId: "worker-a",
    firstSeq: 3, // dispatched 是该 agent 首个具名事件
    lastSeq: 8, // closed 是最后一个
    turnCount: 1,
    contractIds: ["TC-proj-1"],
  });

  // §十四:回合降格为文件,seq 入名(recorder 单写者,铸名安全)
  const turn = await readJson(join(participantsDir, "worker-a", "turn-0005.json"));
  assert.equal(turn.projectionVersion, 1);
  assert.equal(turn.agentId, "worker-a");
  assert.equal(turn.seq, 5);
  assert.equal(turn.sessionKey, "sess-1");
  assert.equal(turn.contractId, "TC-proj-1");
  assert.deepEqual(turn.causeRefs, [{ runId: "r-1-part", seq: 4 }]);
  assert.equal(turn.assemblyRef, null); // assembly/{hash}.txt 指针位,本批恒 null
  // 回合事件只存指针 {seq,type,contractId?},不复制载荷
  assert.deepEqual(turn.events.map((event) => [event.seq, event.type]), [
    [5, "turn_started"],
    [6, "declared"],
    [7, "collected"],
    [8, "closed"],
  ]);
  for (const pointer of turn.events) {
    assert.deepEqual(Object.keys(pointer).sort(), ["contractId", "seq", "type"]);
  }
});

test("thread.json:run 清单 + 续接谱系槽位(§三)", async () => {
  const lineage = { threadId: "t-thread", runId: "r-1-thread" };
  await seedLifecycleRun(lineage);
  await compileRunProjections(lineage);

  const threadJson = await readJson(join(threadDirFor(lineage), "thread.json"));
  assert.equal(threadJson.projectionVersion, 1);
  assert.equal(threadJson.threadId, "t-thread");
  assert.equal(threadJson.origin, "qq"); // 最早 run 触发载荷的来源
  assert.equal(threadJson.continuedFrom, null);
  assert.deepEqual(threadJson.runs, [
    { runId: "r-1-thread", closed: true, projectedThroughSeq: 11 },
  ]);
});

test("多 run 同线:thread.json 汇总全部 run(目录名排序)", async () => {
  const threadId = "t-multi";
  const lineageA = { threadId, runId: "r-100-aa" };
  const lineageB = { threadId, runId: "r-200-bb" };
  await seedLifecycleRun(lineageA, { contractId: "TC-m-1" });
  await compileRunProjections(lineageA);
  await seedLifecycleRun(lineageB, { contractId: "TC-m-2" });
  await compileRunProjections(lineageB);

  const threadJson = await readJson(join(threadDirFor(lineageA), "thread.json"));
  assert.deepEqual(threadJson.runs, [
    { runId: "r-100-aa", closed: true, projectedThroughSeq: 11 },
    { runId: "r-200-bb", closed: true, projectedThroughSeq: 11 },
  ]);
});

test("投影 rm 后重编字节幂等(真值唯事件账,编译是确定性纯函数)", async () => {
  const lineage = { threadId: "t-idem", runId: "r-1-idem" };
  await seedLifecycleRun(lineage);
  await compileRunProjections(lineage);

  const runDir = runDirFor(lineage);
  const projectionFiles = [
    join(runDir, "run.json"),
    join(runDir, "participants", "agents.json"),
    join(runDir, "participants", "worker-a", "turn-0005.json"),
    join(threadDirFor(lineage), "thread.json"),
  ];
  const before = new Map();
  for (const filePath of projectionFiles) {
    before.set(filePath, await readFile(filePath, "utf8"));
  }

  for (const filePath of projectionFiles) {
    await rm(filePath);
  }
  await compileRunProjections(lineage);

  for (const filePath of projectionFiles) {
    assert.equal(await readFile(filePath, "utf8"), before.get(filePath), `重编不幂等: ${filePath}`);
  }
});

test("compileRunProjectionsIfDirty 三档:干净不编/标脏必编/缺投影必编", async () => {
  const lineage = { threadId: "t-dirty", runId: "r-1-dirty" };
  await seedLifecycleRun(lineage); // run_closed 已触发 recorder 侧必编 + 清脏

  const clean = await compileRunProjectionsIfDirty(lineage);
  assert.equal(clean.compiled, false);

  markRunProjectionDirty(lineage);
  const afterDirty = await compileRunProjectionsIfDirty(lineage);
  assert.equal(afterDirty.compiled, true);

  await rm(join(runDirFor(lineage), "run.json"));
  const afterMissing = await compileRunProjectionsIfDirty(lineage);
  assert.equal(afterMissing.compiled, true);
  const restored = await readJson(join(runDirFor(lineage), "run.json"));
  assert.equal(restored.closed, true);
});
