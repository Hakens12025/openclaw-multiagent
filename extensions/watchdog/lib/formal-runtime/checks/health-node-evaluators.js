// lib/formal-runtime/checks/health-node-evaluators.js — health TIER-0 纯求值层。
//
// 全部无 HTTP、确定性；除 marker 扫描读文件外无副作用。被 health-node.js 接线消费，
// 被 tests/suite-health-node.test.js 封闭单测（合成 fixture / 临时目录）。

import { readFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

import { validateHarnessComposition } from "../../harness/harness-composition.js";
import { getManagedGuidanceFilesForRole } from "../../agent/agent-enrollment-discovery.js";
import { MANAGED_BOOTSTRAP_MARKER } from "../../managed-doc-markers.js";
import { isReservedControlLayerAgentId } from "../../agent/agent-plane-policy.js";

// ── 下界快照（2026-06-10 实测 120/52/60/3；只会增长，缩水=有人删了 surface）────
export const SURFACE_REGISTRY_FLOORS = Object.freeze({
  total: 120,
  operatorExecutable: 50,
  executable: 99,
  byFamily: Object.freeze({ hook: 2, observe: 3, inspect: 52, apply: 60, verify: 3 }),
  runtimeInspectSources: 34,
});

export const ERROR_CODE_REGISTRY_FLOOR = 90;

// ── 纯求值：注册表计数下界 ─────────────────────────────────────────────────────
export function evaluateRegistryFloors(counts = {}, floors = SURFACE_REGISTRY_FLOORS) {
  const problems = [];
  const checkFloor = (label, actual, floor) => {
    if (!Number.isFinite(actual) || actual < floor) {
      problems.push(`${label}=${actual} below floor ${floor}`);
    }
  };
  checkFloor("total", counts.total, floors.total);
  checkFloor("operatorExecutable", counts.operatorExecutable, floors.operatorExecutable);
  checkFloor("executable", counts.executable, floors.executable);
  for (const [family, floor] of Object.entries(floors.byFamily || {})) {
    checkFloor(`byFamily.${family}`, counts.byFamily?.[family], floor);
  }
  const familySum = Object.values(counts.byFamily || {}).reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
  if (familySum !== counts.total) {
    problems.push(`byFamily sum ${familySum} != total ${counts.total}`);
  }
  return { problems };
}

// ── 纯求值：graph 完整性（端点∈agents、entry 可达性/孤儿）────────────────────
// agents: [{ id, role, gateway, ingressSource }]；isReservedAgentId 可注入（默认平台判定）。
// entry 定义与 agent-plane-policy 的 runtime-ingress 条件一致：role=bridge | gateway:true | ingressSource。
export function evaluateGraphIntegrity({ graph, agents, isReservedAgentId = isReservedControlLayerAgentId } = {}) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const agentList = Array.isArray(agents) ? agents.filter((a) => a && typeof a.id === "string" && a.id) : [];
  const configuredIds = new Set(agentList.map((a) => a.id));

  const unknownEndpoints = [];
  for (const edge of edges) {
    if (!configuredIds.has(edge.from)) unknownEndpoints.push(`${edge.from}→${edge.to} (from)`);
    if (!configuredIds.has(edge.to)) unknownEndpoints.push(`${edge.from}→${edge.to} (to)`);
  }

  // runtime 平面 = 非保留（operator/viz-master 等 control-plane agent 不进传送带，不算孤儿）。
  const runtimeAgents = agentList.filter((a) => !isReservedAgentId(a.id));
  const entryIds = runtimeAgents
    .filter((a) => {
      const role = typeof a.role === "string" ? a.role.toLowerCase() : "";
      return role === "bridge" || a.gateway === true || Boolean(a.ingressSource);
    })
    .map((a) => a.id);

  // BFS：从所有 entry 出发沿有向边可达的集合。
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  const reached = new Set(entryIds);
  const queue = [...entryIds];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const next of adjacency.get(node) || []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }

  const orphanIds = runtimeAgents
    .filter((a) => !reached.has(a.id))
    .map((a) => a.id);

  return {
    edgeCount: edges.length,
    unknownEndpoints,
    entryIds,
    runtimeAgentIds: runtimeAgents.map((a) => a.id),
    orphanIds,
  };
}

