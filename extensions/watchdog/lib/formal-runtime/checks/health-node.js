// lib/formal-runtime/checks/health-node.js — health suite TIER-0：零 HTTP、零 LLM 的进程内检查。
//
// 范围：配置解析 / CLI surface 注册表一致性 /
//   agent-graph 完整性（端点∈配置、零边、孤儿）/ group 宏展开红线 /
//   模型链解析 / 角色 guidance 集 /
//   workspace 托管 marker 扫描 / 证据链账本抽样完整率 / 错误码注册表自检。
// （harness 目录与组装校验表已随 harness 全退役删除，v226 / 2026-08-23，备忘录149）
//
// 纯求值逻辑在 health-node-evaluators.js（单测覆盖）；本文件只做 check 接线。
// 约定：计数断言全部是「下界」（系统会增长，不钉死精确值）；fail 必带注册码。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { summarizeCliSystemSurfaces, listCliSystemSurfaces } from "../../cli-system/cli-surface-registry.js";
import { normalizeGroupSpec, expandAgentGroup } from "../../agent/agent-group-spec.js";
import { resolveBrainModelChain } from "../../llm/brain-model-resolver.js";
import { getManagedGuidanceFilesForRole, GUIDANCE_FILES } from "../../agent/agent-enrollment-discovery.js";
import { loadGraph } from "../../agent/agent-graph.js";
import { isReservedControlLayerAgentId } from "../../agent/agent-plane-policy.js";
import { ERROR_CODES, getErrorCode, listErrorCodes } from "../error-codes.js";
import { runCheck, markBlocked } from "./check-runner.js";
import {
  SURFACE_REGISTRY_FLOORS,
  ERROR_CODE_REGISTRY_FLOOR,
  EVIDENCE_LEDGER_POLICY,
  evaluateRegistryFloors,
  evaluateGraphIntegrity,
  scanWorkspaceManagedMarkers,
  evaluateConfigShape,
  evaluateCollabToolMounting,
  evaluateTraceLedgerSample,
} from "./health-node-evaluators.js";
import {
  listRecentTraceSessions,
  tryReadTraceEventsFromDb,
} from "../../record-plane/record-reader.js";
import { listExposedToolIntents } from "../../system-action/collaboration-intent-policy.js";
import { listAllowedActionTypesForRole } from "../../system-action/system-action-role-policy.js";


