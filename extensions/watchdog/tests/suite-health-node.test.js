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
  evaluateRegistryFloors,
  evaluateGraphIntegrity,
  resolveAgentWorkspaceDir,
  scanWorkspaceManagedMarkers,
  evaluateCompositionSanityTable,
  evaluateConfigShape,
  COMPOSITION_SANITY_TABLE,
} from "../lib/formal-runtime/checks/health-node-evaluators.js";
import { MANAGED_BOOTSTRAP_MARKER } from "../lib/managed-doc-markers.js";

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

test("graph integrity：健康拓扑无孤儿、entry 为 bridge/gateway 节点", () => {
  const result = evaluateGraphIntegrity({
    graph: edges(["ctrl", "planner"], ["planner", "worker"], ["worker", "reviewer"]),
    agents: AGENTS,
    isReservedAgentId: fakeReserved,
  });
  assert.equal(result.edgeCount, 3);
  assert.deepEqual(result.unknownEndpoints, []);
  assert.deepEqual(result.entryIds, ["ctrl"]);
  assert.deepEqual(result.orphanIds, []);
  // 保留 agent（operator）不算 runtime，也永远不算孤儿
  assert.ok(!result.runtimeAgentIds.includes("operator"));
});

test("graph integrity：未接线 agent 被判孤儿", () => {
  const result = evaluateGraphIntegrity({
    graph: edges(["ctrl", "planner"]),
    agents: AGENTS,
    isReservedAgentId: fakeReserved,
  });
  assert.deepEqual(result.orphanIds.sort(), ["reviewer", "worker"]);
});

test("graph integrity：未配置端点被点名（含方向标注）", () => {
  const result = evaluateGraphIntegrity({
    graph: edges(["ctrl", "ghost"], ["phantom", "worker"]),
    agents: AGENTS,
    isReservedAgentId: fakeReserved,
  });
  assert.deepEqual(result.unknownEndpoints, ["ctrl→ghost (to)", "phantom→worker (from)"]);
});

test("graph integrity：零边图（reset 残留形态）edgeCount=0 且非 entry runtime 全孤儿", () => {
  const result = evaluateGraphIntegrity({ graph: edges(), agents: AGENTS, isReservedAgentId: fakeReserved });
  assert.equal(result.edgeCount, 0);
  assert.deepEqual(result.orphanIds.sort(), ["planner", "reviewer", "worker"]);
});

test("graph integrity：entry 判定覆盖 role=bridge / gateway:true / ingressSource 三形态", () => {
  const result = evaluateGraphIntegrity({
    graph: edges(),
    agents: [
      { id: "a-bridge", role: "bridge" },
      { id: "a-gw", role: "agent", gateway: true },
      { id: "a-ingress", role: "agent", ingressSource: "qq" },
      { id: "a-plain", role: "executor" },
    ],
    isReservedAgentId: () => false,
  });
  assert.deepEqual(result.entryIds.sort(), ["a-bridge", "a-gw", "a-ingress"]);
  assert.deepEqual(result.orphanIds, ["a-plain"]);
});

test("registry floors：达标无 problem，缩水/分家不一致被点名", () => {
  const healthy = {
    total: 120,
    operatorExecutable: 50,
    executable: 99,
    byFamily: { hook: 2, observe: 3, inspect: 52, apply: 60, verify: 3 },
  };
  assert.deepEqual(evaluateRegistryFloors(healthy, SURFACE_REGISTRY_FLOORS).problems, []);

  const shrunk = { ...healthy, total: 119, byFamily: { ...healthy.byFamily, inspect: 51 } };
  const { problems } = evaluateRegistryFloors(shrunk, SURFACE_REGISTRY_FLOORS);
  assert.ok(problems.some((p) => p.includes("total=119")));
  assert.ok(problems.some((p) => p.includes("byFamily.inspect=51")));
  // 119 = 2+3+51+60+3 == total → sum 一致，无 sum problem；再验 sum 不一致情形
  const lopsided = { ...healthy, byFamily: { ...healthy.byFamily, apply: 61 } };
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

test("harness 组装校验表：5 行期望码集与 validateHarnessComposition 真实语义一致", () => {
  const { failures } = evaluateCompositionSanityTable();
  assert.deepEqual(failures, [], failures.join(" | "));
  assert.equal(COMPOSITION_SANITY_TABLE.length, 5);
});
