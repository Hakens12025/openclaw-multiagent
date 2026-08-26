// tests/run-tree-inspect.test.js — 树读面(run-tree-inspect)单测 + 六表面注册/穿越拒收。
//
// 沙箱纪律:seed-tree-stores 必须是第一条静态 import(环境种子先于任何店 IO),
// 全部树写发生在 tmp 沙箱,真店零触碰。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  listThreads,
  readContractSeal,
  readRunCausality,
  readRunDetail,
  readRunEvents,
  readTreeIndexes,
} from "../lib/archive/run-tree-inspect.js";
import { appendRunEvent, flushRunEvents } from "../lib/archive/run-event-recorder.js";
import { resolveThreadsRoot } from "../lib/archive/thread-tree-store.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";
import {
  recordContractHome,
  runDirFor,
  participantDirFor,
  participantOutboxDirFor,
  participantSessionJsonlFor,
} from "../lib/archive/thread-tree-store.js";
import { recordSessionHome } from "../lib/archive/session-home-index.js";
import { writeOutboxSeal } from "../lib/archive/outbox-seal.js";
import {
  getCliSystemSurface,
  inspectCliSystemSurface,
} from "../lib/cli-system/cli-surface-registry.js";
import { validateCliSurface } from "../lib/cli-system/cli-surface-schema.js";

// 种子谱系带进程唯一后缀(pid+进程内计数):并发跑者共享同一沙箱根时,
// 各进程的线程/合约/会话种子互不相撞,per-thread 计数断言保持稳定。
let seedSerial = 0;
const SEED_UNIQ = `${process.pid}-${seedSerial++}`;
const LINEAGE_A = { threadId: `t-tree-alpha-${SEED_UNIQ}`, runId: "r-0001" };
const LINEAGE_B = { threadId: `t-tree-beta-${SEED_UNIQ}`, runId: "r-0002" };
const CID = `TC-TREE-INSPECT-A-${SEED_UNIQ}`;
const SID = `sess-tree-inspect-1-${SEED_UNIQ}`;

let seeded = false;
async function seedTree() {
  if (seeded) return;
  seeded = true;

  // run A:完整事件账(触发→建约→回合→收约→关账),run_closed 触发投影编译
  await mkdir(runDirFor(LINEAGE_A), { recursive: true }); // 树目录=在场判据(物),记账不再自动建目录
  await appendRunEvent({ lineage: LINEAGE_A, type: "run_triggered", payload: { origin: "test" } });
  await appendRunEvent({ lineage: LINEAGE_A, type: "contract_created", contractId: CID, agentId: "planner" });
  await appendRunEvent({
    lineage: LINEAGE_A,
    type: "turn_started",
    contractId: CID,
    agentId: "planner",
    sessionKey: "agent:planner:test",
    causeRefs: [{ runId: LINEAGE_A.runId, seq: 2 }],
  });
  await appendRunEvent({ lineage: LINEAGE_A, type: "closed", contractId: CID, agentId: "planner" });
  await appendRunEvent({ lineage: LINEAGE_A, type: "run_closed" });
  await flushRunEvents(LINEAGE_A);

  // 合约正本 + 索引行
  const contractsDir = join(runDirFor(LINEAGE_A), "contracts");
  await mkdir(contractsDir, { recursive: true });
  await writeFile(join(contractsDir, `${CID}.json`), `${JSON.stringify({ id: CID, status: "completed", executionModels: { planner: "glm-bigmodel/glm-5.1" } })}\n`);
  // 无 executionModels 的第二正本:投影应稀疏(不为它落键)
  await writeFile(join(contractsDir, `${CID}-bare.json`), `${JSON.stringify({ id: `${CID}-bare`, status: "completed" })}\n`);
  await recordContractHome(CID, LINEAGE_A);

  // participant 摘要素材:session 副本 + 封条 outbox
  await mkdir(participantDirFor(LINEAGE_A, "planner"), { recursive: true });
  await writeFile(participantSessionJsonlFor(LINEAGE_A, "planner", SID), `${JSON.stringify({ type: "message" })}\n`);
  await recordSessionHome({ sessionId: SID, agentId: "planner", lineage: LINEAGE_A, ts: Date.now() });
  const outboxDir = participantOutboxDirFor(LINEAGE_A, "planner", CID);
  await mkdir(outboxDir, { recursive: true });
  await writeFile(join(outboxDir, "result.md"), "done\n");
  await writeOutboxSeal(outboxDir, {
    contractId: CID,
    sessionKey: "agent:planner:test",
    collectedAt: Date.now(),
    primary: "result.md",
    files: ["result.md"],
    declaredStatus: "completed",
  });

  // run B:跨 run 因果引用
  await mkdir(runDirFor(LINEAGE_B), { recursive: true });
  await appendRunEvent({
    lineage: LINEAGE_B,
    type: "run_triggered",
    payload: { origin: "test-b" },
    causeRefs: [{ runId: LINEAGE_A.runId, seq: 5 }],
  });
  await flushRunEvents(LINEAGE_B);
}

