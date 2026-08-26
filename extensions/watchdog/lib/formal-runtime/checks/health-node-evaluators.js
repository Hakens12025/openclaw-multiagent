// lib/formal-runtime/checks/health-node-evaluators.js — health TIER-0 纯求值层。
//
// 全部无 HTTP、确定性；除 marker 扫描读文件外无副作用。被 health-node.js 接线消费，
// 被 tests/suite-health-node.test.js 封闭单测（合成 fixture / 临时目录）。

import { readFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

import { getManagedGuidanceFilesForRole } from "../../agent/agent-enrollment-discovery.js";
import { TRACE_SENTINELS } from "../../evidence/trace-event-schema.js";
import { MANAGED_BOOTSTRAP_MARKER } from "../../prompt/managed-doc-markers.js";
import { isReservedControlLayerAgentId } from "../../agent/agent-plane-policy.js";
import { readTopLevelTools } from "../../agent/agent-binding-store-read.js";
import { uniqueTools } from "../../core/normalize.js";

// ── 下界快照（只会增长，缩水=有人删了 surface）─────────────────────────────────
// 2026-06-10 实测 120/52/60/3。2026-08-18 回路退役（B4/B5 删掉 graph.loop.* /
// runtime.loop.start / inspect.loop_sessions 等整族 surface）后重新实测 116。
// 2026-08-23 harness 全退役（备忘录149 batch0：inspect.harness_runs /
// inspect.harness_catalog 两个 runtime_inspect surface 摘除）后重新实测 114：
// total 114 · operatorExecutable 44 · executable 93 · inspect 52 · apply 54。
export const SURFACE_REGISTRY_FLOORS = Object.freeze({
  total: 114,
  operatorExecutable: 44,
  executable: 93,
  byFamily: Object.freeze({ hook: 2, observe: 3, inspect: 52, apply: 54, verify: 3 }),
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

  return {
    edgeCount: edges.length,
    unknownEndpoints,
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

// ── 证据链抽样策略（spec §3：证据不足反复出现 = 系统健康信号，盯桥不盯 agent）────
// 样本不足只判 pass——账本少说明系统没跑够，升格 fail 必须建立在足量近期样本上。
export const EVIDENCE_LEDGER_POLICY = Object.freeze({
  sampleLimit: 20,               // 最多抽最近 N 个样本
  minSamples: 4,                 // 低于此样本量只记录、免于判定
  maxIncompleteRatio: 0.5,       // incomplete/sampled 达到此比例 → 证据桥可疑
  possiblyLiveWindowMs: 5 * 60_000, // 最后事件 ts 落在此窗口内的会话视为可能仍在写入，接线层剔除
});

// ── 纯求值：会话账本抽样完整率（samples: [{ name, records }]，records 为
//    records DB trace_event 的 payload 序列）──────────────────────────────────
// 完整性判定 = 哨兵 + seq 连续（文件账退役批:哈希链已随文件层退役，完整性
// 由 (sessionKey,seq) 唯一索引 + 本判定守）。
export function evaluateTraceLedgerSample(samples = [], policy = EVIDENCE_LEDGER_POLICY) {
  const list = Array.isArray(samples) ? samples : [];
  const incomplete = [];
  for (const sample of list) {
    const reason = firstTraceIncompletenessReason(sample?.records);
    if (reason) incomplete.push(`${sample?.name || "unknown"}(${reason})`);
  }
  const sampled = list.length;
  const ratio = sampled > 0 ? incomplete.length / sampled : 0;
  const sufficient = sampled >= policy.minSamples;
  return {
    sampled,
    incompleteCount: incomplete.length,
    incomplete,
    ratio,
    sufficient,
    exceeded: sufficient && ratio >= policy.maxIncompleteRatio,
  };
}

function firstTraceIncompletenessReason(records) {
  if (!Array.isArray(records) || records.length === 0) return "empty trace";
  for (let i = 0; i < records.length; i++) {
    if (!Number.isInteger(records[i]?.seq) || records[i].seq !== i) return `seq gap at ${i}`;
  }
  if (records[0]?.kind !== TRACE_SENTINELS.OPEN) return "missing open sentinel";
  if (records[records.length - 1]?.kind !== TRACE_SENTINELS.CLOSE) return "missing close sentinel";
  return null;
}

// ── P4 协作工具面挂载(授权真值=collaboration-intent-policy;caller 负责
//    预过滤 control-plane 保留 agent 并从策略构造 requiredByRole)──────────────
export function evaluateCollabToolMounting({ agents, requiredByRole }) {
  const problems = [];
  let covered = 0;
  for (const agent of Array.isArray(agents) ? agents : []) {
    const required = requiredByRole?.[agent?.role] || [];
    if (required.length === 0) continue;
    const named = new Set([
      ...readTopLevelTools(agent),
      ...uniqueTools(Array.isArray(agent?.tools?.alsoAllow) ? agent.tools.alsoAllow : []),
    ]);
    const blanket = named.has("watchdog") || named.has("group:plugins");
    const missing = blanket ? [] : required.filter((tool) => !named.has(tool));
    if (missing.length > 0) {
      problems.push(`${agent.id}(${agent.role}): missing ${missing.join(",")}`);
    } else {
      covered += 1;
    }
  }
  return { problems, covered };
}
