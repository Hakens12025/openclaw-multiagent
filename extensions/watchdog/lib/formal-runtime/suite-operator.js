// lib/formal-runtime/suite-operator.js — operator 闭环套件（确定性脊柱，LLM 仅末尾一例且可 skip）
//
// 覆盖：① 结构预览（投影 + 非破坏）② 手写 plan 经 operator executor 真 apply + 强制 verify 门
// 元数据 ③ snapshot→mutate→verify drift→rollback→verify match ④ 所有权负探针（viz 写 agents.* 被拒）
// ⑤ 破坏性 surface 无 explicitConfirm 被拒（operator C2 + 原始路由 400 双层）⑥ 可选 LLM plan
// （provider 不可达 → skip E-OPERATOR-SKIP）。所有变更 finally 还原。纯逻辑在 checks/operator-probe.js。

import { markBlocked, runCheck } from "./checks/check-runner.js";
import { gatewayPostJson } from "./checks/check-http.js";
import {
  buildOperatorApplyProbePlan,
  buildOperatorDestructiveProbePlan,
  buildOperatorDryRunProbePlan,
  classifyOperatorPlanResponse,
  evaluateVerifyGateMetadata,
} from "./checks/operator-probe.js";
import { loadConfig } from "./infra.js";
import { hasDirectedEdge, loadGraph } from "../agent/agent-graph.js";
import { AGENT_ROLE, listAgentIdsByRole } from "../agent/agent-identity.js";
import { inspectCliSystemSurface } from "../cli-system/cli-surface-inspector.js";
import { assertActorOwnsSurface } from "../cli-system/meta-agent-surface-ownership.js";

// 候选限定在 4 个工作角色（不碰 bridge/gateway 绑定），找一对当前不存在的有向边做沙箱对。
export async function resolveOperatorProbeEdgePair() {
  const ids = [];
  for (const role of [AGENT_ROLE.PLANNER, AGENT_ROLE.RESEARCHER, AGENT_ROLE.EXECUTOR, AGENT_ROLE.REVIEWER]) {
    for (const agentId of listAgentIdsByRole(role)) {
      if (agentId && !ids.includes(agentId)) ids.push(agentId);
    }
  }
  const graph = await loadGraph();
  for (const from of ids) {
    for (const to of ids) {
      if (from !== to && !hasDirectedEdge(graph, from, to)) return { from, to };
    }
  }
  return null;
}

async function edgeLive(from, to) {
  return hasDirectedEdge(await loadGraph(), from, to);
}

async function countEdges() {
  const graph = await loadGraph();
  return Array.isArray(graph?.edges) ? graph.edges.length : 0;
}

