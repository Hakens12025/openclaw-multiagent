// lib/formal-runtime/checks/health-node.js — health suite TIER-0：零 HTTP、零 LLM 的进程内检查。
//
// 范围：配置解析 / CLI surface 注册表一致性 / harness 目录与组装校验表 /
//   agent-graph 完整性（端点∈配置、零边、孤儿）/ group 宏展开红线 /
//   loop 预算默认值与优先级 / 模型链解析 / 角色 guidance 集 /
//   workspace 托管 marker 扫描 / 错误码注册表自检。
//
// 纯求值逻辑在 health-node-evaluators.js（单测覆盖）；本文件只做 check 接线。
// 约定：计数断言全部是「下界」（系统会增长，不钉死精确值）；fail 必带注册码。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { summarizeCliSystemSurfaces, listCliSystemSurfaces } from "../../cli-system/cli-surface-registry.js";
import { listHarnessModuleCatalog } from "../../harness/harness-module-catalog.js";
import { validateHarnessModuleDefinition } from "../../harness/harness-module-schema.js";
import {
  DEFAULT_LOOP_MAX_ROUNDS,
  DEFAULT_LOOP_MAX_EXPERIMENTS,
  resolveLoopStartBudget,
  buildLoopBudgetEcho,
} from "../../loop/loop-budget.js";
import { normalizeGroupSpec, expandAgentGroup } from "../../agent/agent-group-spec.js";
import { resolveBrainModelChain } from "../../brain-model-resolver.js";
import { getManagedGuidanceFilesForRole, GUIDANCE_FILES } from "../../agent/agent-enrollment-discovery.js";
import { loadGraph } from "../../agent/agent-graph.js";
import { isReservedControlLayerAgentId } from "../../agent/agent-plane-policy.js";
import { ERROR_CODES, getErrorCode, listErrorCodes } from "../error-codes.js";
import { runCheck, markBlocked } from "./check-runner.js";
import {
  SURFACE_REGISTRY_FLOORS,
  ERROR_CODE_REGISTRY_FLOOR,
  evaluateRegistryFloors,
  evaluateGraphIntegrity,
  scanWorkspaceManagedMarkers,
  evaluateCompositionSanityTable,
  evaluateConfigShape,
  COMPOSITION_SANITY_TABLE,
} from "./health-node-evaluators.js";

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

  await runCheck(context, {
    id: "harness.module-catalog",
    subsystem: "harness",
    title: "harness module catalog >=10 modules across all 4 kinds, all valid",
    code: "E-HARNESS-001",
  }, () => {
    const catalog = listHarnessModuleCatalog();
    const kinds = new Set(catalog.map((m) => m.kind));
    const invalid = catalog.filter((m) => !validateHarnessModuleDefinition(m).ok).map((m) => m.id);
    const problems = [];
    if (catalog.length < 10) problems.push(`modules=${catalog.length} below floor 10`);
    for (const kind of ["guard", "collector", "gate", "normalizer"]) {
      if (!kinds.has(kind)) problems.push(`missing kind ${kind}`);
    }
    if (invalid.length > 0) problems.push(`invalid definitions: ${invalid.join(",")}`);
    if (problems.length > 0) return { status: "fail", evidence: problems.join("; ") };
    return `${catalog.length} modules, kinds={${[...kinds].join(",")}}`;
  });

  await runCheck(context, {
    id: "harness.composition-sanity",
    subsystem: "harness",
    title: "validateHarnessComposition sanity table (5 rows)",
    code: "E-HARNESS-003",
  }, () => {
    const { failures } = evaluateCompositionSanityTable();
    if (failures.length > 0) return { status: "fail", evidence: failures.join(" | ") };
    return `${COMPOSITION_SANITY_TABLE.length} rows matched expected problem codes`;
  });

  // graph 三连：需要 cfg；解析失败则 block。
  const graphDescriptors = [
    { id: "graph.edges-exist", subsystem: "graph", title: "agent graph has at least one edge", code: "E-GRAPH-002" },
    { id: "graph.endpoints-configured", subsystem: "graph", title: "every graph edge endpoint is a configured agent", code: "E-GRAPH-001" },
    { id: "graph.reachability", subsystem: "graph", title: "every runtime agent reachable from an entry/bridge node", code: "E-GRAPH-003" },
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
    await runCheck(context, graphDescriptors[2], () => {
      if (integrity.entryIds.length === 0) {
        return { status: "fail", evidence: "no entry node (role bridge / gateway:true / ingressSource) configured" };
      }
      if (integrity.orphanIds.length > 0) {
        return {
          status: "fail",
          evidence: `orphans (unreachable from entries [${integrity.entryIds.join(",")}]): ${integrity.orphanIds.join(", ")}`,
        };
      }
      return `${integrity.runtimeAgentIds.length} runtime agents reachable from entries [${integrity.entryIds.join(",")}]`;
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

  await runCheck(context, {
    id: "loop.budget-defaults",
    subsystem: "loop",
    title: "loop budget default=3 + precedence DEFAULT<LoopSpec<budget<config",
    code: "E-LOOP-002",
  }, () => {
    const problems = [];
    const dflt = resolveLoopStartBudget({});
    if (dflt.maxRounds !== DEFAULT_LOOP_MAX_ROUNDS || dflt.maxRounds !== 3) problems.push(`default maxRounds=${dflt.maxRounds} != 3`);
    if (dflt.maxExperiments !== DEFAULT_LOOP_MAX_EXPERIMENTS) problems.push(`default maxExperiments=${dflt.maxExperiments}`);
    if (resolveLoopStartBudget({}, { loopSpec: { maxRounds: 5 } }).maxRounds !== 5) problems.push("LoopSpec cap did not override default");
    if (resolveLoopStartBudget({ budget: { maxRounds: 7 } }, { loopSpec: { maxRounds: 5 } }).maxRounds !== 7) problems.push("runtime budget did not override LoopSpec");
    if (resolveLoopStartBudget({ budget: { maxRounds: 7 }, maxRounds: 2 }, { loopSpec: { maxRounds: 5 } }).maxRounds !== 2) problems.push("explicit config did not win");
    const echo = buildLoopBudgetEcho(null, {});
    if (echo.budgetSource.maxRounds !== "default" || echo.resolvedBudget.maxRounds !== 3) problems.push("undeclared echo != default/3");
    if (problems.length > 0) return { status: "fail", evidence: problems.join("; ") };
    return "default 3/30; precedence chain holds; echo source=default";
  });

  const cfgDependent = [
    { id: "model.brain-chain", subsystem: "model", title: "brain model chain resolves >=1 credentialed provider", code: "E-MODEL-001" },
    { id: "prompt.managed-markers", subsystem: "prompt", title: "SOUL.md never carries the managed marker", code: "E-PROMPT-004" },
    { id: "guidance.managed-files-present", subsystem: "guidance", title: "per-role managed guidance files exist in workspaces", code: "E-GUIDANCE-001" },
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
  }

  await runCheck(context, {
    id: "guidance.role-sets",
    subsystem: "guidance",
    title: "getManagedGuidanceFilesForRole per-role expected sets",
    code: "E-GUIDANCE-001",
  }, () => {
    const problems = [];
    for (const role of ["executor", "researcher", "reviewer", "planner"]) {
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

  return { cfg };
}
