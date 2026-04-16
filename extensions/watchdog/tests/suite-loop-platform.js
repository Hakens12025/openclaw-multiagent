// tests/suite-loop-platform.js — T2 platform scenario tests for explicit loop control-plane start

import { runLoopDirectCase } from "./suite-loop-direct.js";
import {
  AGENT_ROLE,
  getAgentRole,
  listAgentIdsByRole,
  listRuntimeAgentIds,
} from "../lib/agent/agent-identity.js";

export const LOOP_PLATFORM_CASES = [
  {
    id: "real-user-loop-start",
    description: "T2 平台场景：显式控制面启动已登记 loop，并把真实任务送入当前 entry agent 首阶段。",
    message: "帮我做一下某个卡夫曼算法的优化",
    timeoutMs: 240000,
    expectedPath: "loop-platform",
    loopId: "t2-loop-platform",
    scenario: "平台显式 loop 启动",
    businessSemantics: "验证 loop 只能由显式控制面入口启动，不经过 contractor 抬升。",
    transportPath: ["graph.loop.compose", "runtime.loop.start", "conveyor.dispatch", "loop engine", "lifecycle.commit"],
    expectedRuntimeTruth: ["loop truth registered", "runtime loop start accepted", "pipeline truth activated", "entry stage owned by entry agent", "heartbeat targets entry agent"],
    coverage: ["loop_control_plane", "pipeline_truth", "entry_dispatch", "frontend_visibility"],
  },
];

const CHECKPOINT_META = {
  D0: {
    id: "P0",
    name: "Loop truth registered",
    subsystem: "loop-precondition",
    conclusion: "显式 loop 真值没有正确登记或未激活。",
    suggestedFix: "检查 graph.loop.compose、loop registry 落盘与 active entry agent。",
  },
  D1: {
    id: "P1",
    name: "Explicit loop start accepted",
    subsystem: "loop-start",
    conclusion: "控制面显式 loop 启动没有被 runtime 接受。",
    suggestedFix: "检查 runtime.loop.start 参数、entry agent 解析与 surface 调用。",
  },
  D2: {
    id: "P2",
    name: "Pipeline truth matches loop start",
    subsystem: "pipeline-truth",
    conclusion: "pipeline_state 或 loop_session_state 与显式 loop 启动真值不一致。",
    suggestedFix: "检查 startPipeline、savePipeline 与 loop session 写入。",
  },
  D3: {
    id: "P3",
    name: "First stage is entry agent only",
    subsystem: "entry-dispatch",
    conclusion: "首阶段没有直接落到当前 entry agent，或者 contractor 仍被卷入。",
    suggestedFix: "检查 direct entry dispatch、runtime direct inbox 与首阶段合同写入。",
  },
  D4: {
    id: "P4",
    name: "Heartbeat targets entry agent",
    subsystem: "loop-wake",
    conclusion: "显式 loop 启动后没有正确唤醒当前 entry agent。",
    suggestedFix: "检查 requestHeartbeatNow 调用与 entry agent 目标解析。",
  },
};

function uniqueAgentIds(ids) {
  const result = [];
  for (const agentId of ids) {
    if (typeof agentId !== "string" || !agentId.trim() || result.includes(agentId)) continue;
    result.push(agentId);
  }
  return result;
}

export function resolveLoopPlatformTopology() {
  const workAgentIds = uniqueAgentIds([
    ...listAgentIdsByRole(AGENT_ROLE.PLANNER),
    ...listAgentIdsByRole(AGENT_ROLE.RESEARCHER),
    ...listAgentIdsByRole(AGENT_ROLE.EXECUTOR),
    ...listAgentIdsByRole(AGENT_ROLE.REVIEWER),
    ...listRuntimeAgentIds().filter((agentId) => getAgentRole(agentId) !== AGENT_ROLE.BRIDGE),
  ]);
  const loopAgents = workAgentIds.slice(0, Math.min(3, workAgentIds.length));
  return {
    entryAgentId: loopAgents[0] || null,
    loopAgents,
    blockedReason: loopAgents.length < 2
      ? "loop-platform preset requires at least 2 non-bridge work agents"
      : null,
  };
}

function trimDetail(value, limit = 360) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function resultLabel(result) {
  if (result.pass) return "PASS";
  if (result.blocked) return "BLOCKED";
  return "FAIL";
}

function mapDirectCheckpoint(checkpoint) {
  const meta = CHECKPOINT_META[checkpoint.id] || null;
  return {
    ...checkpoint,
    id: meta?.id || checkpoint.id,
    name: meta?.name || checkpoint.name,
    errorCode: checkpoint.errorCode || (checkpoint.status === "FAIL" ? meta?.id || checkpoint.id : undefined),
  };
}

