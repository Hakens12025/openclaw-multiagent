// lib/formal-runtime/suite-group.js — AgentGroup 宏套件（group 预设,确定性 + 一次 live compose/rollback）
//
// AgentGroup 是图上的「空间」原语（时间维由传送带逐跳推进承担，不再有独立回路运行时）：GroupSpec 宏展开成带 metadata.groupId 的普通
// EdgeSpec（走既有 graph 授权，不造新 transport），加一个运行层 GroupSession。三权分立：装配层
// (agent-group-spec.js 纯函数 validate+展开) / 运行层 (group-session-store.js GroupSession)。
//
// 覆盖：
//   ① 装配层红线（确定性，真跑 normalizeGroupSpec）：<2 成员 / 非法 outputMode / 缺 id → null
//      （不静默猜测）；**非成员的 internalEdge 被丢弃**（v119 安全线：组不开免授权暗门）。
//   ② 宏展开契约（确定性，真跑 expandAgentGroup）：合法 spec → 边带 metadata.groupId + groupSession 描述符。
//   ③ live compose：snapshot → POST graph.group.compose → inspect.agent_groups 反映该 GroupSession。
//   ④ rollback 清理：rollback 还原 graph 边真值（verify drifted=false）→ prune GroupSession → inspect 不再含探针组。
// finally 兜底 prune + rollback：探针组绝不残留（GroupSession 是 research-lab 运行态，不被 rollback 还原，须显式 prune）。

import { runCheck } from "./checks/check-runner.js";
import { gatewayPostJson } from "./checks/check-http.js";
import { loadConfig } from "./infra.js";
import { inspectCliSystemSurface } from "../cli-system/cli-surface-inspector.js";
import { normalizeGroupSpec, expandAgentGroup } from "../agent/agent-group-spec.js";
import { pruneGroupSessionsForTopology } from "../agent/group-session-store.js";

export const PROBE_GROUP_ID = "formal-group-probe";
export const PROBE_MEMBERS = Object.freeze(["worker2", "worker3"]);

// 纯函数：装配层红线（单测直接验，无 IO）。
export function evaluateGroupSpecRedlines() {
  const problems = [];
  if (normalizeGroupSpec({ id: "g", members: ["a"] }) !== null) problems.push("1-member spec not rejected");
  if (normalizeGroupSpec({ id: "g", members: ["a", "b"], outputMode: "bogus" }) !== null) problems.push("bad outputMode not rejected");
  if (normalizeGroupSpec({ members: ["a", "b"] }) !== null) problems.push("missing id not rejected");
  // 授权红线：非成员端点的 internalEdge 必须被丢弃，成员边保留。
  const spec = normalizeGroupSpec({ id: "g", members: ["a", "b"], internalEdges: [{ from: "a", to: "b" }, { from: "a", to: "outsider" }] });
  const edges = spec?.internalEdges || [];
  if (edges.some((e) => e.from === "outsider" || e.to === "outsider")) problems.push("non-member internal edge NOT dropped (authorization backdoor)");
  if (!edges.some((e) => e.from === "a" && e.to === "b")) problems.push("valid member edge was dropped");
  return { ok: problems.length === 0, problems };
}

// 纯函数：宏展开契约（单测直接验）。
export function evaluateGroupExpansion() {
  const { edges, groupSession } = expandAgentGroup({
    id: "g", members: ["a", "b"], internalEdges: [{ from: "a", to: "b" }], outputMode: "aggregate",
  });
  const problems = [];
  if (!groupSession || groupSession.groupId !== "g") problems.push("no groupSession descriptor");
  if (groupSession?.outputMode !== "aggregate") problems.push(`outputMode not carried: ${groupSession?.outputMode}`);
  const edge = edges.find((x) => x.from === "a" && x.to === "b");
  if (!edge) problems.push("member edge missing from expansion");
  else if (edge.metadata?.groupId !== "g") problems.push("edge missing metadata.groupId");
  return { ok: problems.length === 0, problems, edgeCount: edges.length };
}

// inspect.agent_groups 形状容错：数组 | {active,recent} | {groupSessions/sessions/groups}。
export function extractGroupSessions(groups) {
  if (Array.isArray(groups)) return groups;
  if (!groups || typeof groups !== "object") return [];
  const out = [];
  if (groups.active && typeof groups.active === "object") out.push(groups.active);
  for (const key of ["recent", "sessions", "groupSessions", "groups"]) {
    if (Array.isArray(groups[key])) out.push(...groups[key]);
  }
  return out;
}

async function listProbeGroup() {
  const groups = await inspectCliSystemSurface({ surfaceId: "inspect.agent_groups" });
  return extractGroupSessions(groups).find((g) => g?.groupId === PROBE_GROUP_ID) || null;
}

