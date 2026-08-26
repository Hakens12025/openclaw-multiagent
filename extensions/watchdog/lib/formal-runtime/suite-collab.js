// lib/formal-runtime/suite-collab.js — collab 套件(系统动作探针,P5 三层化,check 化)
//
// 探针全部走【合约会话】:test-inject 派发真合约(replyTo 指向 distinct 上游
// bridge → 回程票据可得),caller 固定为 planner 角色(assign 授权面齐,
// create_task 对所有角色 denied——正好探 known-but-denied)。
// 关键机关(policy 案):caller 管线出边数须 ≠1(恰 1 条会被 graph_route 自动
// 前送,graphRouted 会话的 consume 只放行 wake;0/≥2 条才落回终态链让 caller
// 自己消费 [ACTION] marker)——policy 案 prep 条件化保证,L1 案零 prep。
// 纯逻辑在 checks/system-action-chain.js;本文件只做 IO(inject/SSE/轮询)。

import { markBlocked, runCheck } from "./checks/check-runner.js";
import {
  ROLE_POLICY_REJECTED_ALERT_TYPE,
  SYSTEM_ACTION_CASES,
  buildCaseDescriptors,
  buildChainStageDescriptors,
  buildCreateTaskDeniedProbePrompt,
  buildL1AssignExpectationsProbePrompt,
  buildL1AssignProbePrompt,
  bridgeAlertTypeFor,
  findAlert,
  findTrackEnd,
  findTrackStart,
  intermediateAlertTypeFor,
  mapProbeSignalsToChecks,
  planCallerRoutingAmbiguityPrep,
} from "./checks/system-action-chain.js";
import {
  SSEClient,
  addGraphEdgeViaSurface,
  deleteGraphEdgeViaSurface,
  fetchJSON,
  fullReset,
  loadConfig,
  sendTestInject,
  sleep,
} from "./infra.js";
import { getEdgesFrom, getPipelineEdgesFrom, loadGraph } from "../agent/agent-graph.js";
import {
  AGENT_ROLE,
  getAgentRole,
  listAgentIdsByRole,
  listRuntimeAgentIds,
} from "../agent/agent-identity.js";

export { SYSTEM_ACTION_CASES };

const TERMINAL_TRACK_STATUSES = new Set(["completed", "failed"]);
const TERMINAL_CONTRACT_STATUSES = new Set(["completed", "failed", "abandoned", "cancelled"]);

// ── 拓扑(角色解析,零写死 agent 名)────────────────────────────────────────
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
  const plannerAgentIds = listAgentsByRoleInRuntimeOrder(AGENT_ROLE.PLANNER);
  const executorAgentIds = listAgentsByRoleInRuntimeOrder(AGENT_ROLE.EXECUTOR);
  const bridgeAgentIds = listAgentsByRoleInRuntimeOrder(AGENT_ROLE.BRIDGE);
  return {
    callerAgentId: plannerAgentIds[0] || null,
    delegateAgentId: executorAgentIds[0] || null,
    ambiguityAgentId: executorAgentIds[1] || executorAgentIds[0] || null,
    upstreamAgentId: bridgeAgentIds[0] || null,
    plannerAgentIds,
    executorAgentIds,
  };
}

// ── 探针副作用准备 ─────────────────────────────────────────────────────────
//
// 全量图夹具已于 2026-08-18 拆除("锚边 + 歧义边"自己制造问题再自己抵消,且
// ensureDirectedEdge 命中已存在边时不注册 cleanup → 中断残边永久固化)。拆除时
// 的推理只覆盖了 0 出边(terminal)与 ≥2 出边(ambiguous)两态 —— 恰 1 条管线出边
// 时 routeAfterAgentEnd 走 single_edge 自动前送,graphRouted 会话的 consume 只
// 放行 wake,policy 案的 [ACTION] create_task 在 caller agent_end 被静默跳过,
// 拒绝告警缺席(2026-08-26 live E-SYSACTION-002:生产图 08-19 起有 planner→worker
// 单出边,合约被前送到 worker,拒绝来自 worker 而探针只认 caller source)。
// 故 policy 案恢复一个【条件化最小 prep】:恰 1 条出边才补一条歧义边,目标跳过
// caller 全部既有出边,cleanup 只删自己真加的那条(计划纯逻辑在
// planCallerRoutingAmbiguityPrep,残边风险与 suite-link ensureLinkCaseEdge 同级)。
// L1 案(FC 工具中场调用,不走 agent_end 提取门)照旧零 prep。