export async function runOperatorSuite(run, context) {
  await loadConfig();
  const state = {
    pair: null,
    scheduleId: `formal-operator-probe-${Date.now()}`,
    probeEdgeLive: false,
    scheduleAttempted: false,
    applyBody: null,
    snapshotId: null,
  };

  try {
    state.pair = await resolveOperatorProbeEdgePair();
  } catch (error) {
    context.addCheck({
      id: "operator.suite-driver", subsystem: "operator", title: "Operator suite driver",
      status: "fail", code: "E-RUNNER-001", evidence: `threw resolving probe pair: ${error?.message || error}`, durationMs: 0,
    });
    return;
  }

  // 依赖「可安全增删的沙箱边」的 check 描述符（具名，markBlocked 与 runCheck 共用同一组 id）。
  const D = {
    previewProjection: { id: "operator.structure-preview-projection", subsystem: "operator", title: "Structure preview projects edge.add" },
    previewNonDestructive: { id: "operator.structure-preview-non-destructive", subsystem: "operator", title: "Structure preview leaves live graph untouched" },
    dryRun: { id: "operator.dry-run-non-destructive", subsystem: "operator", title: "Operator execute dryRun has zero side effects" },
    apply: { id: "operator.apply-via-executor", subsystem: "operator", title: "Hand-built plan applies via operator executor" },
    verifyGate: { id: "operator.forced-verify-gate", subsystem: "operator", title: "Forced verify metadata present after apply" },
    verifyDrift: { id: "structure.verify-detects-drift", subsystem: "structure", title: "Snapshot verify detects a live mutation" },
    rollback: { id: "structure.rollback-restores", subsystem: "structure", title: "Rollback restores the snapshot state" },
  };
  if (!state.pair) {
    markBlocked(context, Object.values(D), "E-RUNNER-005",
      "no missing directed pair among role-resolved work agents (planner/researcher/executor/reviewer) — cannot mutate safely");
  }

  try {
    // ── ① 结构预览 ───────────────────────────────────────────────────────────
    if (state.pair) {
      const { from, to } = state.pair;
      const edgesBefore = await countEdges();
      await runCheck(context, {
        ...D.previewProjection,
        code: "E-INSPECT-003",
        hint: "projectStructureAfter in lib/control-plane/structure-snapshot.js (~L182), served as inspect.structure_preview via lib/cli-system/cli-surface-inspector.js",
      }, async () => {
        const preview = await inspectCliSystemSurface({
          surfaceId: "inspect.structure_preview",
          params: { surfaceId: "graph.edge.add", payload: { from, to } },
        });
        const added = preview?.edgeDiff?.added || [];
        if (!added.includes(`${from}→${to}`)) {
          return { status: "fail", evidence: `edgeDiff.added=${JSON.stringify(added)} missing ${from}→${to}` };
        }
        return `edgeDiff.added includes ${from}→${to}; structural=${preview.structural === true}`;
      });
      await runCheck(context, { ...D.previewNonDestructive, code: "E-STRUCT-004" }, async () => {
        const edgesAfter = await countEdges();
        const probeEdge = await edgeLive(from, to);
        if (probeEdge || edgesAfter !== edgesBefore) {
          return { status: "fail", evidence: `live graph changed after preview: edges ${edgesBefore}→${edgesAfter}, probe edge present=${probeEdge}` };
        }
        return `live graph unchanged (${edgesAfter} edges, probe edge absent)`;
      });
    }

    // ── ④ 所有权负探针（NODE 纯逻辑）─────────────────────────────────────────
    await runCheck(context, {
      id: "operator.ownership-backstop", subsystem: "operator", title: "viz-scope actor refused on agents.* surfaces", code: "E-OPERATOR-006",
    }, async () => {
      let vizRefused = false;
      try {
        assertActorOwnsSurface("viz-master", "agents.create");
      } catch {
        vizRefused = true;
      }
      if (!vizRefused) return { status: "fail", evidence: "assertActorOwnsSurface('viz-master','agents.create') did NOT throw" };
      assertActorOwnsSurface("viz-master", "apply.chart_create"); // 正控制：自有 chart 面必须放行
      let anonymousRefused = false;
      try {
        assertActorOwnsSurface("", "agents.create");
      } catch {
        anonymousRefused = true;
      }
      if (!anonymousRefused) return { status: "fail", evidence: "missing actor was NOT refused" };
      return "viz-master refused on agents.create, allowed on apply.chart_create; anonymous actor refused";
    });

    // ── ⑤ 破坏性 surface 无确认被拒（operator C2 + 原始路由双层）──────────────
    await runCheck(context, {
      id: "operator.destructive-requires-confirm", subsystem: "operator", title: "Destructive step without explicitConfirm refused", code: "E-OPERATOR-003",
    }, async () => {
      const res = await gatewayPostJson("/watchdog/operator/execute", { plan: buildOperatorDestructiveProbePlan() });
      if (res.body?.ok === false && res.body?.blocked === "explicit_confirmation_required") {
        return `refused pre-flight: blocked=${res.body.blocked}, requires=${JSON.stringify(res.body.requiresExplicitConfirm || [])}`;
      }
      return { status: "fail", evidence: `expected blocked=explicit_confirmation_required, got status=${res.status} body=${res.rawBody.slice(0, 200)}` };
    });
    await runCheck(context, {
      id: "confirm.route-gate-schedules-delete", subsystem: "confirm", title: "Raw destructive route 400s without explicitConfirm", code: "E-CONFIRM-001",
    }, async () => {
      const res = await gatewayPostJson("/watchdog/schedules/delete", { scheduleId: "formal-nonexistent-probe" });
      if (res.status === 400 && /confirm/i.test(res.body?.error || "")) {
        return `HTTP 400: ${res.body.error}`;
      }
      return { status: "fail", evidence: `expected 400 'explicit confirmation required', got status=${res.status} body=${res.rawBody.slice(0, 200)}` };
    });

    // ── ③ snapshot → mutate → verify drift → rollback → verify match ─────────
    const snapshotCheck = await runCheck(context, {
      id: "structure.snapshot-capture", subsystem: "structure", title: "Structure snapshot captured", code: "E-STRUCT-001",
    }, async () => {
      const res = await gatewayPostJson("/watchdog/control-plane/snapshot", {
        label: "formal-suite-probe", reason: "operator suite snapshot/rollback round-trip",
      });
      if (res.body?.ok !== true || !res.body?.snapshot?.id) {
        return { status: "fail", evidence: `snapshot create failed: status=${res.status} body=${res.rawBody.slice(0, 200)}` };
      }
      state.snapshotId = res.body.snapshot.id;
      return `snapshot ${state.snapshotId} (hash ${String(res.body.snapshot.contentHash || "").slice(0, 12)})`;
    });

    if (state.pair && snapshotCheck.status === "pass") {
      const { from, to } = state.pair;
      await runCheck(context, { ...D.verifyDrift, code: "E-STRUCT-002" }, async () => {
        const add = await gatewayPostJson("/watchdog/graph/edge/add", { from, to, label: "formal-operator-probe" });
        if (add.body?.ok !== true) {
          return { status: "fail", evidence: `probe mutation (edge add) failed: ${add.rawBody.slice(0, 200)}` };
        }
        state.probeEdgeLive = true;
        const verify = await gatewayPostJson("/watchdog/control-plane/verify", { snapshotId: state.snapshotId });
        if (verify.body?.drifted !== true) {
          return { status: "fail", evidence: `expected drifted=true after edge add, got ${verify.rawBody.slice(0, 200)}` };
        }
        return `mutation ${from}->${to} detected: drifted=true (live ${String(verify.body.liveHash).slice(0, 12)} vs snapshot ${String(verify.body.snapshotHash).slice(0, 12)})`;
      });
      await runCheck(context, { ...D.rollback, code: "E-STRUCT-003" }, async () => {
        const rollback = await gatewayPostJson("/watchdog/control-plane/rollback", { snapshotId: state.snapshotId });
        if (rollback.body?.ok !== true) {
          return { status: "fail", evidence: `rollback failed: status=${rollback.status} body=${rollback.rawBody.slice(0, 200)}` };
        }
        const verify = await gatewayPostJson("/watchdog/control-plane/verify", { snapshotId: state.snapshotId });
        const probeEdge = await edgeLive(from, to);
        if (verify.body?.drifted !== false || probeEdge) {
          return { status: "fail", evidence: `post-rollback drifted=${verify.body?.drifted}, probe edge present=${probeEdge}` };
        }
        state.probeEdgeLive = false;
        return `rollback ${state.snapshotId} restored: drifted=false, probe edge removed`;
      });
    } else if (state.pair) {
      markBlocked(context, [D.verifyDrift, D.rollback], "E-RUNNER-005", "snapshot capture failed earlier in this run");
    }

    // ── ② dryRun 零副作用 + 手写 plan 真 apply + 强制 verify 门 ───────────────
    if (state.pair) {
      const { from, to } = state.pair;
      await runCheck(context, { ...D.dryRun, code: "E-OPERATOR-004" }, async () => {
        const before = await edgeLive(from, to);
        const res = await gatewayPostJson("/watchdog/operator/execute", {
          plan: buildOperatorDryRunProbePlan({ edgeFrom: from, edgeTo: to }), dryRun: true,
        });
        const after = await edgeLive(from, to);
        if (res.body?.ok !== true || res.body?.dryRun !== true) {
          return { status: "fail", evidence: `dryRun response invalid: status=${res.status} body=${res.rawBody.slice(0, 200)}` };
        }
        if (after !== before) {
          return { status: "fail", evidence: `dryRun mutated live graph: edge ${from}->${to} ${before}→${after}` };
        }
        return `dryRun=true echoed, edge ${from}->${to} untouched (present=${after})`;
      });

      const applyCheck = await runCheck(context, { ...D.apply, code: "E-OPERATOR-002" }, async () => {
        state.scheduleAttempted = true;
        const res = await gatewayPostJson("/watchdog/operator/execute", {
          plan: buildOperatorApplyProbePlan({ edgeFrom: from, edgeTo: to, scheduleId: state.scheduleId }),
        }, { timeoutMs: 60000 });
        state.applyBody = res.body;
        if (res.body?.ok !== true) {
          return {
            status: "fail",
            evidence: `apply failed: error=${res.body?.error || res.rawBody.slice(0, 160)} failedSurfaceId=${res.body?.failedSurfaceId || "-"} rollback.ok=${res.body?.rollback?.ok}`,
          };
        }
        state.probeEdgeLive = true;
        const present = await edgeLive(from, to);
        const schedule = res.body?.results?.[1]?.result?.schedule;
        if (!present) return { status: "fail", evidence: "apply reported ok but probe edge is not in the live graph" };
        return `executed ${res.body?.results?.length || 0} steps; edge ${from}->${to} live; schedule ${schedule?.id || state.scheduleId} enabled=${schedule?.enabled === true}`;
      });

      if (applyCheck.status === "pass") {
        await runCheck(context, { ...D.verifyGate, code: "E-OPERATOR-005" }, async () => {
          const verdict = evaluateVerifyGateMetadata(state.applyBody?.verifications);
          return verdict.ok ? verdict.evidence : { status: "fail", evidence: verdict.evidence };
        });
      } else {
        markBlocked(context, [D.verifyGate], "E-RUNNER-005", "apply step failed — verify gate metadata unavailable");
      }
    }

    // ── ⑥ 可选 LLM plan（provider 不可达 → skip）────────────────────────────
    // 先删掉 ② 留下的探针边:llm-plan 的目标复用同一对缺边,若边还活着,operator brain 会
    // 正确地判"边已存在无需执行"→ 0 步,误判 fail(finally 的兜底删除幂等,不受影响)。
    if (state.pair) {
      try { await gatewayPostJson("/watchdog/graph/edge/delete", { from: state.pair.from, to: state.pair.to }); } catch {}
    }
    await runCheck(context, {
      id: "operator.llm-plan", subsystem: "operator", title: "Operator plans from a one-line goal (LLM)", code: "E-OPERATOR-001",
    }, async () => {
      const goalPair = state.pair || { from: "agent-a", to: "agent-b" };
      const res = await gatewayPostJson("/watchdog/operator/plan", {
        message: `请把 ${goalPair.from} 连到 ${goalPair.to}（加一条 graph 边）`,
      }, { timeoutMs: 120000 });
      if (res.status !== 200 || !res.body) {
        return { status: "skip", code: "E-OPERATOR-SKIP", evidence: `plan route unavailable: status=${res.status} body=${res.rawBody.slice(0, 160)}` };
      }
      const verdict = classifyOperatorPlanResponse(res.body);
      if (verdict.outcome === "provider_down") return { status: "skip", code: "E-OPERATOR-SKIP", evidence: verdict.evidence };
      if (verdict.outcome === "plan") return verdict.evidence;
      return { status: "fail", evidence: verdict.evidence };
    });
  } catch (error) {
    context.addCheck({
      id: "operator.suite-driver", subsystem: "operator", title: "Operator suite driver",
      status: "fail", code: "E-RUNNER-001", evidence: `threw: ${error?.message || error}`, durationMs: 0,
    });
  } finally {
    // 全部变更还原（幂等备份层；rollback 成功时探针边已被还原掉）。
    if (state.pair) {
      try {
        const res = await gatewayPostJson("/watchdog/graph/edge/delete", { from: state.pair.from, to: state.pair.to });
        if (state.probeEdgeLive && res.body?.ok !== true && await edgeLive(state.pair.from, state.pair.to)) {
          context.addCheck({
            id: "operator.cleanup-edge", subsystem: "operator", title: "Probe edge cleanup",
            status: "fail", code: "E-GRAPH-004", evidence: `failed to delete probe edge ${state.pair.from}->${state.pair.to}: ${res.rawBody.slice(0, 160)}`, durationMs: 0,
          });
        }
      } catch {}
    }
    if (state.scheduleAttempted) {
      try {
        const res = await gatewayPostJson("/watchdog/schedules/delete", { scheduleId: state.scheduleId, explicitConfirm: true });
        if (res.body?.ok !== true) {
          context.addCheck({
            id: "operator.cleanup-schedule", subsystem: "operator", title: "Probe schedule cleanup",
            status: "fail", code: "E-SCHEDULE-001", evidence: `failed to delete probe schedule ${state.scheduleId}: ${res.rawBody.slice(0, 160)}`, durationMs: 0,
          });
        }
      } catch {}
    }
  }
}
