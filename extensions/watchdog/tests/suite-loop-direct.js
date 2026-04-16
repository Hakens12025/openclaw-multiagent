// tests/suite-loop-direct.js — direct loop-start surface regression tests
//
// Focus:
// - do not route through unified ingress or contractor
// - prove runtime.loop.start can push a real task directly into a registered
//   graph-backed loop entry agent
// - assert platform truth on loop runtime, loop session, direct inbox contract,
//   and heartbeat target

import { readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import { OC } from "./infra.js";
import { loadGraph, saveGraph } from "../lib/agent/agent-graph.js";
import { loadGraphLoopRegistry, saveGraphLoopRegistry } from "../lib/loop/graph-loop-registry.js";
import { executeAdminSurfaceOperation } from "../lib/admin/admin-surface-operations.js";
import { loadActiveLoopRuntime } from "../lib/loop/loop-round-runtime.js";
import { LOOP_SESSION_STATE_FILE } from "../lib/loop/loop-session-store.js";
const CONTRACTOR_INBOX = join(OC, "workspaces", "contractor", "inbox");
const CONTRACTOR_CONTRACT_FILE = join(CONTRACTOR_INBOX, "contract.json");

export const LOOP_DIRECT_CASES = [
  {
    id: "direct-loop-start-researcher",
    description: "管理面直接启动已登记 loop，并把真实任务送入当前 entry agent 首阶段，不经过 contractor 草稿抬升。",
    message: "帮我做一下哈夫曼编码优化",
    loopId: "t3-loop-direct-start",
    loopAgents: ["planner", "worker", "worker2"],
    entryAgentId: "planner",
  },
];

function resultLabel(result) {
  if (result.pass) return "PASS";
  if (result.blocked) return "BLOCKED";
  return "FAIL";
}

function trimDetail(value, limit = 360) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function getEntryAgentInbox(entryAgentId) {
  return join(OC, "workspaces", entryAgentId, "inbox");
}

function getEntryAgentContractFile(entryAgentId) {
  return join(getEntryAgentInbox(entryAgentId), "contract.json");
}

async function cleanDirectLoopArtifacts(entryAgentId) {
  await unlink(LOOP_SESSION_STATE_FILE).catch(() => {});
  if (entryAgentId) {
    await rm(getEntryAgentContractFile(entryAgentId), { force: true }).catch(() => {});
    await rm(join(getEntryAgentInbox(entryAgentId), ".runtime-direct-queue"), { recursive: true, force: true }).catch(() => {});
  }
  await rm(CONTRACTOR_CONTRACT_FILE, { force: true }).catch(() => {});
  await rm(join(CONTRACTOR_INBOX, ".runtime-direct-queue"), { recursive: true, force: true }).catch(() => {});
}

export async function runLoopDirectCase(testCase) {
  const entryAgentId = testCase.entryAgentId || testCase.loopAgents?.[0] || null;
  const startMs = Date.now();
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);
  const results = [];
  const heartbeatCalls = [];
  let startResult = null;
  let loopRuntimeSnapshot = null;
  let loopSessionSnapshot = null;
  let entryAgentContract = null;
  let contractorContract = null;

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();

  try {
    await cleanDirectLoopArtifacts(entryAgentId);
    await saveGraph({ edges: [] });
    await saveGraphLoopRegistry({ loops: [] });

    const composed = await executeAdminSurfaceOperation({
      surfaceId: "graph.loop.compose",
      payload: {
        loopId: testCase.loopId,
        label: "direct loop start regression",
        agents: testCase.loopAgents,
      },
      logger: console,
      runtimeContext: null,
    });
    const resolvedLoop = composed?.loop || null;
    if (resolvedLoop?.active !== true || resolvedLoop?.entryAgentId !== entryAgentId) {
      results.push({
        id: "D0",
        name: "Loop truth registered",
        status: "FAIL",
        elapsed: elapsed(),
        detail: trimDetail({ composed, resolvedLoop }),
      });
      return {
        testCase,
        results,
        duration: elapsed(),
        pass: false,
      };
    }
    results.push({
      id: "D0",
      name: "Loop truth registered",
      status: "PASS",
      elapsed: elapsed(),
      detail: `${resolvedLoop.id} ${resolvedLoop.nodes.join(" -> ")}`,
    });

    startResult = await executeAdminSurfaceOperation({
      surfaceId: "runtime.loop.start",
      payload: {
        loopId: testCase.loopId,
        requestedTask: testCase.message,
        startAgent: entryAgentId,
      },
      logger: console,
      runtimeContext: {
        api: {
          runtime: {
            system: {
              requestHeartbeatNow(payload) {
                heartbeatCalls.push(payload);
              },
            },
          },
        },
        enqueue: () => {},
        originSurfaceId: "runtime.loop.start",
        originDraftId: null,
        originExecutionId: null,
      },
    });
    if (startResult?.action !== "started" || startResult?.targetAgent !== entryAgentId) {
      results.push({
        id: "D1",
        name: "Direct loop start accepted",
        status: "FAIL",
        elapsed: elapsed(),
        detail: trimDetail(startResult),
      });
      return {
        testCase,
        results,
        duration: elapsed(),
        pass: false,
        startResult,
      };
    }
    results.push({
      id: "D1",
      name: "Direct loop start accepted",
      status: "PASS",
      elapsed: elapsed(),
      detail: `${startResult.contractId} -> ${startResult.targetAgent}`,
    });

    loopRuntimeSnapshot = await loadActiveLoopRuntime();
    loopSessionSnapshot = (await readJsonFile(LOOP_SESSION_STATE_FILE))?.activeSession || null;
    if (
      loopRuntimeSnapshot?.loopId !== testCase.loopId
      || loopRuntimeSnapshot?.currentStage !== entryAgentId
      || loopRuntimeSnapshot?.requestedTask !== testCase.message
      || loopSessionSnapshot?.loopId !== testCase.loopId
    ) {
      results.push({
        id: "D2",
        name: "Pipeline truth matches loop start",
        status: "FAIL",
        elapsed: elapsed(),
        detail: trimDetail({
          loopRuntimeSnapshot,
          loopSessionSnapshot,
        }),
      });
      return {
        testCase,
        results,
        duration: elapsed(),
        pass: false,
        startResult,
        loopRuntimeSnapshot,
        loopSessionSnapshot,
      };
    }
    results.push({
      id: "D2",
      name: "Loop runtime truth matches loop start",
      status: "PASS",
      elapsed: elapsed(),
      detail: `loop=${loopRuntimeSnapshot?.loopId || "-"} session=${loopSessionSnapshot?.id || "-"}`,
    });

    entryAgentContract = await readJsonFile(getEntryAgentContractFile(entryAgentId));
    contractorContract = await readJsonFile(CONTRACTOR_CONTRACT_FILE);
    if (
      entryAgentContract?.pipelineStage?.loopId !== testCase.loopId
      || entryAgentContract?.pipelineStage?.stage !== entryAgentId
      || contractorContract
    ) {
      results.push({
        id: "D3",
        name: "First stage is entry agent only",
        status: "FAIL",
        elapsed: elapsed(),
        detail: trimDetail({
          entryAgentContract,
          contractorContract,
        }),
      });
      return {
        testCase,
        results,
        duration: elapsed(),
        pass: false,
        startResult,
        loopRuntimeSnapshot,
        loopSessionSnapshot,
        entryAgentContract,
        contractorContract,
      };
    }
    results.push({
      id: "D3",
      name: "First stage is entry agent only",
      status: "PASS",
      elapsed: elapsed(),
      detail: `${entryAgentContract.id} contractor=null`,
    });

    const heartbeatTarget = heartbeatCalls[0]?.agentId || null;
    if (heartbeatCalls.length < 1 || heartbeatTarget !== entryAgentId) {
      results.push({
        id: "D4",
        name: "Heartbeat targets entry agent",
        status: "FAIL",
        elapsed: elapsed(),
        detail: trimDetail(heartbeatCalls),
      });
      return {
        testCase,
        results,
        duration: elapsed(),
        pass: false,
        startResult,
        pipelineSnapshot,
        loopSessionSnapshot,
        entryAgentContract,
        contractorContract,
        heartbeatCalls,
      };
    }
    results.push({
      id: "D4",
      name: "Heartbeat targets entry agent",
      status: "PASS",
      elapsed: elapsed(),
      detail: trimDetail(heartbeatCalls[0]),
    });

    return {
      testCase,
      results,
      duration: elapsed(),
      pass: true,
      startResult,
      pipelineSnapshot,
      loopSessionSnapshot,
      entryAgentContract,
      contractorContract,
      heartbeatCalls,
      entryAgentId,
    };
  } finally {
    await cleanDirectLoopArtifacts(entryAgentId).catch(() => {});
    await saveGraph(originalGraph).catch(() => {});
    await saveGraphLoopRegistry(originalLoopRegistry).catch(() => {});
  }
}

export function generateLoopDirectReport(testResults, totalDuration) {
  const lines = [];
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const passed = testResults.filter((result) => result.pass).length;
  const failed = testResults.filter((result) => !result.pass).length;

  lines.push("══════════════════════════════════════════════════");
  lines.push(" OPENCLAW LOOP DIRECT-START REPORT");
  lines.push(` Run: ${now}  Duration: ${totalDuration}s`);
  lines.push(` Tests: ${testResults.length} | Passed: ${passed} | Failed: ${failed}`);
  lines.push("══════════════════════════════════════════════════");
  lines.push("");

  for (const result of testResults) {
    lines.push(`── TEST: ${result.testCase.id} ──`);
    lines.push(result.testCase.description);
    lines.push(`Message: ${result.testCase.message}`);
    lines.push(`Duration: ${result.duration}s  Result: ${resultLabel(result)}`);
    lines.push("");

    for (const checkpoint of result.results) {
      const statusStr = `[${checkpoint.status}]`.padEnd(8);
      const nameStr = checkpoint.name.padEnd(30);
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
  lines.push(` SUMMARY: ${passed}/${testResults.length} PASSED  ${failed} FAILED`);
  lines.push("══════════════════════════════════════════════════");
  return lines.join("\n");
}
