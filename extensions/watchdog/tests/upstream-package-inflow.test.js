/**
 * upstream-package-inflow.test.js — 上游产物整包流入下游 inbox
 *
 * 用户核心设计:产物随 contract 流转,整包(全部文件)投进下一环 inbox。
 * 产物可能是多个文件,系统搬 outbox 全部产物文件,不是单 md。
 *
 * 本轮(2026-08-19)两处结构变更,测试跟着换判据:
 *   ① 上游是谁,问合约的 upstreamProducers 指针,不问图入边。
 *      旧法把「投递授权」当「产物来源」,评审/动态派工的目标不在图上就拿不到包
 *      —— 2026-08-18 图夹具一拆,评审包当场断成只写不读。下面第 3 条锁死这个回归。
 *   ② control-plane/artifacts 副本店退役,未封包窗改为直接拷树内正本。
 *      上下游从此只对着一个数据源。
 *
 * 覆盖:
 *   1. 已封包 → symlink 零拷贝,指针从 seal 取
 *   2. 未封包 → 拷树内当前内容(中场快照),控制载荷不算产物
 *   3. 图上无边但合约有指针 → 照样流入(08-18 断点的回归锁)
 *   4. 无指针 / 无包 / 缺参 → no-op,不抛
 *   5. 派工收口登记指针 + routeInbox 接入 + wake 不嵌产物
 *   6. artifacts 副本店零残留
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import {
  participantOutboxDirFor,
  resolveThreadsRoot,
} from "../lib/archive/thread-tree-store.js";
import { writeOutboxSeal, OUTBOX_SEAL_FILENAME } from "../lib/archive/outbox-seal.js";
import { UPSTREAM_GUIDE_FILE } from "../lib/delivery/upstream-guide.js";
import { persistContractById } from "../lib/contract/contracts.js";
import { copyUpstreamArtifactsToInbox } from "../lib/delivery/upstream-package-inflow.js";
import { buildWakeMessage } from "../lib/routing/dispatch/dispatch-graph-policy.js";
import { saveGraph as saveGraphUnattributed } from "../lib/agent/agent-graph-mutations.js";

// §13 整写门:测试夹具写图报身份(writer),edge 级差异日志可追溯到本文件。
const saveGraph = (graph) => saveGraphUnattributed(graph, { writer: "test:upstream-package-inflow.test.js" });
import { loadGraph } from "../lib/agent/agent-graph.js";
import { agentWorkspace } from "../lib/state/state-agent-helpers.js";
import { AGENT_END_MAIN_STAGES } from "../lib/lifecycle/agent-end/stage-definitions.js";
import { RUNTIME_RESULT_FILE } from "../lib/protocol/protocol-primitives.js";

const logger = { info() {}, warn() {}, error() {} };

let seq = 0;
// 造一份带上游指针的合约正本(落树内 contracts/),readContractSnapshotById 才读得到。
async function seedContract({ contractId, assignee, lineage, upstreamProducers = null }) {
  seq += 1;
  const contract = {
    id: contractId,
    task: "上游整包流入行为锁",
    assignee,
    status: "running",
    createdAt: Date.now() - 1000,
    lineage,
    ...(upstreamProducers ? { upstreamProducers } : {}),
  };
  await persistContractById(contract, logger);
  return contract;
}

function upstreamRootFor(agentId) {
  return join(agentWorkspace(agentId), "inbox", "upstream");
}

async function cleanup({ upstreamRoot, threadId }) {
  if (upstreamRoot) await rm(upstreamRoot, { recursive: true, force: true });
  if (threadId) await rm(join(resolveThreadsRoot(), threadId), { recursive: true, force: true });
}

// ── 1. 已封包 → 链接优先 ──────────────────────────────────────────────────────

test("已封包上游 → inbox/upstream/<producer> 是指向树 outbox 的链,指针从 seal 取", async () => {
  const cid = `tc-upin-link-${Date.now()}`;
  const lineage = { threadId: `t-upin-link-${Date.now()}`, runId: "r-1" };
  const upstreamRoot = upstreamRootFor("worker");
  try {
    await seedContract({
      contractId: cid,
      assignee: "worker",
      lineage,
      upstreamProducers: [{ agentId: "planner", contractId: cid }],
    });
    const treeOutbox = participantOutboxDirFor(lineage, "planner", cid);
    await mkdir(treeOutbox, { recursive: true });
    await writeFile(join(treeOutbox, "report.md"), "树内正本", "utf8");
    await writeFile(join(treeOutbox, "data.json"), '{"n":1}', "utf8");
    await writeOutboxSeal(treeOutbox, {
      contractId: cid,
      sessionKey: `agent:planner:contract:${cid}`,
      collectedAt: Date.now(),
      primary: "report.md",
      files: ["report.md", "data.json"],
      declaredStatus: "completed",
    });
    await rm(upstreamRoot, { recursive: true, force: true });

    const result = await copyUpstreamArtifactsToInbox({ contractId: cid, agentId: "worker" });
    assert.deepEqual(result.copied, ["planner"], "链接物化的 producer 计入 copied");
    assert.equal(result.packages.length, 1);
    const [pkg] = result.packages;
    assert.equal(pkg.path, "upstream/planner/");
    assert.deepEqual(pkg.files, ["data.json", "report.md"], "指针清单从 seal.files 取");
    assert.equal(pkg.primary, "report.md", "primary 从 seal.primary 取");
    // 物化形态是链而非拷贝:零拷贝,读穿链直达树内正本
    const linkPath = join(upstreamRoot, "planner");
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true, "包目录应为 symlink");
    assert.equal(readlinkSync(linkPath), treeOutbox, "链目标=产者树 outbox(绝对路径)");
    assert.equal(readFileSync(join(linkPath, "report.md"), "utf8"), "树内正本");
    // 导览落 upstream 根(链外),终态封包保持只读
    assert.equal(existsSync(join(upstreamRoot, UPSTREAM_GUIDE_FILE)), true, "导览应落 upstream 根");
    assert.equal(existsSync(join(treeOutbox, UPSTREAM_GUIDE_FILE)), false, "树 outbox 内零写入");
  } finally {
    await cleanup({ upstreamRoot, threadId: lineage.threadId });
  }
});

// ── 2. 未封包 → 拷树内当前内容 ────────────────────────────────────────────────

test("未封包上游(中场上车)→ 拷树内正本当前内容,控制载荷不算产物", async () => {
  const cid = `tc-upin-copy-${Date.now()}`;
  const lineage = { threadId: `t-upin-copy-${Date.now()}`, runId: "r-1" };
  const upstreamRoot = upstreamRootFor("worker");
  try {
    await seedContract({
      contractId: cid,
      assignee: "worker",
      lineage,
      upstreamProducers: [{ agentId: "planner", contractId: cid }],
    });
    const treeOutbox = participantOutboxDirFor(lineage, "planner", cid);
    await mkdir(join(treeOutbox, "nested"), { recursive: true });
    await mkdir(join(treeOutbox, ".migrated"), { recursive: true });
    await writeFile(join(treeOutbox, "draft.md"), "写到一半的稿", "utf8");
    await writeFile(join(treeOutbox, "nested", "extra.txt"), "子目录也要跟着走", "utf8");
    // 树 outbox 里除了产物还住着平台自己的东西,拷贝路必须滤掉:
    // 控制载荷(不是交付物)与点前缀隔离区(上一轮残件)。
    await writeFile(join(treeOutbox, RUNTIME_RESULT_FILE), '{"status":"completed"}', "utf8");
    await writeFile(join(treeOutbox, ".migrated", "上一轮残件.md"), "前轮遗留", "utf8");
    // 封条缺席 = 源还在跑,内容可变 → 只能拷不能链
    await rm(upstreamRoot, { recursive: true, force: true });

    const result = await copyUpstreamArtifactsToInbox({ contractId: cid, agentId: "worker" });
    assert.deepEqual(result.copied, ["planner"]);
    const [pkg] = result.packages;
    assert.deepEqual(pkg.files, ["draft.md", join("nested", "extra.txt")].sort(), "子目录结构随包保留");
    assert.equal(pkg.primary, null, "未封包 → 无 primary 声明");
    const pkgDir = join(upstreamRoot, "planner");
    assert.equal(lstatSync(pkgDir).isSymbolicLink(), false, "可变内容不得以链冒充终态");
    assert.equal(readFileSync(join(pkgDir, "draft.md"), "utf8"), "写到一半的稿");
    assert.equal(readFileSync(join(pkgDir, "nested", "extra.txt"), "utf8"), "子目录也要跟着走");
    // 下面两条是这个用例的承重点:平台文件混进下游 inbox = 上游交付物里混进控制载荷
    assert.equal(existsSync(join(pkgDir, RUNTIME_RESULT_FILE)), false, "控制载荷不得随包上车");
    assert.equal(existsSync(join(pkgDir, ".migrated")), false, "点前缀隔离区不得随包上车");
  } finally {
    await cleanup({ upstreamRoot, threadId: lineage.threadId });
  }
});

// ── 3. 上游解析脱图(08-18 断点回归锁) ────────────────────────────────────────

test("图上无 producer→consumer 边,但合约有指针 → 照样流入", async () => {
  // 这一条锁死 2026-08-18 的断点:评审/动态派工的目标本就不在图上,
  // 旧法反查图入边直接返回空,包永远到不了下游,而任务文本还在指 inbox/upstream/。
  const originalGraph = await loadGraph();
  const cid = `tc-upin-nograph-${Date.now()}`;
  const lineage = { threadId: `t-upin-nograph-${Date.now()}`, runId: "r-1" };
  const upstreamRoot = upstreamRootFor("reviewer1");
  try {
    await saveGraph({ edges: [{ from: "controller", to: "planner", label: "unrelated" }] });
    const graph = await loadGraph();
    assert.equal(
      graph.edges.some((e) => e.to === "reviewer1"),
      false,
      "前置:图上确实没有指向 reviewer1 的边",
    );

    await seedContract({
      contractId: cid,
      assignee: "reviewer1",
      lineage,
      upstreamProducers: [{ agentId: "planner", contractId: cid }],
    });
    const treeOutbox = participantOutboxDirFor(lineage, "planner", cid);
    await mkdir(treeOutbox, { recursive: true });
    await writeFile(join(treeOutbox, "被审稿.md"), "请审这个", "utf8");
    await rm(upstreamRoot, { recursive: true, force: true });

    const result = await copyUpstreamArtifactsToInbox({ contractId: cid, agentId: "reviewer1" });
    assert.deepEqual(result.copied, ["planner"], "无图边照样流入 —— 上游身份随合约走");
    assert.equal(
      readFileSync(join(upstreamRoot, "planner", "被审稿.md"), "utf8"),
      "请审这个",
    );
  } finally {
    await saveGraph(originalGraph);
    await cleanup({ upstreamRoot, threadId: lineage.threadId });
  }
});

test("合约有指针但上游本环无产出 → 不复制,不留空包", async () => {
  const cid = `tc-upin-nopkg-${Date.now()}`;
  const lineage = { threadId: `t-upin-nopkg-${Date.now()}`, runId: "r-1" };
  const upstreamRoot = upstreamRootFor("worker");
  try {
    await seedContract({
      contractId: cid,
      assignee: "worker",
      lineage,
      upstreamProducers: [{ agentId: "planner", contractId: cid }],
    });
    await rm(upstreamRoot, { recursive: true, force: true });
    assert.deepEqual(
      await copyUpstreamArtifactsToInbox({ contractId: cid, agentId: "worker" }),
      { copied: [], packages: [] },
    );
    assert.equal(existsSync(join(upstreamRoot, "planner")), false);
  } finally {
    await cleanup({ upstreamRoot, threadId: lineage.threadId });
  }
});

// ── 4. 无指针 / 缺参 ─────────────────────────────────────────────────────────

test("合约无 upstreamProducers 指针(链首) → 不复制", async () => {
  const cid = `tc-upin-root-${Date.now()}`;
  const lineage = { threadId: `t-upin-root-${Date.now()}`, runId: "r-1" };
  try {
    await seedContract({ contractId: cid, assignee: "worker", lineage });
    assert.deepEqual(
      await copyUpstreamArtifactsToInbox({ contractId: cid, agentId: "worker" }),
      { copied: [], packages: [] },
    );
  } finally {
    await cleanup({ threadId: lineage.threadId });
  }
});

test("缺参 → no-op;不抛", async () => {
  assert.deepEqual(await copyUpstreamArtifactsToInbox({ agentId: "worker" }), { copied: [], packages: [] });
  assert.deepEqual(await copyUpstreamArtifactsToInbox({ contractId: "tc-x" }), { copied: [], packages: [] });
  assert.deepEqual(await copyUpstreamArtifactsToInbox({}), { copied: [], packages: [] });
});

// ── 5. 接入护栏 ───────────────────────────────────────────────────────────────

test("dispatch-graph-policy:派工收口登记上游指针,不查图入边", async () => {
  const src = await readFile(new URL("../lib/routing/dispatch/dispatch-graph-policy.js", import.meta.url), "utf8");
  assert.match(src, /applyUpstreamProducerPointer/, "派工收口应登记上游指针");
  assert.match(
    src,
    /contract\.upstreamProducers\s*=\s*\[\{\s*agentId:\s*fromAgent/,
    "指针内容 = 把合约交出来的那一跳",
  );
  // 排队路与派工路必须都带上 fromAgent,否则排队进来的那一跳没有上游
  assert.match(src, /assignContractToAgent\([^)]*entry\.fromAgent/s, "排队路应把 fromAgent 传到收口");
  assert.match(src, /applySharedContractDispatchMutation\(contract, targetAgent, updateContract, fromAgent\)/, "派工路应把 fromAgent 传到收口");
});

test("upstream-package-inflow:上游解析读合约指针,不引图", async () => {
  const src = await readFile(new URL("../lib/delivery/upstream-package-inflow.js", import.meta.url), "utf8");
  assert.match(src, /resolveUpstreamProducers/, "应有指针解析");
  assert.doesNotMatch(src, /getEdgesTo|loadGraph/, "上游解析不得再查图");
});

test("runtime-mailbox:routeInbox 接入 copyUpstream + 写 upstreamPackages 指针 + try/catch", async () => {
  const src = await readFile(new URL("../lib/routing/mailbox/runtime-mailbox.js", import.meta.url), "utf8");
  assert.match(src, /copyUpstreamArtifactsToInbox/, "routeInbox 应接入 copyUpstreamArtifactsToInbox");
  assert.match(src, /upstreamPackages/, "应在 contract.json 写 upstreamPackages 指针");
  const handlerIdx = src.indexOf("handler.routeInbox");
  const copyIdx = src.indexOf("copyUpstreamArtifactsToInbox(");
  assert.ok(handlerIdx >= 0 && copyIdx >= 0 && handlerIdx < copyIdx, "上游复制应在 handler.routeInbox 之后");
  assert.match(src, /try\s*\{[\s\S]*copyUpstreamArtifactsToInbox[\s\S]*\}\s*catch/, "上游复制应包在 try/catch 内");
});

test("dispatch-graph-policy:buildWakeMessage 回归 base(不嵌上游产物,agent 只读自己 inbox)", async () => {
  assert.equal(buildWakeMessage("tc-wake-x"), "Continue the current contract: tc-wake-x.");
  const src = await readFile(new URL("../lib/routing/dispatch/dispatch-graph-policy.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /WAKE_UPSTREAM_CAP/, "wake 嵌入上限常量应已删除");
  assert.doesNotMatch(src, /【上游产物/, "wake 不应再嵌上游产物正文");
});

// ── 6. artifacts 副本店零残留 ─────────────────────────────────────────────────

test("artifacts 副本店已整店退役:零写者、零地址面、agent_end 无 preserve 站", async () => {
  const ids = AGENT_END_MAIN_STAGES.map((s) => s.id);
  assert.equal(ids.includes("preserve_artifact"), false, "agent_end 不应再有产物副本站");

  const inflowSrc = await readFile(new URL("../lib/delivery/upstream-package-inflow.js", import.meta.url), "utf8");
  assert.doesNotMatch(inflowSrc, /saveAgentArtifact|artifactPackageDir|ARTIFACTS_ROOT/, "地址面与写者应已删除");
  // 判据是回退路取自哪里,不是源码里能不能提这个词——注释要能讲清退役来龙去脉。
  assert.match(
    inflowSrc,
    /const srcPkg = sourceHome \? participantOutboxDirFor\(/,
    "未封包窗的数据源应是树内 outbox",
  );

  const transportSrc = await readFile(new URL("../lib/lifecycle/agent-end/transport.js", import.meta.url), "utf8");
  assert.doesNotMatch(transportSrc, /saveAgentArtifact/, "transport 不应再调产物副本写者");
  assert.match(transportSrc, /snapshotOutputToRunTree/, "树内快照应保留");
});

test("控制载荷判据单一真值:采集侧与搬运侧共用同一份名单", async () => {
  const { isControlOutboxFile } = await import("../lib/routing/mailbox/runtime-mailbox-outbox-helpers.js");
  assert.equal(isControlOutboxFile(OUTBOX_SEAL_FILENAME), true, "封条不是交付物");
  assert.equal(isControlOutboxFile(RUNTIME_RESULT_FILE), true, "运行时结果不是交付物");
  assert.equal(isControlOutboxFile("report.md"), false, "真产物照常算数");

  // 消费面都必须引这一份,各写各的会让同一文件在一处是产物、另一处不是
  for (const rel of [
    "../lib/agent/agent-session-transcript.js",
  ]) {
    const src = await readFile(new URL(rel, import.meta.url), "utf8");
    assert.match(src, /isControlOutboxFile/, `${rel} 应共用控制载荷判据`);
  }
});
