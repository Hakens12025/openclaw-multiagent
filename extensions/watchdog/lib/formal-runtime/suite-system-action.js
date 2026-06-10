// lib/formal-runtime/suite-system-action.js — system-action 套件（[ACTION] 探针，check 化）
//
// 移植自旧 suite-direct-service*.js 的已验证探针机制：角色解析拓扑、admin surface 补边、
// [ACTION] 唤醒提示词、SSE checkpoint 链（firstStart→intermediate→firstEnd→bridge alert→
// 同会话 resume→terminal）、finally 清理。差异：每个 checkpoint 产出一条 CheckResult
// （经 checks/check-runner.js），不再自拼 checkpoint 报告。纯逻辑在 checks/system-action-chain.js。

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { markBlocked, runCheck } from "./checks/check-runner.js";
import {
  SYSTEM_ACTION_CASES,
  buildAssignTaskProbePrompt,
  buildChainStageDescriptors,
  buildCreateTaskProbePrompt,
  buildReviewProbePrompt,
  bridgeAlertTypeFor,
  findAlert,
  findTrackEnd,
  findTrackStart,
  intermediateAlertTypeFor,
  mapProbeSignalsToChecks,
} from "./checks/system-action-chain.js";
import {
  OUTPUT_DIR,
  SSEClient,
  addGraphEdgeViaSurface,
  deleteGraphEdgeViaSurface,
  fetchJSON,
  fullReset,
  loadConfig,
  sleep,
  wakeAgentNow,
} from "./infra.js";
import { hasDirectedEdge, loadGraph } from "../agent/agent-graph.js";
import {
  AGENT_ROLE,
  getAgentRole,
  listAgentIdsByRole,
  listRuntimeAgentIds,
  resolvePreferredExecutorAgentId,
} from "../agent/agent-identity.js";

export { SYSTEM_ACTION_CASES };

const REVIEW_FIXTURE = join(OUTPUT_DIR, "REQ-system-action-review-probe.js");
const TERMINAL_TRACK_STATUSES = new Set(["completed", "failed", "awaiting_input"]);
const TERMINAL_CONTRACT_STATUSES = new Set(["completed", "failed", "awaiting_input", "abandoned", "cancelled"]);

// ── 拓扑（角色解析，零写死 agent 名）────────────────────────────────────────
function uniqueAgentIds(ids) {
  const result = [];
  for (const agentId of ids) {
    if (typeof agentId !== "string" || !agentId.trim() || result.includes(agentId)) continue;
    result.push(agentId);
  }
  return result;
}

function listAgentsByRoleInRuntimeOrder(role) {
  const runtimeOrdered = listRuntimeAgentIds().filter((agentId) => getAgentRole(agentId) === role);
  return uniqueAgentIds([...runtimeOrdered, ...listAgentIdsByRole(role)]);
}

export function resolveSystemActionTopology() {
  const executorAgentIds = uniqueAgentIds([
    resolvePreferredExecutorAgentId({ specializedFirst: true }),
    ...listAgentsByRoleInRuntimeOrder(AGENT_ROLE.EXECUTOR),
  ]);
  const reviewerAgentIds = listAgentsByRoleInRuntimeOrder(AGENT_ROLE.REVIEWER);
  return {
    callerAgentId: executorAgentIds[0] || null,
    delegateAgentId: executorAgentIds.find((agentId) => agentId !== executorAgentIds[0]) || null,
    reviewerAgentId: reviewerAgentIds[0] || null,
    executorAgentIds,
    reviewerAgentIds,
  };
}

// ── 准备步骤（边授权 / review fixture）──────────────────────────────────────
async function ensureDirectedEdge(from, to, opts = {}) {
  const graph = await loadGraph();
  if (hasDirectedEdge(graph, from, to)) return { detail: `${from} -> ${to} (existing)` };
  const addResult = await addGraphEdgeViaSurface(from, to, opts);
  if (!addResult?.ok) throw new Error(addResult?.error || `failed to add graph edge ${from} -> ${to}`);
  return {
    detail: `${from} -> ${to} (added)`,
    cleanup: async () => {
      const deleteResult = await deleteGraphEdgeViaSurface(from, to);
      if (!deleteResult?.ok) throw new Error(deleteResult?.error || `failed to delete graph edge ${from} -> ${to}`);
    },
  };
}