async function preparePolicyCallerAmbiguity(topology) {
  const graph = await loadGraph();
  const plan = planCallerRoutingAmbiguityPrep({
    pipelineEdges: getPipelineEdgesFrom(graph, topology.callerAgentId),
    allEdges: getEdgesFrom(graph, topology.callerAgentId),
    candidateTargets: [
      topology.ambiguityAgentId,
      topology.delegateAgentId,
      ...topology.executorAgentIds,
    ],
  });
  if (plan.action === "none") return { detail: plan.detail };
  if (plan.action !== "add-edge") throw new Error(plan.detail);
  const addResult = await addGraphEdgeViaSurface(topology.callerAgentId, plan.to, {
    label: "formal-collab-policy-ambiguity",
    metadata: plan.metadata,
  });
  if (!addResult?.ok || addResult.skipped) {
    throw new Error(addResult?.error || `graph edge add ${topology.callerAgentId} -> ${plan.to} not applied (${addResult?.reason || "surface refused"})`);
  }
  return {
    detail: plan.detail,
    cleanup: async () => {
      const delResult = await deleteGraphEdgeViaSurface(topology.callerAgentId, plan.to);
      if (!delResult?.ok) {
        throw new Error(delResult?.error || `graph edge delete ${topology.callerAgentId} -> ${plan.to} refused`);
      }
    },
  };
}