// ── 纯求值：workspace 目录解析（config workspace 支持 ~ 前缀；缺省回落约定目录）──
export function resolveAgentWorkspaceDir(agent, { home = homedir() } = {}) {
  const raw = typeof agent?.workspace === "string" ? agent.workspace.trim() : "";
  if (raw) {
    if (raw === "~" || raw.startsWith("~/")) return resolve(join(home, raw.slice(1)));
    if (isAbsolute(raw)) return resolve(raw);
    return resolve(join(home, ".openclaw", raw));
  }
  return resolve(join(home, ".openclaw", "workspaces", String(agent?.id || "")));
}

// ── 托管 marker 扫描：期望托管文档带 marker；SOUL.md 用户拥有、严禁带 marker ────
// agents: [{ id, role, workspace? }]。返回逐 agent 状态 + 汇总（missing=同步失败；
// custom=用户接管（合法，仅记证据）；soulViolations=平台越权重写用户文件（硬违规））。
export async function scanWorkspaceManagedMarkers({ agents, home = homedir() } = {}) {
  const perAgent = [];
  const soulViolations = [];
  let missingTotal = 0;
  let customTotal = 0;

  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent?.id) continue;
    const workspaceDir = resolveAgentWorkspaceDir(agent, { home });
    const expected = getManagedGuidanceFilesForRole(agent.role);
    const states = { managed: [], custom: [], missing: [] };
    for (const fileName of expected) {
      try {
        const content = await readFile(join(workspaceDir, fileName), "utf8");
        states[content.includes(MANAGED_BOOTSTRAP_MARKER) ? "managed" : "custom"].push(fileName);
      } catch {
        states.missing.push(fileName);
      }
    }
    let soulViolation = false;
    try {
      const soul = await readFile(join(workspaceDir, "SOUL.md"), "utf8");
      soulViolation = soul.includes(MANAGED_BOOTSTRAP_MARKER);
    } catch {
      soulViolation = false; // SOUL.md 可选；缺失不是违规
    }
    if (soulViolation) soulViolations.push(agent.id);
    missingTotal += states.missing.length;
    customTotal += states.custom.length;
    perAgent.push({ agentId: agent.id, role: agent.role || null, workspaceDir, ...states, soulViolation });
  }

  return { perAgent, missingTotal, customTotal, soulViolations };
}

// ── harness 组装校验表（期望码集与 harness-composition.js 真实语义对齐）────────
export const COMPOSITION_SANITY_TABLE = Object.freeze([
  { refs: [], expect: [] },
  { refs: ["harness:gate.test"], expect: ["no_guard", "gate_without_collector"] },
  { refs: ["harness:collector.artifact"], expect: ["no_gate", "no_guard"] },
  {
    refs: ["harness:normalizer.eval_input", "harness:gate.schema", "harness:guard.budget"],
    expect: ["gate_without_collector", "eval_input_without_artifact_collector"],
  },
  { refs: ["harness:guard.budget", "harness:collector.artifact", "harness:gate.test"], expect: [] },
]);

export function evaluateCompositionSanityTable(table = COMPOSITION_SANITY_TABLE) {
  const failures = [];
  for (const row of table) {
    const got = validateHarnessComposition(row.refs).problems.map((p) => p.code).sort();
    const want = [...row.expect].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`refs=[${row.refs.join(",")}] expected [${want.join(",")}] got [${got.join(",")}]`);
    }
  }
  return { failures };
}

// ── 配置文件形状（解析失败要成为 CheckResult 而非 throw，故不复用 infra.loadConfig）─
export function evaluateConfigShape(cfg) {
  const problems = [];
  const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : null;
  if (!agents || agents.length === 0) problems.push("agents.list missing or empty");
  const ids = (agents || []).map((a) => (typeof a?.id === "string" ? a.id.trim() : "")).filter(Boolean);
  if (agents && ids.length !== agents.length) problems.push("agents.list contains entries without id");
  if (new Set(ids).size !== ids.length) problems.push("agents.list ids are not unique");
  if (typeof cfg?.gateway?.auth?.token !== "string" || !cfg.gateway.auth.token.trim()) {
    problems.push("gateway.auth.token missing");
  }
  return { problems, agentCount: ids.length };
}
