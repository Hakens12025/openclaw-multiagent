/**
 * suite-health-node.test.js — health 套件 TIER-0 纯逻辑的封闭单测。
 *
 * 只测纯求值函数（合成 graph/agents fixture、下界逻辑、临时目录 marker 扫描、
 * 组装校验表），不连 gateway、不读 live 配置。runHealthGatewayChecks 不在单测范围。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  SURFACE_REGISTRY_FLOORS,
  EVIDENCE_LEDGER_POLICY,
  evaluateRegistryFloors,
  evaluateGraphIntegrity,
  resolveAgentWorkspaceDir,
  scanWorkspaceManagedMarkers,
  evaluateConfigShape,
  evaluateTraceLedgerSample,
} from "../lib/formal-runtime/checks/health-node-evaluators.js";
import { MANAGED_BOOTSTRAP_MARKER } from "../lib/prompt/managed-doc-markers.js";
import { TRACE_SENTINELS } from "../lib/evidence/trace-event-schema.js";

// 测试用保留判定：固定把 "operator" 当 control-plane（不依赖平台真实集合，保持封闭）。
const fakeReserved = (id) => id === "operator";

const AGENTS = Object.freeze([
  { id: "ctrl", role: "bridge", gateway: true },
  { id: "operator", role: "agent" },
  { id: "planner", role: "planner" },
  { id: "worker", role: "executor" },
  { id: "reviewer", role: "reviewer" },
]);

function edges(...pairs) {
  return { edges: pairs.map(([from, to]) => ({ from, to, label: null, metadata: {} })) };
}

test("graph integrity：只判边数与端点在册", () => {
  const result = evaluateGraphIntegrity({
    graph: edges(["ctrl", "planner"], ["planner", "worker"], ["worker", "reviewer"]),
    agents: AGENTS,
    isReservedAgentId: fakeReserved,
  });
  assert.equal(result.edgeCount, 3);
  assert.deepEqual(result.unknownEndpoints, []);
});

// 2026-08-19 退役锁：可达性/孤儿判定已删。前提在动态派工时代不成立 —— 不在图上
// 不等于收不到活（live collab 实证：worker 与 reviewer1 都不在图上却照样被
// assign_task 与当时的 request_review 派到活）。此锁防它复活。
test("graph integrity：不再产出可达性/孤儿判定（退役锁）", () => {
  const result = evaluateGraphIntegrity({
    graph: edges(["ctrl", "planner"]),
    agents: AGENTS,
    isReservedAgentId: fakeReserved,
  });
  assert.equal("orphanIds" in result, false);
  assert.equal("entryIds" in result, false);
  assert.equal("runtimeAgentIds" in result, false);
});

test("graph integrity：未配置端点被点名（含方向标注）", () => {
  const result = evaluateGraphIntegrity({
    graph: edges(["ctrl", "ghost"], ["phantom", "worker"]),
    agents: AGENTS,
    isReservedAgentId: fakeReserved,
  });
  assert.deepEqual(result.unknownEndpoints, ["ctrl→ghost (to)", "phantom→worker (from)"]);
});

// 孤儿/entry 判定随 graph.reachability 于 2026-08-19 退役；此处只保留与之无关的
// 那半条:零边图是 reset 残留形态,由 graph.edges-exist(E-GRAPH-002)判据消费。
test("graph integrity：零边图（reset 残留形态）edgeCount=0", () => {
  const result = evaluateGraphIntegrity({ graph: edges(), agents: AGENTS, isReservedAgentId: fakeReserved });
  assert.equal(result.edgeCount, 0);
});

test("registry floors：达标无 problem，缩水/分家不一致被点名", () => {
  const healthy = {
    total: 114,
    operatorExecutable: 44,
    executable: 93,
    byFamily: { hook: 2, observe: 3, inspect: 52, apply: 54, verify: 3 },
  };
  assert.deepEqual(evaluateRegistryFloors(healthy, SURFACE_REGISTRY_FLOORS).problems, []);

  const shrunk = { ...healthy, total: 113, byFamily: { ...healthy.byFamily, inspect: 51 } };
  const { problems } = evaluateRegistryFloors(shrunk, SURFACE_REGISTRY_FLOORS);
  assert.ok(problems.some((p) => p.includes("total=113")));
  assert.ok(problems.some((p) => p.includes("byFamily.inspect=51")));
  // 115 = 2+3+53+54+3 == total → sum 一致，无 sum problem；再验 sum 不一致情形
  const lopsided = { ...healthy, byFamily: { ...healthy.byFamily, apply: 55 } };
  assert.ok(evaluateRegistryFloors(lopsided, SURFACE_REGISTRY_FLOORS).problems.some((p) => p.includes("sum")));
});

test("config shape：空/重复 id/缺 token 全部点名", () => {
  assert.deepEqual(
    evaluateConfigShape({ agents: { list: [{ id: "a" }] }, gateway: { auth: { token: "t" } } }).problems,
    [],
  );
  const bad = evaluateConfigShape({ agents: { list: [{ id: "a" }, { id: "a" }, {}] }, gateway: {} });
  assert.ok(bad.problems.some((p) => p.includes("without id")));
  assert.ok(bad.problems.some((p) => p.includes("not unique")));
  assert.ok(bad.problems.some((p) => p.includes("token")));
  assert.ok(evaluateConfigShape({}).problems.some((p) => p.includes("agents.list")));
});

test("workspace 目录解析：~ 展开 / 绝对路径直通 / 相对挂 ~/.openclaw / 缺省回落约定目录", () => {
  const home = "/fake-home";
  assert.equal(resolveAgentWorkspaceDir({ id: "x", workspace: "~/ws/x" }, { home }), "/fake-home/ws/x");
  assert.equal(resolveAgentWorkspaceDir({ id: "x", workspace: "/abs/x" }, { home }), "/abs/x");
  assert.equal(resolveAgentWorkspaceDir({ id: "x", workspace: "workspaces/x" }, { home }), "/fake-home/.openclaw/workspaces/x");
  assert.equal(resolveAgentWorkspaceDir({ id: "x" }, { home }), "/fake-home/.openclaw/workspaces/x");
});

test("marker 扫描：托管/接管/缺失三态 + SOUL.md 带 marker = 硬违规", async () => {
  const root = await mkdtemp(join(tmpdir(), "health-marker-scan-"));
  try {
    // agentA（executor）：IDENTITY+HEARTBEAT 带 marker，SOUL 无 marker → 全托管、零违规
    const dirA = join(root, "agentA");
    await mkdir(dirA, { recursive: true });
    await writeFile(join(dirA, "IDENTITY.md"), `${MANAGED_BOOTSTRAP_MARKER}\nidentity`, "utf8");
    await writeFile(join(dirA, "HEARTBEAT.md"), `${MANAGED_BOOTSTRAP_MARKER}\nbeat`, "utf8");
    await writeFile(join(dirA, "SOUL.md"), "user soul, no marker", "utf8");

    // agentB（executor）：IDENTITY 缺失，HEARTBEAT 用户接管（无 marker），SOUL 被平台越权打了 marker
    const dirB = join(root, "agentB");
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirB, "HEARTBEAT.md"), "custom beat", "utf8");
    await writeFile(join(dirB, "SOUL.md"), `${MANAGED_BOOTSTRAP_MARKER}\nstomped soul`, "utf8");

    const scan = await scanWorkspaceManagedMarkers({
      agents: [
        { id: "agentA", role: "executor", workspace: dirA },
        { id: "agentB", role: "executor", workspace: dirB },
      ],
    });

    const a = scan.perAgent.find((entry) => entry.agentId === "agentA");
    assert.deepEqual(a.managed.sort(), ["HEARTBEAT.md", "IDENTITY.md"]);
    assert.deepEqual(a.missing, []);
    assert.equal(a.soulViolation, false);

    const b = scan.perAgent.find((entry) => entry.agentId === "agentB");
    assert.deepEqual(b.missing, ["IDENTITY.md"]);
    assert.deepEqual(b.custom, ["HEARTBEAT.md"]);
    assert.equal(b.soulViolation, true);

    assert.equal(scan.missingTotal, 1);
    assert.equal(scan.customTotal, 1);
    assert.deepEqual(scan.soulViolations, ["agentB"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marker 扫描：SOUL.md 缺失不是违规（可选文件）", async () => {
  const root = await mkdtemp(join(tmpdir(), "health-marker-nosoul-"));
  try {
    const dir = join(root, "agentC");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "IDENTITY.md"), `${MANAGED_BOOTSTRAP_MARKER}\nx`, "utf8");
    await writeFile(join(dir, "HEARTBEAT.md"), `${MANAGED_BOOTSTRAP_MARKER}\nx`, "utf8");
    const scan = await scanWorkspaceManagedMarkers({ agents: [{ id: "agentC", role: "planner", workspace: dir }] });
    assert.deepEqual(scan.soulViolations, []);
    assert.equal(scan.missingTotal, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 证据链抽样评估（E-EVIDENCE 码族）──────────────────────────────────────────
// 合成会话记录：完整性判定 = seq 连续 + 首尾哨兵（文件账退役批:哈希链已随文件层
// 退役,由 (sessionKey,seq) 唯一索引 + 本判定守）,不落盘、不依赖真实 store。

function syntheticTraceRecords({ events = 2, close = true, gapAt = null } = {}) {
  const kinds = [TRACE_SENTINELS.OPEN, ...Array(events).fill("internal")];
  if (close) kinds.push(TRACE_SENTINELS.CLOSE);
  return kinds.map((kind, i) => ({
    seq: gapAt === null || i < gapAt ? i : i + 1, // gapAt 起 seq 跳号 → "seq gap"
    kind, sessionKey: "s", ts: i,
  }));
}

test("trace ledger 抽样：全完整 → 判定充分且未超阈", () => {
  const samples = Array.from({ length: 6 }, (_, i) => ({
    name: `s${i}`,
    records: syntheticTraceRecords(),
  }));
  const verdict = evaluateTraceLedgerSample(samples);
  assert.equal(verdict.sampled, 6);
  assert.equal(verdict.incompleteCount, 0);
  assert.equal(verdict.ratio, 0);
  assert.equal(verdict.sufficient, true);
  assert.equal(verdict.exceeded, false);
});

test("trace ledger 抽样：半数残缺（缺 close 哨兵 + seq 断档）→ 超阈，残缺原因被点名", () => {
  const samples = [
    { name: "ok1", records: syntheticTraceRecords() },
    { name: "ok2", records: syntheticTraceRecords() },
    { name: "ok3", records: syntheticTraceRecords() },
    { name: "noclose", records: syntheticTraceRecords({ close: false }) },
    { name: "seqgap", records: syntheticTraceRecords({ gapAt: 1 }) },
    { name: "empty", records: [] },
  ];
  const verdict = evaluateTraceLedgerSample(samples);
  assert.equal(verdict.sampled, 6);
  assert.equal(verdict.incompleteCount, 3);
  assert.equal(verdict.ratio, 0.5);
  assert.equal(verdict.exceeded, true);
  assert.ok(verdict.incomplete.some((entry) => entry.includes("noclose") && entry.includes("missing close sentinel")));
  assert.ok(verdict.incomplete.some((entry) => entry.includes("seqgap") && entry.includes("seq gap")));
});

test("trace ledger 抽样：空样本 / 样本不足 → 不判定（sufficient=false、exceeded=false）", () => {
  const empty = evaluateTraceLedgerSample([]);
  assert.equal(empty.sampled, 0);
  assert.equal(empty.sufficient, false);
  assert.equal(empty.exceeded, false);

  // 样本量低于 minSamples 时哪怕全残缺也不升格——样本不足只说明系统没跑够，怪不到桥头上
  const thin = evaluateTraceLedgerSample([
    { name: "a", records: syntheticTraceRecords({ close: false }) },
    { name: "b", records: [] },
  ]);
  assert.equal(thin.sampled, 2);
  assert.ok(thin.sampled < EVIDENCE_LEDGER_POLICY.minSamples);
  assert.equal(thin.incompleteCount, 2);
  assert.equal(thin.sufficient, false);
  assert.equal(thin.exceeded, false);
});

test("evaluateCollabToolMounting: named/blanket pass, missing named, roles without requirements skipped", async () => {
  const { evaluateCollabToolMounting } = await import("../lib/formal-runtime/checks/health-node-evaluators.js");
  const requiredByRole = {
    planner: ["assign_task", "wake_agent"],
    executor: ["wake_agent"],
  };
  const verdict = evaluateCollabToolMounting({
    agents: [
      { id: "planner", role: "planner", tools: { allow: ["read", "assign_task", "wake_agent"] } },
      { id: "worker", role: "executor", tools: { allow: ["read", "watchdog"] } },
      { id: "worker2", role: "executor", tools: { allow: ["read"] } },
      { id: "helper", role: "bridge", tools: { allow: ["read"] } },
    ],
    requiredByRole,
  });
  assert.equal(verdict.covered, 2);
  assert.equal(verdict.problems.length, 1);
  assert.match(verdict.problems[0], /worker2\(executor\): missing wake_agent/);
});