// 每个 case 的探针配置(topology → 缺位角色 / prep / 提示词 / 事件过滤 / 证据格式)。
function buildProbeConfig(probeCase, topology) {
  const action = probeCase.action;
  const bridgeType = bridgeAlertTypeFor(action);
  const missingCaller = !topology.callerAgentId ? "no planner-role agent registered (caller missing)" : null;
  const missingUpstream = !topology.upstreamAgentId ? "no bridge-role agent registered (distinct upstream replyTo missing)" : null;

  if (probeCase.layer === "policy") {
    return {
      missing: missingCaller || missingUpstream,
      // 拓扑门槛:caller 管线出边恰 1 条时自动前送会把 marker 带离 caller 的
      // 终态链 → 条件化补一条歧义边(详见文件头"探针副作用准备"段)。
      prep: () => preparePolicyCallerAmbiguity(topology),
      prompt: () => buildCreateTaskDeniedProbePrompt(),
      findRejection: (events, afterMs) => findAlert(events, {
        type: ROLE_POLICY_REJECTED_ALERT_TYPE, afterMs, source: topology.callerAgentId,
      }),
      rejectionEvidence: (alert) => `${alert.data?.actionType || "?"} rejected for role ${alert.data?.role || "?"}`,
    };
  }
  return {
    missing: missingCaller || missingUpstream
      || (!topology.delegateAgentId ? "no executor-role agent registered (delegate missing)" : null),
    prep: null, // 无前置副作用(图夹具已退场)
    // 期望声明 case 换用带 expectations 的提示词,其余观测一致。它是全库唯一让
    // assign_task 真带 expectations 走完 live 派工的覆盖,判决面拔除后仍然保留:
    // 声明面属执行面(agent 面协议),被拔掉的只是事后核验。
    prompt: () => (probeCase.declaredArtifactPath
      ? buildL1AssignExpectationsProbePrompt({
          delegateAgentId: topology.delegateAgentId,
          declaredArtifactPath: probeCase.declaredArtifactPath,
        })
      : buildL1AssignProbePrompt({ delegateAgentId: topology.delegateAgentId })),
    findIntermediate: (events, afterMs) => findAlert(events, {
      type: intermediateAlertTypeFor(action), afterMs, source: topology.callerAgentId, targetAgent: topology.delegateAgentId,
    }),
    intermediateEvidence: (alert) => `${alert.data?.targetAgent || "unknown"} <- ${alert.data?.contractId || "none"}`,
    findBridge: (events, afterMs) => findAlert(events, {
      type: bridgeType, afterMs, source: topology.delegateAgentId, targetAgent: topology.callerAgentId,
    }),
    bridgeEvidence: (alert) => `${alert.data?.contractId || "none"} <- delegated ${alert.data?.delegatedContractId || "none"} status=${alert.data?.status || "unknown"}`,
    contractIdFromAlert: (alert) => alert?.data?.contractId || null,
    // 期望验收站(仅期望声明案):expectationCheck 在【受托子约】终态结局上,
    // 不在回投信封上——专用取数器取 delegatedContractId。
    expectExpectationVerdict: Boolean(probeCase.declaredArtifactPath),
    expectationContractIdFromAlert: (alert) => alert?.data?.delegatedContractId || null,
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

// 每轮询问 caller 合约会话边界(first-start/first-end),两条观测循环共用——
// contractOnly 语义变更时只有一处要改。
function observeCallerBoundary(state, { sse, callerAgentId, startMs, elapsed, signals }) {
  if (!state.firstStartEvt) {
    state.firstStartEvt = findTrackStart(sse.events, { agentId: callerAgentId, afterMs: startMs, contractOnly: true });
    if (state.firstStartEvt) signals.firstStart = { elapsedMs: elapsed(), evidence: `sessionKey=${state.firstStartEvt.data.sessionKey}` };
  }
  if (state.firstStartEvt && !state.firstEndEvt) {
    state.firstEndEvt = findTrackEnd(sse.events, {
      agentId: callerAgentId, sessionKey: state.firstStartEvt.data.sessionKey, afterMs: state.firstStartEvt.receivedAt + 1,
    });
    if (state.firstEndEvt) signals.firstEnd = { elapsedMs: elapsed(), evidence: `status=${state.firstEndEvt.data?.status || "completed"}` };
  }
}

// ── 观测循环(链路层):只填 signals,check 在循环结束后由纯映射统一产出 ─────────
async function observeChain({ sse, topology, config, startMs, timeoutMs, signals }) {
  const callerAgentId = topology.callerAgentId;
  const deadline = Date.now() + timeoutMs;
  const elapsed = () => Date.now() - startMs;
  const boundary = { firstStartEvt: null, firstEndEvt: null };
  let intermediateEvt = null;
  let resumeEvt = null;
  let bridgeEvt = null;

  while (Date.now() < deadline) {
    observeCallerBoundary(boundary, { sse, callerAgentId, startMs, elapsed, signals });
    const { firstStartEvt, firstEndEvt } = boundary;
    if (firstStartEvt && !intermediateEvt) {
      intermediateEvt = config.findIntermediate(sse.events, startMs);
      if (intermediateEvt) signals.intermediate = { elapsedMs: elapsed(), evidence: config.intermediateEvidence(intermediateEvt) };
    }
    if (intermediateEvt && !bridgeEvt) {
      // L1 工具中场受理:回投可与 caller 收官竞速,窗口从受理时刻起算而非 firstEnd。
      bridgeEvt = config.findBridge(sse.events, intermediateEvt.receivedAt + 1);
      if (bridgeEvt) signals.bridgeAlert = { elapsedMs: elapsed(), evidence: config.bridgeEvidence(bridgeEvt) };
    }
    if (firstEndEvt && bridgeEvt && !resumeEvt) {
      resumeEvt = findTrackStart(sse.events, {
        agentId: callerAgentId, afterMs: firstEndEvt.receivedAt + 1, sessionKey: firstStartEvt.data.sessionKey,
      });
      if (resumeEvt) signals.resume = { elapsedMs: elapsed(), evidence: `sessionKey=${resumeEvt.data.sessionKey}` };
    }
    if (resumeEvt && !signals.resumeEnd) {
      const endEvt = findTrackEnd(sse.events, {
        agentId: callerAgentId, sessionKey: boundary.firstStartEvt.data.sessionKey, afterMs: resumeEvt.receivedAt + 1,
      });
      if (endEvt && TERMINAL_TRACK_STATUSES.has(endEvt.data?.status || "completed")) {
        signals.resumeEnd = { elapsedMs: elapsed(), evidence: `status=${endEvt.data?.status || "completed"}` };
      }
    }
    if (bridgeEvt && !signals.bridgeContractTerminal) {
      const contractId = config.contractIdFromAlert(bridgeEvt);
      const status = await fetchContractStatus(contractId);
      if (status && TERMINAL_CONTRACT_STATUSES.has(status)) {
        signals.bridgeContractTerminal = { elapsedMs: elapsed(), evidence: `${contractId} ${status}` };
      }
    }
    // 期望声明案验收站:受托合约终态结局须留非空 expectationCheck(断供修复防回归)。
    // 读 /watchdog/work-items 行(task history 供给):DIRECT 信封合约没有共享
    // 快照,readContractSnapshotById 对它必空——探针窗口内 work-items 行是
    // 受托约终态结局唯一的稳定读面。
    if (config.expectExpectationVerdict && signals.bridgeContractTerminal && !signals.expectationVerdict) {
      const contractId = config.expectationContractIdFromAlert?.(bridgeEvt) || null;
      try {
        const items = contractId ? await fetchJSON("/watchdog/work-items") : [];
        const row = (Array.isArray(items) ? items : []).find((entry) => entry.id === contractId);
        const check = row?.terminalOutcome?.expectationCheck;
        if (check && check.checked > 0) {
          signals.expectationVerdict = {
            elapsedMs: elapsed(),
            evidence: `${contractId} expectationCheck checked=${check.checked} missing=${check.missing}`,
          };
        }
      } catch { /* 面瞬断 → 下一轮重试,预算封顶 */ }
    }
    const allSeen = Boolean(
      signals.firstStart && signals.intermediate && signals.firstEnd && signals.bridgeAlert
      && signals.resume && signals.resumeEnd && signals.bridgeContractTerminal
      && (!config.expectExpectationVerdict || signals.expectationVerdict),
    );
    if (allSeen) break;
    await sleep(2000);
  }
}

// ── 观测循环(policy 层):start → 拒绝 alert → end → caller 合约终态 ─────────
async function observeDenied({ sse, topology, config, startMs, timeoutMs, signals, injectContractId }) {
  const callerAgentId = topology.callerAgentId;
  const deadline = Date.now() + timeoutMs;
  const elapsed = () => Date.now() - startMs;
  const boundary = { firstStartEvt: null, firstEndEvt: null };

  while (Date.now() < deadline) {
    observeCallerBoundary(boundary, { sse, callerAgentId, startMs, elapsed, signals });
    const { firstStartEvt, firstEndEvt } = boundary;
    if (firstStartEvt && !signals.rejection) {
      const evt = config.findRejection(sse.events, startMs);
      if (evt) signals.rejection = { elapsedMs: elapsed(), evidence: config.rejectionEvidence(evt) };
    }
    if (firstEndEvt && !signals.callerContractTerminal) {
      const status = await fetchContractStatus(injectContractId);
      if (status && TERMINAL_CONTRACT_STATUSES.has(status)) {
        signals.callerContractTerminal = { elapsedMs: elapsed(), evidence: `${injectContractId} ${status}` };
      }
    }

    if (signals.firstStart && signals.rejection && signals.firstEnd && signals.callerContractTerminal) break;
    await sleep(2000);
  }
}

// ── 单 case 驱动 ─────────────────────────────────────────────────────────────
async function runSystemActionCase(context, sse, probeCase) {
  const topology = resolveSystemActionTopology();
  const config = buildProbeConfig(probeCase, topology);
  const [prepDescriptor, injectDescriptor, ...chainDescriptors] = buildCaseDescriptors(probeCase);
  const allDescriptors = [prepDescriptor, injectDescriptor, ...chainDescriptors];

  if (config.missing) {
    markBlocked(context, allDescriptors, "E-RUNNER-005", `topology prerequisite missing: ${config.missing}`);
    return;
  }

  try {
    await fullReset();
  } catch (error) {
    markBlocked(context, allDescriptors, "E-RUNNER-005", `runtime reset failed: ${error?.message || error}`);
    return;
  }
  await sleep(1500);
  sse.resetBaseline();

  let prepContext = {};
  try {
    // prep 位只服务真有前置副作用的案子;无 prep 的案子如实记
    // "无需准备",不再借 E-GRAPH-004(边增删往返)的码——本套件已不碰图。
    const prepCheck = await runCheck(context, { ...prepDescriptor, code: "E-RUNNER-005" }, async () => {
      if (typeof config.prep !== "function") return "no prerequisites";
      prepContext = await config.prep();
      return prepContext.detail || "prepared";
    });
    if (prepCheck.status !== "pass") {
      markBlocked(context, [injectDescriptor, ...chainDescriptors], "E-RUNNER-005", `prerequisite check ${prepDescriptor.id} failed`);
      return;
    }

    const startMs = Date.now();
    let injectContractId = null;
    const injectCheck = await runCheck(context, { ...injectDescriptor, code: "E-DISPATCH-004" }, async () => {
      const injectResult = await sendTestInject(config.prompt(prepContext), "webui", {
        agentId: topology.upstreamAgentId,
        sessionKey: `agent:${topology.upstreamAgentId}:main`,
      });
      if (!injectResult?.ok) {
        return { status: "fail", evidence: `inject refused: ${JSON.stringify(injectResult)}` };
      }
      if (injectResult.targetAgent && injectResult.targetAgent !== topology.callerAgentId) {
        return {
          status: "fail",
          evidence: `ingress first hop ${injectResult.targetAgent} != expected caller ${topology.callerAgentId}`,
        };
      }
      injectContractId = injectResult.contractId || null;
      return `caller=${topology.callerAgentId} contract=${injectContractId || "?"} (upstream=${topology.upstreamAgentId})`;
    });
    if (injectCheck.status !== "pass") {
      markBlocked(context, chainDescriptors, "E-RUNNER-005", `prerequisite check ${injectDescriptor.id} failed`);
      return;
    }

    const signals = {};
    if (probeCase.layer === "policy") {
      await observeDenied({ sse, topology, config, startMs, timeoutMs: probeCase.timeoutMs, signals, injectContractId });
    } else {
      await observeChain({ sse, topology, config, startMs, timeoutMs: probeCase.timeoutMs, signals });
    }
    const checks = mapProbeSignalsToChecks(probeCase, signals, { caseElapsedMs: Date.now() - startMs, topology });
    for (const check of checks) context.addCheck(check);
  } finally {
    if (typeof prepContext?.cleanup === "function") {
      try {
        await prepContext.cleanup();
      } catch (error) {
        context.addCheck({
          id: `collab.${probeCase.id}-cleanup`, subsystem: "collab", title: "Probe edge cleanup",
          status: "fail", code: "E-RUNNER-005", evidence: `cleanup failed: ${error?.message || error}`, durationMs: 0,
        });
      }
    }
  }
}

// ── 套件入口(契约:runXxxSuite(run, context),只 addCheck,不写报告)─────────
export async function runSystemActionSuite(run, context) {
  await loadConfig();
  const sse = new SSEClient();
  const allCaseDescriptors = SYSTEM_ACTION_CASES.flatMap(buildCaseDescriptors);

  const sseCheck = await runCheck(context, {
    id: "collab.sse-stream", subsystem: "collab", title: "SSE stream connected", code: "E-SSE-001",
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