// ── 接线：TIER-0 检查序列。返回 { cfg }（解析失败 → null，gateway 层据此 block）──
export async function runHealthNodeChecks(run, context) {
  const configFile = join(homedir(), ".openclaw", "openclaw.json");
  let cfg = null;

  await runCheck(context, {
    id: "config.parse",
    subsystem: "config",
    title: "openclaw.json parses with agents.list + gateway token",
    code: "E-CONFIG-001",
  }, async () => {
    const parsed = JSON.parse(await readFile(configFile, "utf8"));
    const { problems, agentCount } = evaluateConfigShape(parsed);
    if (problems.length > 0) {
      return { status: "fail", evidence: problems.join("; ") };
    }
    cfg = parsed;
    return `${agentCount} agents configured, gateway token present`;
  });

  await runCheck(context, {
    id: "inspect.surface-registry",
    subsystem: "inspect",
    title: "CLI surface registry floors + family partition consistent",
    code: "E-INSPECT-004",
  }, () => {
    const { counts } = summarizeCliSystemSurfaces();
    const { problems } = evaluateRegistryFloors(counts);
    const inspectSurfaces = listCliSystemSurfaces({ family: "inspect" });
    const runtimeInspect = inspectSurfaces.filter((s) => s.source === "runtime_inspect");
    const badSource = inspectSurfaces.filter((s) => s.source !== "runtime_inspect" && s.source !== "admin_surface");
    if (runtimeInspect.length < SURFACE_REGISTRY_FLOORS.runtimeInspectSources) {
      problems.push(`runtime_inspect sources=${runtimeInspect.length} below floor ${SURFACE_REGISTRY_FLOORS.runtimeInspectSources}`);
    }
    if (badSource.length > 0) {
      problems.push(`inspect surfaces with unexpected source: ${badSource.map((s) => `${s.id}(${s.source})`).join(",")}`);
    }
    if (problems.length > 0) return { status: "fail", evidence: problems.join("; ") };
    return `total=${counts.total} byFamily=${JSON.stringify(counts.byFamily)} runtime_inspect=${runtimeInspect.length}`;
  });

  // graph 两连：需要 cfg；解析失败则 block。
  //
  // 2026-08-19 删除第三连 graph.reachability(E-GRAPH-003 "agent 必须从入口可达")：
  // 它的前提在动态派工时代已不成立 —— 不在图上【不等于】收不到活。live collab 44/44
  // 实证：当时 worker 与 reviewer1 都不在图上，照样被 assign_task / request_review 派到活并
  // 跑完全链；协作授权单源是 collaboration-intent-policy 的角色表，不是图。
  // 图边只管固定管线与传送带投递授权，"图上没有"是合法状态而非缺陷，
  // 该检查报的是假警报（用户 2026-08-19 裁定删除）。
  const graphDescriptors = [
    { id: "graph.edges-exist", subsystem: "graph", title: "agent graph has at least one edge", code: "E-GRAPH-002" },
    { id: "graph.endpoints-configured", subsystem: "graph", title: "every graph edge endpoint is a configured agent", code: "E-GRAPH-001" },
  ];
  if (!cfg) {
    markBlocked(context, graphDescriptors, "E-RUNNER-005", "config.parse failed — graph integrity needs agents.list");
  } else {
    const graph = await loadGraph();
    const integrity = evaluateGraphIntegrity({ graph, agents: cfg.agents.list });
    await runCheck(context, graphDescriptors[0], () => {
      if (integrity.edgeCount === 0) return { status: "fail", evidence: "agent-graph.json has 0 edges (reset residue)" };
      return `${integrity.edgeCount} edges`;
    });
    await runCheck(context, graphDescriptors[1], () => {
      if (integrity.unknownEndpoints.length > 0) {
        return { status: "fail", evidence: `unknown endpoints: ${integrity.unknownEndpoints.join(", ")}` };
      }
      return `${integrity.edgeCount} edges, all endpoints in agents.list`;
    });
  }

  await runCheck(context, {
    id: "graph.group-spec",
    subsystem: "graph",
    title: "agent-group macro expansion + undeclared-edge redline",
    code: "E-GRAPH-006",
  }, () => {
    const problems = [];
    const expanded = expandAgentGroup({
      id: "health-probe-group",
      members: ["a1", "a2"],
      entry: "a1",
      internalEdges: [{ from: "a1", to: "a2" }, { from: "a1", to: "outsider" }],
      outputMode: "aggregate",
    });
    if (expanded.edges.length !== 1) problems.push(`expected 1 internal edge (outsider edge rejected), got ${expanded.edges.length}`);
    if (expanded.edges[0]?.metadata?.groupId !== "health-probe-group") problems.push("expanded edge lacks metadata.groupId");
    if (expanded.groupSession?.outputMode !== "aggregate") problems.push("groupSession outputMode lost");
    if (expanded.outputPolicies?.a1?.aggregateGroup !== "health-probe-group") problems.push("entry outputPolicy lacks aggregateGroup");
    if (normalizeGroupSpec({ id: "x", members: ["only-one"] }) !== null) problems.push("spec with <2 members not rejected");
    if (normalizeGroupSpec({ id: "x", members: ["a", "b"], outputMode: "bogus" }) !== null) problems.push("bogus outputMode not rejected");
    if (normalizeGroupSpec({ id: "x", members: ["a", "b"] })?.outputMode !== "aggregate") problems.push("default outputMode != aggregate");
    if (problems.length > 0) return { status: "fail", evidence: problems.join("; ") };
    return "expansion + redline table passed (7 assertions)";
  });

  const cfgDependent = [
    { id: "model.brain-chain", subsystem: "model", title: "brain model chain resolves >=1 credentialed provider", code: "E-MODEL-001" },
    { id: "prompt.managed-markers", subsystem: "prompt", title: "SOUL.md never carries the managed marker", code: "E-PROMPT-004" },
    { id: "guidance.managed-files-present", subsystem: "guidance", title: "per-role managed guidance files exist in workspaces", code: "E-GUIDANCE-001" },
    { id: "config.collab-tool-mount", subsystem: "config", title: "collab tool face mounted per role policy (P4 binding)", code: "E-CONFIG-002" },
  ];
  if (!cfg) {
    markBlocked(context, cfgDependent, "E-RUNNER-005", "config.parse failed — needs parsed openclaw.json");
  } else {
    await runCheck(context, cfgDependent[0], () => {
      const chain = resolveBrainModelChain(cfg);
      if (chain.length === 0) return { status: "fail", evidence: "resolveBrainModelChain returned empty (no credentialed openai-completions provider)" };
      return `chain length ${chain.length}: ${chain.map((m) => m.fullRef).join(" -> ")}`;
    });
    // 扫描范围对齐平台写入面：syncAllRuntimeWorkspaceGuidance 只 seed runtime 平面，
    // control-plane 保留 agent（operator/viz-master 等）不被 seed，不能要求其带托管文档。
    const runtimeAgents = cfg.agents.list.filter((a) => a?.id && !isReservedControlLayerAgentId(a.id));
    const scan = await scanWorkspaceManagedMarkers({ agents: runtimeAgents });
    await runCheck(context, cfgDependent[1], () => {
      if (scan.soulViolations.length > 0) {
        return { status: "fail", evidence: `SOUL.md carries managed marker for: ${scan.soulViolations.join(", ")}` };
      }
      return `${scan.perAgent.length} workspaces scanned, no SOUL.md marker violation`;
    });
    await runCheck(context, cfgDependent[2], () => {
      const missing = scan.perAgent.filter((a) => a.missing.length > 0)
        .map((a) => `${a.agentId}: ${a.missing.join(",")}`);
      if (missing.length > 0) return { status: "fail", evidence: missing.join(" | ") };
      const customNote = scan.customTotal > 0 ? `; ${scan.customTotal} user-takeover (custom, allowed)` : "";
      return `all expected managed files present across ${scan.perAgent.length} agents${customNote}`;
    });
    await runCheck(context, cfgDependent[3], () => {
      // 授权真值派生 requiredByRole;bridge 豁免(hook 会话全锁,工具面不可用),
      // control-plane 保留 agent(operator/viz-master)不在 runtime 协作面。
      const exposed = listExposedToolIntents();
      const requiredByRole = {};
      for (const agent of runtimeAgents) {
        const role = agent?.role;
        if (!role || role === "bridge" || requiredByRole[role]) continue;
        const allowed = new Set(listAllowedActionTypesForRole(role));
        requiredByRole[role] = exposed.filter((intent) => allowed.has(intent));
      }
      const verdict = evaluateCollabToolMounting({ agents: runtimeAgents, requiredByRole });
      if (verdict.problems.length > 0) return { status: "fail", evidence: verdict.problems.join(" | ") };
      return `${verdict.covered} collaborating agents mounted (${exposed.join(", ")})`;
    });
  }

  await runCheck(context, {
    id: "guidance.role-sets",
    subsystem: "guidance",
    title: "getManagedGuidanceFilesForRole per-role expected sets",
    code: "E-GUIDANCE-001",
  }, () => {
    const problems = [];
    for (const role of ["executor", "researcher", "planner"]) {
      const files = getManagedGuidanceFilesForRole(role);
      if (JSON.stringify([...files]) !== JSON.stringify(["IDENTITY.md", "HEARTBEAT.md"])) {
        problems.push(`${role} -> [${files.join(",")}]`);
      }
    }
    for (const role of ["bridge", "agent"]) {
      const files = getManagedGuidanceFilesForRole(role);
      if (files.length !== GUIDANCE_FILES.length) problems.push(`${role} -> ${files.length} files (expected ${GUIDANCE_FILES.length})`);
    }
    if (problems.length > 0) return { status: "fail", evidence: problems.join("; ") };
    return `execution roles -> 2 files; bridge/agent -> ${GUIDANCE_FILES.length} files`;
  });

  await runCheck(context, {
    id: "toolface.policy-parity",
    subsystem: "toolface",
    title: "tool-face definitions equal intent-policy exposed set",
    code: "E-TOOLFACE-001",
  }, async () => {
    // 动态引入:toolface 拉动运行时依赖面,只在本检查内加载。
    const { listToolFaceDefinitionNames } = await import("../../system-action/collaboration-toolface.js");
    const definitions = [...listToolFaceDefinitionNames()].sort();
    const exposed = [...listExposedToolIntents()].sort();
    if (definitions.join(",") !== exposed.join(",")) {
      return { status: "fail", evidence: `definitions [${definitions.join(",")}] != exposed intents [${exposed.join(",")}]` };
    }
    return `tool face = ${exposed.join(", ")}`;
  });

  await runCheck(context, {
    id: "toolface.platform-service-parity",
    subsystem: "toolface",
    title: "platform-service tool face equals the service table's exposed set",
    code: "E-TOOLFACE-002",
  }, async () => {
    const { listPlatformServiceToolFaceNames } = await import("../../system-action/platform-service-toolface.js");
    const { listExposedPlatformServiceTools } = await import("../../system-action/platform-service-tools.js");
    const definitions = [...listPlatformServiceToolFaceNames()].sort();
    const exposed = [...listExposedPlatformServiceTools()].sort();
    if (definitions.join(",") !== exposed.join(",")) {
      return { status: "fail", evidence: `tool face [${definitions.join(",")}] != exposed service tools [${exposed.join(",")}]` };
    }
    return `platform service tool face = ${exposed.join(", ")}`;
  });

  // ── 证据链健康（spec §3：证据不足反复出现升格为系统信号；码盯桥不盯 agent）────
  await runCheck(context, {
    id: "evidence.trace-ledger-sample",
    subsystem: "evidence",
    title: "sampled recent session trace ledgers structurally complete",
    code: "E-EVIDENCE-001",
  }, async () => {
    // 文件账退役批:抽样源 = records DB 的 trace_event(按会话最后落账 id 倒序)。
    const sessions = listRecentTraceSessions({ limit: EVIDENCE_LEDGER_POLICY.sampleLimit * 2 });
    if (sessions === null) {
      return "records db absent — 0 samples, completeness not judged";
    }
    const liveCutoffMs = Date.now() - EVIDENCE_LEDGER_POLICY.possiblyLiveWindowMs;
    // 仍在写入窗口内的会话天然缺 close 哨兵，抽进来会冤枉桥——剔除。
    const candidates = sessions
      .filter((session) => (session.lastTs ?? 0) <= liveCutoffMs)
      .slice(0, EVIDENCE_LEDGER_POLICY.sampleLimit);
    const samples = candidates.map((session) => ({
      name: session.sessionKey,
      records: tryReadTraceEventsFromDb(session.sessionKey) ?? [],
    }));
    const verdict = evaluateTraceLedgerSample(samples);
    if (!verdict.sufficient) {
      return `insufficient sample (${verdict.sampled} < ${EVIDENCE_LEDGER_POLICY.minSamples}) — completeness not judged`;
    }
    if (verdict.exceeded) {
      return {
        status: "fail",
        evidence: `incomplete ${verdict.incompleteCount}/${verdict.sampled} (ratio ${verdict.ratio.toFixed(2)} >= ${EVIDENCE_LEDGER_POLICY.maxIncompleteRatio}): ${verdict.incomplete.slice(0, 5).join("; ")}`,
      };
    }
    return `${verdict.sampled} recent ledgers sampled, ${verdict.incompleteCount} incomplete (ratio ${verdict.ratio.toFixed(2)} < ${EVIDENCE_LEDGER_POLICY.maxIncompleteRatio})`;
  });

  await runCheck(context, {
    id: "runner.error-codes",
    subsystem: "runner",
    title: "error-code registry self-check (format, fields, lookup)",
    code: "E-RUNNER-004",
  }, () => {
    const problems = [];
    const codes = listErrorCodes();
    if (codes.length < ERROR_CODE_REGISTRY_FLOOR) problems.push(`codes=${codes.length} below floor ${ERROR_CODE_REGISTRY_FLOOR}`);
    const format = /^E-[A-Z]+-(?:\d{3}|SKIP)$/;
    for (const { id, subsystem, meaning, hint } of codes) {
      if (!format.test(id)) problems.push(`bad format: ${id}`);
      if (!subsystem || !meaning || !hint) problems.push(`incomplete entry: ${id}`);
    }
    if (!getErrorCode("E-GRAPH-001")) problems.push("getErrorCode(E-GRAPH-001) miss");
    if (getErrorCode("E-NOPE-999") !== null) problems.push("unknown code did not return null");
    if (!Object.isFrozen(ERROR_CODES)) problems.push("ERROR_CODES not frozen");
    if (problems.length > 0) return { status: "fail", evidence: problems.slice(0, 5).join("; ") };
    return `${codes.length} codes registered, format + fields + lookup OK`;
  });

  // kernel.boot-ledger 检查在 health-gateway 层(经 /watchdog/runtime 的 bootDeps 字段读网关进程真实封账态)。
  // 不放本层:TIER-0 跑在 CLI 进程,import 到的 bootLedger 是从未封账的新实例,必然误报。

  return { cfg };
}