async function prepareReviewFixture() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(REVIEW_FIXTURE, [
    "export function computeTotal(items) {",
    "  const subtotal = items.reduce((acc, item) => acc + item.price, 0);",
    "  return subtotal + taxRate;",
    "}",
    "",
    "console.log(computeTotal([{ price: 1 }, { price: 2 }]));",
  ].join("\n"), "utf8");
  return { artifactPath: REVIEW_FIXTURE };
}

// 每个动作的探针配置（topology → 缺位角色 / prep / 提示词 / 事件过滤 / 证据格式）。
function buildProbeConfig(probeCase, topology) {
  const action = probeCase.action;
  const bridgeType = bridgeAlertTypeFor(action);
  if (action === "create_task") {
    return {
      missing: topology.callerAgentId ? null : "no executor-role agent registered (caller missing)",
      prompt: () => buildCreateTaskProbePrompt(),
      findBridge: (events, afterMs) => findAlert(events, { type: bridgeType, afterMs, targetAgent: topology.callerAgentId }),
      bridgeEvidence: (alert) => `${alert.data?.contractId || "none"} <- child ${alert.data?.childContractId || "none"}`,
      contractIdFromAlert: (alert, firstStart) => alert?.data?.childContractId || firstStart?.data?.contractId || null,
    };
  }
  if (action === "assign_task") {
    return {
      missing: (!topology.callerAgentId || !topology.delegateAgentId)
        ? "requires at least 2 executor-role agents (caller + delegate)" : null,
      prep: () => ensureDirectedEdge(topology.callerAgentId, topology.delegateAgentId, { label: "delegate" }),
      prompt: () => buildAssignTaskProbePrompt({ delegateAgentId: topology.delegateAgentId }),
      findIntermediate: (events, afterMs) => findAlert(events, {
        type: intermediateAlertTypeFor(action), afterMs, source: topology.callerAgentId, targetAgent: topology.delegateAgentId,
      }),
      intermediateEvidence: (alert) => `${alert.data?.targetAgent || "unknown"} <- ${alert.data?.contractId || "none"}`,
      findBridge: (events, afterMs) => findAlert(events, {
        type: bridgeType, afterMs, source: topology.delegateAgentId, targetAgent: topology.callerAgentId,
      }),
      bridgeEvidence: (alert) => `${alert.data?.contractId || "none"} <- delegated ${alert.data?.delegatedContractId || "none"} status=${alert.data?.status || "unknown"}`,
      contractIdFromAlert: (alert, firstStart) => alert?.data?.contractId || firstStart?.data?.contractId || null,
    };
  }
  // request_review
  return {
    missing: !topology.callerAgentId ? "no executor-role agent registered (caller missing)"
      : (!topology.reviewerAgentId ? "no reviewer-role agent registered" : null),
    prep: async () => {
      const fixture = await prepareReviewFixture();
      const edge = await ensureDirectedEdge(topology.callerAgentId, topology.reviewerAgentId, { label: "review" });
      return { ...fixture, detail: `${fixture.artifactPath}; ${edge.detail}`, cleanup: edge.cleanup || null };
    },
    prompt: (prepContext) => buildReviewProbePrompt(prepContext),
    findIntermediate: (events, afterMs) => findAlert(events, {
      type: intermediateAlertTypeFor(action), afterMs, source: topology.callerAgentId, targetAgent: topology.reviewerAgentId,
    }),
    intermediateEvidence: (alert) => `artifacts=${alert.data?.artifactCount ?? "unknown"}`,
    findBridge: (events, afterMs) => findAlert(events, {
      type: bridgeType, afterMs, source: topology.reviewerAgentId, targetAgent: topology.callerAgentId,
    }),
    bridgeEvidence: (alert) => `${alert.data?.contractId || "none"} verdict=${alert.data?.verdict || "unknown"}`,
    contractIdFromAlert: (alert, firstStart) => alert?.data?.contractId || firstStart?.data?.contractId || null,
  };
}