export async function runLoopPlatformTest(testCase, _sse = null) {
  const topology = resolveLoopPlatformTopology();
  if (topology.blockedReason) {
    return {
      testCase,
      duration: "0.0",
      pass: false,
      blocked: true,
      results: [
        {
          id: "blocked",
          name: "Runtime topology",
          status: "BLOCKED",
          elapsed: "0.0",
          detail: topology.blockedReason,
          errorCode: "P-TOPOLOGY",
        },
      ],
      contractRuntime: {
        loopTopology: topology,
      },
    };
  }
  const directResult = await runLoopDirectCase({
    id: testCase.id,
    description: testCase.description,
    message: testCase.message,
    loopId: testCase.loopId,
    loopAgents: topology.loopAgents,
    entryAgentId: topology.entryAgentId,
  });

  return {
    ...directResult,
    testCase,
    contractId: directResult.startResult?.contractId || directResult.entryAgentContract?.id || null,
    results: Array.isArray(directResult.results)
      ? directResult.results.map(mapDirectCheckpoint)
      : [],
    contractRuntime: {
      pipelineState: directResult.pipelineSnapshot || null,
      loopSession: directResult.loopSessionSnapshot || null,
      entryAgentContract: directResult.entryAgentContract || null,
      contractorContract: directResult.contractorContract || null,
      loopTopology: topology,
    },
  };
}

export function summarizeLoopPlatformDiagnosis(result) {
  const issue = Array.isArray(result?.results)
    ? result.results.findLast((entry) => entry.status === "FAIL" || entry.status === "BLOCKED")
    : null;
  if (!issue) return null;
  const meta = Object.values(CHECKPOINT_META).find((entry) => entry.id === issue.id) || null;
  return {
    errorCode: issue.errorCode || issue.id || "UNKNOWN",
    subsystem: meta?.subsystem || "unknown",
    conclusion: meta?.conclusion || "平台显式 loop 测试在该检查点失败。",
    suggestedFix: meta?.suggestedFix || "检查该检查点对应的 runtime 真值与最近变更。",
    evidence: trimDetail(issue.detail || ""),
    inferred: null,
  };
}

export function generateLoopPlatformReport(testResults, totalDuration) {
  const lines = [];
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const passed = testResults.filter((result) => result.pass).length;
  const failed = testResults.filter((result) => !result.pass && !result.blocked).length;
  const blocked = testResults.filter((result) => result.blocked).length;

  lines.push("══════════════════════════════════════════════════");
  lines.push(" OPENCLAW LOOP PLATFORM REPORT");
  lines.push(` Run: ${now}  Duration: ${totalDuration}s`);
  lines.push(` Tests: ${testResults.length} | Passed: ${passed} | Failed: ${failed} | Blocked: ${blocked}`);
  lines.push("══════════════════════════════════════════════════");
  lines.push("");

  for (const result of testResults) {
    lines.push(`── TEST: ${result.testCase.id} ──`);
    lines.push(`Scenario: ${result.testCase.scenario || result.testCase.description}`);
    lines.push(`Business Semantics: ${result.testCase.businessSemantics || result.testCase.description}`);
    lines.push(`Message: ${result.testCase.message}`);
    lines.push(`Duration: ${result.duration}s  Result: ${resultLabel(result)}`);
    lines.push("");

    for (const checkpoint of result.results || []) {
      const statusStr = `[${checkpoint.status}]`.padEnd(8);
      const nameStr = checkpoint.name.padEnd(32);
      const elapsedStr = `${checkpoint.elapsed}s`.padStart(6);
      let line = `  ${statusStr} ${checkpoint.id} ${nameStr} ${elapsedStr}`;
      if (checkpoint.detail) line += `  ${checkpoint.detail}`;
      lines.push(line);
    }

    if (result.startResult) lines.push(`  StartResult: ${trimDetail(result.startResult)}`);
    if (result.pipelineSnapshot) lines.push(`  Pipeline: ${trimDetail(result.pipelineSnapshot)}`);
    if (result.loopSessionSnapshot) lines.push(`  LoopSession: ${trimDetail(result.loopSessionSnapshot)}`);
    if (result.entryAgentContract) lines.push(`  EntryAgentContract: ${trimDetail(result.entryAgentContract)}`);
    if (result.contractorContract) lines.push(`  ContractorContract: ${trimDetail(result.contractorContract)}`);
    if (result.heartbeatCalls) lines.push(`  HeartbeatCalls: ${trimDetail(result.heartbeatCalls)}`);
    lines.push("");
  }

  lines.push("══════════════════════════════════════════════════");
  lines.push(` SUMMARY: ${passed}/${testResults.length} PASSED  ${failed} FAILED  ${blocked} BLOCKED`);
  lines.push("══════════════════════════════════════════════════");
  return lines.join("\n");
}