export async function runAgentGroupSuite(run, context) {
  // gatewayPostJson 走 ?token=tokens.gateway 认证；tokens 由 loadConfig 填充（同 operator/knowledge suite）。
  // 漏调 → token 空 → snapshot 请求 Unauthorized → 无 snapshot.id → live 段全 blocked。
  await loadConfig();

  // ① 装配层红线（确定性）
  await runCheck(context, { id: "group.spec-redlines", subsystem: "group", title: "GroupSpec red-lines: reject invalid specs + drop non-member internal edges", code: "E-GRAPH-006" }, async () => {
    const r = evaluateGroupSpecRedlines();
    return r.ok
      ? "normalizeGroupSpec rejects <2 members / bad outputMode / missing id; non-member internal edge dropped (no authorization backdoor)"
      : { status: "fail", evidence: r.problems.join("; ") };
  });

  // ② 宏展开契约（确定性）
  await runCheck(context, { id: "group.macro-expansion", subsystem: "group", title: "expandAgentGroup tags edges with metadata.groupId and yields a groupSession", code: "E-GRAPH-006" }, async () => {
    const r = evaluateGroupExpansion();
    return r.ok
      ? `expandAgentGroup: ${r.edgeCount} edge(s) tagged with metadata.groupId + groupSession descriptor (outputMode carried)`
      : { status: "fail", evidence: r.problems.join("; ") };
  });

  // ③ + ④ live compose → inspect → rollback 清理
  let snapshotId = null;
  try {
    const snap = await gatewayPostJson("/watchdog/control-plane/snapshot", { label: "formal-agent-group-probe", reason: "agent-group suite compose/rollback round-trip" });
    snapshotId = snap.body?.snapshot?.id || null;

    await runCheck(context, { id: "group.compose-live", subsystem: "group", title: "graph.group.compose registers the group in inspect.agent_groups", code: "E-GRAPH-006" }, async () => {
      if (!snapshotId) return { status: "blocked", code: "E-STRUCT-001", evidence: "snapshot not captured; refusing to mutate the graph without a rollback handle" };
      const res = await gatewayPostJson("/watchdog/graph/group/compose", {
        agents: [...PROBE_MEMBERS], groupId: PROBE_GROUP_ID,
        internalEdges: [{ from: PROBE_MEMBERS[0], to: PROBE_MEMBERS[1] }], outputMode: "passthrough",
      });
      if (res.body?.ok !== true) {
        return { status: "fail", evidence: `graph.group.compose failed: status=${res.status} body=${res.rawBody.slice(0, 200)}` };
      }
      const probe = await listProbeGroup();
      if (!probe) return { status: "fail", evidence: `inspect.agent_groups missing "${PROBE_GROUP_ID}" after compose` };
      const membersOk = PROBE_MEMBERS.every((m) => (probe.members || []).includes(m));
      if (!membersOk) return { status: "fail", evidence: `group members mismatch: got ${JSON.stringify(probe.members)}, expected ${JSON.stringify([...PROBE_MEMBERS])}` };
      return `composed "${PROBE_GROUP_ID}" [${(probe.members || []).join(",")}] outputMode=${probe.outputMode || "?"}; inspect.agent_groups reflects the GroupSession`;
    });

    await runCheck(context, { id: "group.rollback-cleanup", subsystem: "structure", title: "Rollback restores graph truth and the probe group is prunable", code: "E-STRUCT-003" }, async () => {
      if (!snapshotId) return { status: "blocked", code: "E-STRUCT-001", evidence: "no snapshot handle from earlier in this run" };
      const rollback = await gatewayPostJson("/watchdog/control-plane/rollback", { snapshotId });
      if (rollback.body?.ok !== true) return { status: "fail", evidence: `rollback failed: status=${rollback.status} body=${rollback.rawBody.slice(0, 200)}` };
      const verify = await gatewayPostJson("/watchdog/control-plane/verify", { snapshotId });
      if (verify.body?.drifted !== false) return { status: "fail", evidence: `post-rollback drifted=${verify.body?.drifted} (graph edges not restored)` };
      // GroupSession 是运行态、不被 rollback 还原 → 显式 prune，再确认 inspect 不再含探针组。
      await pruneGroupSessionsForTopology({ groupIds: [PROBE_GROUP_ID] });
      const lingering = await listProbeGroup();
      if (lingering) return { status: "fail", evidence: `probe group session still present after prune: ${JSON.stringify(lingering.groupId)}` };
      return "rollback restored graph truth (drifted=false); probe GroupSession pruned from inspect.agent_groups";
    });
  } catch (error) {
    context.addCheck({ id: "group.suite-driver", subsystem: "group", title: "Agent group suite driver", status: "fail", code: "E-RUNNER-001", evidence: `threw: ${error?.message || error}`, durationMs: 0 });
  } finally {
    // 兜底清理（幂等）：先 prune 运行态，再 rollback 边真值——探针组绝不残留。
    try { await pruneGroupSessionsForTopology({ groupIds: [PROBE_GROUP_ID] }); } catch { /* best-effort */ }
    if (snapshotId) { try { await gatewayPostJson("/watchdog/control-plane/rollback", { snapshotId }); } catch { /* best-effort */ } }
  }
}