async function fetchContractStatus(contractId) {
  if (!contractId) return null;
  try {
    const contracts = await fetchJSON("/watchdog/work-items");
    return contracts.find((entry) => entry.id === contractId)?.status || null;
  } catch {
    return null;
  }
}

// ── 观测循环：只填 signals，check 在循环结束后由纯映射统一产出 ────────────────
async function observeChain({ sse, topology, config, startMs, timeoutMs, signals }) {
  const callerAgentId = topology.callerAgentId;
  const deadline = Date.now() + timeoutMs;
  const elapsed = () => Date.now() - startMs;
  let firstStartEvt = null;
  let firstEndEvt = null;
  let resumeEvt = null;
  let bridgeEvt = null;
  const wantsIntermediate = typeof config.findIntermediate === "function";

  while (Date.now() < deadline) {
    if (!firstStartEvt) {
      firstStartEvt = findTrackStart(sse.events, { agentId: callerAgentId, afterMs: startMs, hookOnly: true });
      if (firstStartEvt) signals.firstStart = { elapsedMs: elapsed(), evidence: `sessionKey=${firstStartEvt.data.sessionKey}` };
    }
    if (wantsIntermediate && !signals.intermediate) {
      const evt = config.findIntermediate(sse.events, startMs);
      if (evt) signals.intermediate = { elapsedMs: elapsed(), evidence: config.intermediateEvidence(evt) };
    }
    if (firstStartEvt && !firstEndEvt) {
      firstEndEvt = findTrackEnd(sse.events, {
        agentId: callerAgentId, sessionKey: firstStartEvt.data.sessionKey, afterMs: firstStartEvt.receivedAt + 1,
      });
      if (firstEndEvt) signals.firstEnd = { elapsedMs: elapsed(), evidence: `status=${firstEndEvt.data?.status || "completed"}` };
    }
    if (firstEndEvt && !bridgeEvt) {
      bridgeEvt = config.findBridge(sse.events, firstEndEvt.receivedAt + 1);
      if (bridgeEvt) signals.bridgeAlert = { elapsedMs: elapsed(), evidence: config.bridgeEvidence(bridgeEvt) };
    }
    if (firstEndEvt && !resumeEvt) {
      resumeEvt = findTrackStart(sse.events, {
        agentId: callerAgentId, afterMs: firstEndEvt.receivedAt + 1, sessionKey: firstStartEvt.data.sessionKey,
      });
      if (resumeEvt) signals.resume = { elapsedMs: elapsed(), evidence: `sessionKey=${resumeEvt.data.sessionKey}` };
    }
    if (resumeEvt && !signals.resumeEnd) {
      const endEvt = findTrackEnd(sse.events, {
        agentId: callerAgentId, sessionKey: firstStartEvt.data.sessionKey, afterMs: resumeEvt.receivedAt + 1,
      });
      if (endEvt && TERMINAL_TRACK_STATUSES.has(endEvt.data?.status || "completed")) {
        signals.resumeEnd = { elapsedMs: elapsed(), evidence: `status=${endEvt.data?.status || "completed"}` };
      }
    }
    if (bridgeEvt && !signals.bridgeContractTerminal) {
      const contractId = config.contractIdFromAlert(bridgeEvt, firstStartEvt);
      const status = await fetchContractStatus(contractId);
      if (status && TERMINAL_CONTRACT_STATUSES.has(status)) {
        signals.bridgeContractTerminal = { elapsedMs: elapsed(), evidence: `${contractId} ${status}` };
      }
    }

    const allSeen = Boolean(
      signals.firstStart && signals.firstEnd && signals.bridgeAlert
      && signals.resume && signals.resumeEnd && signals.bridgeContractTerminal
      && (!wantsIntermediate || signals.intermediate),
    );
    if (allSeen) break;
    await sleep(2000);
  }
}

