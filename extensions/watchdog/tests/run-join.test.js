/**
 * run-join.test.js — 三店场外拼接
 *
 * 记录面分两个店(threads 事实 / trace 证据),各按自己的维度组织,
 * (harness 判定店已随 harness 全退役删除,v226 / 2026-08-23——判定缺席点名腿同批摘除),
 * 共享两把钥匙:contractId 与 sessionKey。本模块把一个 run 的三份记录拼成一份视图,
 * 不动任何持久化路径 —— 拼得起来,才谈得上要不要物理合并。
 *
 * 这里锁三件事:
 *   ① 钥匙对得上 —— 三种 id 都能定位到 run,包括索引失效时靠目录名兜底;
 *   ② 时间线是三店并集,且店内权威序(orderKey)不被 ts 排序抹掉;
 *   ③ **缺口必须点名** —— 拼不上的地方留白而不出声,正是记录面最难查的病。
 *
 * 沙箱里造不了判定夹具 —— 所以判定侧只锁"缺席时正确点名"。这个缺种子本身是个
 * 待办(artifacts 店当初就是因为同样的原因攒了 1377 个单测垃圾目录)。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { joinRunRecords, resolveRunTarget } from "../lib/archive/run-join.js";
import {
  participantOutboxDirFor,
  recordContractHome,
  resolveThreadsRoot,
  runDirFor,
} from "../lib/archive/thread-tree-store.js";
import { writeOutboxSeal } from "../lib/archive/outbox-seal.js";
import { writeRunEvents, writeTraceEvent } from "../lib/record-plane/record-writer.js";

const AGENT = "join-probe-agent";

// 造一个有事件、有参与者、有产物封包的 run;事件/证据经真值写面落 records DB。
async function seedRun({ threadId, runId, contractId, sessionKey, withTrace }) {
  const lineage = { threadId, runId };
  const runDir = runDirFor(lineage);
  await mkdir(runDir, { recursive: true });
  await recordContractHome(contractId, lineage);

  const base = 1_700_000_000_000;
  const events = [
    { seq: 1, ts: base, threadId, runId, type: "run_triggered", contractId, payload: { origin: "test" } },
    { seq: 2, ts: base + 10, threadId, runId, type: "contract_created", contractId, agentId: AGENT, sessionKey,
      causeRefs: [{ runId, seq: 1 }] },
    { seq: 3, ts: base + 40, threadId, runId, type: "collected", contractId, agentId: AGENT, sessionKey,
      payload: { collected: true }, causeRefs: [{ runId, seq: 2 }] },
  ];
  writeRunEvents(events);
  await writeFile(join(runDir, "run.json"), JSON.stringify({ threadId, runId, closed: true }), "utf8");

  const outbox = participantOutboxDirFor(lineage, AGENT, contractId);
  await mkdir(outbox, { recursive: true });
  await writeFile(join(outbox, "report.md"), "交付物正文", "utf8");
  await writeOutboxSeal(outbox, {
    contractId, sessionKey, collectedAt: base + 40,
    primary: "report.md", files: ["report.md"], declaredStatus: "completed",
  });

  if (withTrace) {
    const traceRecords = [
      { seq: 0, kind: "session_open", sessionKey, agentId: AGENT, ts: base + 15 },
      { seq: 1, kind: "internal", channel: "fc", name: "read", args: { path: "inbox/contract.json" },
        outcome: "ok", sessionKey, agentId: AGENT, ts: base + 20 },
      { seq: 2, kind: "internal", channel: "fc", name: "write", args: { path: "outbox/report.md" },
        outcome: "ok", sessionKey, agentId: AGENT, ts: base + 30 },
    ];
    for (const record of traceRecords) writeTraceEvent(record);
  }
  return { lineage, runDir };
}

test("三店拼接:事件账 + 证据账并成一条时间线,店内权威序随行", async () => {
  const stamp = Date.now();
  const threadId = `t-join-${stamp}`;
  const runId = `r-join-${stamp}`;
  const contractId = `TC-JOIN-${stamp}`;
  const sessionKey = `agent:${AGENT}:contract:${contractId.toLowerCase()}`;
  try {
    await seedRun({ threadId, runId, contractId, sessionKey, withTrace: true });

    const joined = joinRunRecords({ threadId, runId });
    assert.equal(joined.stats.events, 3, "事件账三行");
    assert.equal(joined.stats.toolCalls, 2, "证据账两次工具调用(session_open 不算调用)");
    assert.equal(joined.stats.traceSessions, 1, "一个会话的证据记录");

    // 时间线 = 两账并集,按 ts 升序
    const stores = joined.timeline.map((e) => e.store);
    assert.ok(stores.includes("threads") && stores.includes("trace"), "两个店都进了时间线");
    const tsList = joined.timeline.map((e) => e.ts);
    assert.deepEqual(tsList, [...tsList].sort((a, b) => a - b), "时间线按 ts 升序");

    // 店内权威序必须随行 —— 跨店 ts 只是近似轴,读的人要能退回各店的真序
    for (const entry of joined.timeline) {
      assert.match(entry.orderKey, /^(seq|finalizedAt):/, `${entry.store} 条目要带店内权威序`);
    }
    // 因果边只在事件账上,拼接不得丢
    const created = joined.timeline.find((e) => e.label === "contract_created");
    assert.deepEqual(created.causeRefs, [{ runId, seq: 1 }], "causeRefs 原样透传");

    // 参与者与交付物
    assert.equal(joined.participants.length, 1);
    const [p] = joined.participants;
    assert.equal(p.agentId, AGENT);
    assert.equal(p.outboxes[0].sealed, true, "封包状态要读出来");
    assert.equal(p.outboxes[0].primary, "report.md");
    assert.deepEqual(p.outboxes[0].files, ["report.md", "seal.json"]);
    assert.equal(joined.recordSource.events, "db");
    assert.equal(joined.recordSource.traces, "db");
  } finally {
    await rm(join(resolveThreadsRoot(), threadId), { recursive: true, force: true });
  }
});

test("缺口必须点名:证据缺席、合约正本缺席都要出声", async () => {
  const stamp = Date.now() + 1;
  const threadId = `t-join-gap-${stamp}`;
  const runId = `r-join-gap-${stamp}`;
  const contractId = `TC-JOINGAP-${stamp}`;
  const sessionKey = `agent:${AGENT}:contract:${contractId.toLowerCase()}`;
  try {
    await seedRun({ threadId, runId, contractId, sessionKey, withTrace: false });

    const joined = joinRunRecords({ threadId, runId });
    const reasons = joined.gaps.map((g) => `${g.store}:${g.what}`);

    assert.ok(
      joined.gaps.some((g) => g.store === "trace" && g.what === sessionKey),
      `证据缺席要点名到具体会话,实得 ${JSON.stringify(reasons)}`,
    );
    assert.ok(
      joined.gaps.some((g) => g.store === "threads" && g.ids?.includes(contractId)),
      "事件账提过、contracts/ 里没有的合约要点名 —— 这正是被测试清理误删过的那一层",
    );
    // 缺口不该拖垮其余:参与者与产物照常拼出来
    assert.equal(joined.participants.length, 1, "一个店缺席不影响其余");
    assert.equal(joined.stats.toolCalls, 0);
  } finally {
    await rm(join(resolveThreadsRoot(), threadId), { recursive: true, force: true });
  }
});

test("定位:runId / threadId / contractId 三种钥匙都开得了门", async () => {
  const stamp = Date.now() + 2;
  const threadId = `t-join-id-${stamp}`;
  const runId = `r-join-id-${stamp}`;
  const contractId = `TC-JOINID-${stamp}`;
  const sessionKey = `agent:${AGENT}:contract:${contractId.toLowerCase()}`;
  try {
    await seedRun({ threadId, runId, contractId, sessionKey, withTrace: false });

    assert.deepEqual(
      { ...resolveRunTarget(runId), matchedBy: undefined },
      { threadId, runId, matchedBy: undefined },
      "按 runId",
    );
    assert.equal(resolveRunTarget(threadId)?.runId, runId, "按 threadId 取最近一个 run");
    assert.equal(resolveRunTarget(contractId)?.runId, runId, "按 contractId 走索引");

    // 索引失效(合约正本被清 → 索引重建成空)时,目录名兜底仍要认得它。
    // 查历史 run 全靠这一层,不能因为索引没了就查不到。
    const viaDirName = resolveRunTarget(contractId.toLowerCase());
    assert.equal(viaDirName?.runId, runId, "大小写不同的查询串也要命中(sessionKey 派生的是小写形态)");

    assert.equal(resolveRunTarget("no-such-id-at-all"), null, "认不出来就明说 null");
    assert.equal(resolveRunTarget(""), null);
  } finally {
    await rm(join(resolveThreadsRoot(), threadId), { recursive: true, force: true });
  }
});