// ── 读函数单测 ────────────────────────────────────────────────────────────────

test("listThreads 扫沙箱树根:runCount/latestRunId/latestTs 齐全,limit 生效", async () => {
  await seedTree();
  const all = await listThreads({});
  assert.equal(all.counts.total >= 2, true, "沙箱树应至少 2 线程");
  const threadA = all.threads.find((t) => t.threadId === LINEAGE_A.threadId);
  assert.ok(threadA, "线程 A 应在清单");
  assert.equal(threadA.runCount, 1);
  assert.equal(threadA.latestRunId, LINEAGE_A.runId);
  assert.equal(Number.isFinite(threadA.latestTs), true, "latestTs 应取自 events 尾行 ts");
  const limited = await listThreads({ limit: 1 });
  assert.equal(limited.threads.length, 1);
  assert.equal(limited.counts.returned, 1);
  assert.equal(limited.counts.total, all.counts.total);
});

test("readRunDetail 返回 run.json 投影 + contracts 清单 + participants 摘要(含封条态)", async () => {
  await seedTree();
  const detail = await readRunDetail(LINEAGE_A);
  assert.equal(detail.found, true);
  assert.ok(detail.run, "run_closed 已触发投影编译,run.json 应在");
  assert.equal(detail.run.closed, true);
  assert.deepEqual([...detail.contracts.ids].sort(), [CID, `${CID}-bare`].sort());
  // 执行模型投影:有字段的合约带上,无字段的稀疏不落键
  assert.deepEqual(detail.contracts.executionModels[CID], { planner: "glm-bigmodel/glm-5.1" });
  assert.equal(`${CID}-bare` in detail.contracts.executionModels, false);
  const planner = detail.participants.find((p) => p.agentId === "planner");
  assert.ok(planner, "planner 参与者应在摘要");
  assert.equal(planner.turnFileCount >= 1, true, "turn-*.json 投影文件应计数");
  assert.equal(planner.sessionCopyCount, 1);
  const outbox = planner.outboxes.find((o) => o.contractId === CID);
  assert.ok(outbox, "outbox-{cid} 应在摘要");
  assert.equal(outbox.sealed, true);
  assert.equal(outbox.declaredStatus, "completed");
});

test("readRunDetail 对 GC 后/不存在的 run 返回 found:false(合法 404)", async () => {
  await seedTree();
  const missing = await readRunDetail({ threadId: "t-tree-alpha", runId: "r-gone" });
  assert.deepEqual(missing, { found: false, threadId: "t-tree-alpha", runId: "r-gone" });
});

test("readRunEvents 默认取尾部窗口,afterSeq 游标翻页,source 恒 db", async () => {
  await seedTree();
  const tail = await readRunEvents({ ...LINEAGE_A, limit: 2 });
  assert.equal(tail.found, true);
  assert.equal(tail.source, "db", "事件账唯一来源 = records DB");
  assert.equal(tail.totalEvents, 5);
  assert.equal(tail.latestSeq, 5);
  assert.deepEqual(tail.events.map((e) => e.seq), [4, 5], "缺省应取尾部 limit 条");
  const page = await readRunEvents({ ...LINEAGE_A, afterSeq: 1, limit: 2 });
  assert.deepEqual(page.events.map((e) => e.seq), [2, 3], "afterSeq 应向后翻页");
  // run B 只有一行跨 run 因果触发事件;badLines 是文件撕裂时代指标,恒 0
  const single = await readRunEvents({ ...LINEAGE_B, limit: 10 });
  assert.equal(single.found, true);
  assert.equal(single.totalEvents, 1);
  assert.equal(single.badLines, 0);
});

test("readRunCausality 事件→节点/causeRefs→边,跨 run 引用原样透出", async () => {
  await seedTree();
  const graph = await readRunCausality(LINEAGE_A);
  assert.equal(graph.found, true);
  assert.equal(graph.counts.nodes, 5);
  const inRunEdge = graph.edges.find((e) => e.to.seq === 3);
  assert.deepEqual(inRunEdge, {
    from: { runId: LINEAGE_A.runId, seq: 2 },
    to: { runId: LINEAGE_A.runId, seq: 3 },
    crossRun: false,
  });
  const graphB = await readRunCausality(LINEAGE_B);
  assert.equal(graphB.counts.crossRunEdges, 1);
  const crossEdge = graphB.edges[0];
  assert.equal(crossEdge.crossRun, true);
  assert.equal(crossEdge.from.runId, LINEAGE_A.runId);
});