// ── 单 case 驱动 ─────────────────────────────────────────────────────────────
async function runSystemActionCase(context, sse, probeCase) {
  const topology = resolveSystemActionTopology();
  const config = buildProbeConfig(probeCase, topology);
  const prepDescriptor = config.prep
    ? { id: `system-action.${probeCase.id}-prep`, subsystem: "system-action", title: "Probe prerequisites prepared" }
    : null;
  const wakeDescriptor = { id: `system-action.${probeCase.id}-wake`, subsystem: "system-action", title: "[ACTION] probe wake accepted" };
  const chainDescriptors = buildChainStageDescriptors(probeCase);

  if (config.missing) {
    markBlocked(context, [...(prepDescriptor ? [prepDescriptor] : []), wakeDescriptor, ...chainDescriptors],
      "E-RUNNER-005", `topology prerequisite missing: ${config.missing}`);
    return;
  }

  try {
    await fullReset();
  } catch (error) {
    markBlocked(context, [...(prepDescriptor ? [prepDescriptor] : []), wakeDescriptor, ...chainDescriptors],
      "E-RUNNER-005", `runtime reset failed: ${error?.message || error}`);
    return;
  }
  await sleep(1500);
  sse.resetBaseline();

  let prepContext = {};
  try {
    if (config.prep) {
      const prepCheck = await runCheck(context, { ...prepDescriptor, code: "E-GRAPH-004" }, async () => {
        prepContext = await config.prep();
        return prepContext.detail || "prepared";
      });
      if (prepCheck.status !== "pass") {
        markBlocked(context, [wakeDescriptor, ...chainDescriptors], "E-RUNNER-005", `prerequisite check ${prepDescriptor.id} failed`);
        return;
      }
    }

    const startMs = Date.now();
    const wakeCheck = await runCheck(context, { ...wakeDescriptor, code: "E-DISPATCH-004" }, async () => {
      const wakeResult = await wakeAgentNow(topology.callerAgentId, config.prompt(prepContext));
      if (!wakeResult?.ok) {
        return { status: "fail", evidence: `wake refused: ${JSON.stringify(wakeResult)}` };
      }
      return `caller=${topology.callerAgentId} runId=${wakeResult.runId || "wake requested"}`;
    });
    if (wakeCheck.status !== "pass") {
      markBlocked(context, chainDescriptors, "E-RUNNER-005", `prerequisite check ${wakeDescriptor.id} failed`);
      return;
    }

    const signals = {};
    await observeChain({ sse, topology, config, startMs, timeoutMs: probeCase.timeoutMs, signals });
    const checks = mapProbeSignalsToChecks(probeCase, signals, { caseElapsedMs: Date.now() - startMs, topology });
    for (const check of checks) context.addCheck(check);
  } finally {
    if (typeof prepContext?.cleanup === "function") {
      try {
        await prepContext.cleanup();
      } catch (error) {
        context.addCheck({
          id: `system-action.${probeCase.id}-cleanup`, subsystem: "system-action", title: "Probe edge cleanup",
          status: "fail", code: "E-GRAPH-004", evidence: `cleanup failed: ${error?.message || error}`, durationMs: 0,
        });
      }
    }
  }
}

// ── 套件入口（契约：runXxxSuite(run, context)，只 addCheck，不写报告）─────────
export async function runSystemActionSuite(run, context) {
  await loadConfig();
  const sse = new SSEClient();
  const allCaseDescriptors = SYSTEM_ACTION_CASES.flatMap((probeCase) => [
    // assign/review 有 prep（补边 / fixture）；create 无 —— 与 buildProbeConfig 的 prep 定义一致。
    ...(probeCase.action === "create_task" ? [] : [
      { id: `system-action.${probeCase.id}-prep`, subsystem: "system-action", title: "Probe prerequisites prepared" },
    ]),
    { id: `system-action.${probeCase.id}-wake`, subsystem: "system-action", title: "[ACTION] probe wake accepted" },
    ...buildChainStageDescriptors(probeCase),
  ]);

  const sseCheck = await runCheck(context, {
    id: "system-action.sse-stream", subsystem: "system-action", title: "SSE stream connected", code: "E-SSE-001",
  }, async () => {
    await sse.connect();
    return `connected to /watchdog/stream (${sse.events.length} replay events)`;
  });
  if (sseCheck.status !== "pass") {
    markBlocked(context, allCaseDescriptors, "E-RUNNER-005", "SSE stream unavailable: checkpoint chain cannot be observed");
    sse.close();
    return;
  }

  try {
    for (const probeCase of SYSTEM_ACTION_CASES) {
      await runSystemActionCase(context, sse, probeCase);
    }
  } finally {
    sse.close();
  }
}