test("readContractSeal 经 contract-index 寻家并列全参与者封条;无家 found:false", async () => {
  await seedTree();
  const sealView = await readContractSeal({ contractId: CID });
  assert.equal(sealView.found, true);
  assert.equal(sealView.threadId, LINEAGE_A.threadId);
  assert.equal(sealView.counts.seals, 1);
  assert.equal(sealView.seals[0].agentId, "planner");
  assert.equal(sealView.seals[0].primary, "result.md");
  assert.equal(sealView.latest.agentId, "planner");
  assert.equal(sealView.latest.declaredStatus, "completed");

  const unknown = await readContractSeal({ contractId: "TC-NO-SUCH-HOME" });
  assert.equal(unknown.found, false);
});

test("readTreeIndexes 统计两索引行数/实体数,不 dump 全量", async () => {
  await seedTree();
  const indexes = await readTreeIndexes();
  assert.equal(indexes.contractIndex.exists, true);
  assert.equal(indexes.contractIndex.entries >= 1, true);
  assert.equal(indexes.sessionIndex.exists, true);
  assert.equal(indexes.sessionIndex.entries >= 1, true);
  assert.equal("threads" in indexes, false, "统计面不应携带全量数据");
});

// ── 六表面注册合规(照 route-inspect-surface 既有模式) ─────────────────────────

const TREE_SURFACES = [
  "inspect.threads",
  "inspect.run",
  "inspect.run_events",
  "inspect.run_causality",
  "inspect.contract_seal",
  "inspect.tree_indexes",
];

for (const id of TREE_SURFACES) {
  test(`${id} surface 存在且合规`, () => {
    const surface = getCliSystemSurface(id);
    assert.ok(surface, `${id} 必须可经 getCliSystemSurface 取到`);
    assert.equal(surface.family, "inspect");
    assert.equal(surface.status, "active");
    assert.equal(surface.source, "runtime_inspect");
    assert.equal(surface.operatorExecutable, false);
    assert.equal(surface.displayId, `control:${id}`);
    const { ok, problems } = validateCliSurface(surface);
    assert.equal(ok, true, `${id} 必须通过冻结 schema: ${problems.join("; ")}`);
  });
}

test("树表面经 inspectCliSystemSurface 分发与直读等价", async () => {
  await seedTree();
  const direct = await readRunEvents({ ...LINEAGE_A, limit: 3 });
  const viaSurface = await inspectCliSystemSurface({
    surfaceId: "inspect.run_events",
    params: { threadId: LINEAGE_A.threadId, runId: LINEAGE_A.runId, limit: 3 },
  });
  assert.deepEqual(viaSurface, direct, "surface 与直读应等价");
  const threadsDirect = await listThreads({ limit: 2 });
  const threadsViaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.threads", params: { limit: 2 } });
  assert.deepEqual(threadsViaSurface, threadsDirect, "inspect.threads 与直读应等价");
});

// ── 路径穿越拒收(分发边界 charset 白名单) ─────────────────────────────────────

const TRAVERSAL_CASES = [
  { surfaceId: "inspect.run", params: { threadId: "../evil", runId: "r-0001" }, label: "threadId 穿越" },
  { surfaceId: "inspect.run", params: { threadId: "t-x", runId: "a/b" }, label: "runId 分隔符" },
  { surfaceId: "inspect.run_events", params: { threadId: "..", runId: "r-0001" }, label: "threadId 点段" },
  { surfaceId: "inspect.run_causality", params: { threadId: "t-x", runId: "..\\win" }, label: "runId 反斜杠" },
  { surfaceId: "inspect.contract_seal", params: { contractId: "../../secrets" }, label: "contractId 穿越" },
];

for (const { surfaceId, params, label } of TRAVERSAL_CASES) {
  test(`${surfaceId} 拒收路径穿越参数（${label}）`, async () => {
    await assert.rejects(
      () => inspectCliSystemSurface({ surfaceId, params }),
      /invalid (threadId|runId|contractId)/,
      "非法路径段必须在分发边界被拒",
    );
  });
}

test("沙箱自证:树写全部落在门卫解析根之下,绝不落生产树(店根门卫 §13)", () => {
  const resolvedRoot = resolveThreadsRoot();
  assert.equal(runDirFor(LINEAGE_A).startsWith(resolvedRoot), true, "树店写必须落在门卫解析根下");
  assert.equal(resolvedRoot.startsWith(CONTROL_PLANE_PATHS.threadsDir), false, "测试进程根绝不指向生产树");
});
