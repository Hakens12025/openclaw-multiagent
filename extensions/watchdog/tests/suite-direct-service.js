import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  fetchJSON,
  OUTPUT_DIR,
  fullReset,
  sleep,
  wakeAgentNow,
} from "./infra.js";
import {
  addEdge,
  hasDirectedEdge,
  loadGraph,
  removeEdge,
} from "../lib/agent/agent-graph.js";
import {
  AGENT_ROLE,
  getAgentRole,
  listAgentIdsByRole,
  listRuntimeAgentIds,
  resolvePreferredExecutorAgentId,
} from "../lib/agent/agent-identity.js";

const REVIEW_FIXTURE = join(OUTPUT_DIR, "REQ-direct-service-review-probe.js");
const TERMINAL_TRACK_STATUSES = new Set(["completed", "failed", "awaiting_input"]);

export const DIRECT_SERVICE_CASES = [
  {
    id: "direct-service-create-task-return",
    message: "executor direct_service create_task returns to same session",
    timeoutMs: 240000,
  },
  {
    id: "direct-service-assign-task-return",
    message: "executor direct_service assign_task delegated result returns to same session",
    timeoutMs: 240000,
    scenario: "协作 delivery 哨兵",
    businessSemantics: "验证 assign_task 的受托结果会通过 delivery:system_action 回到同一业务会话。",
    transportPath: ["system_action.assign_task", "conveyor.dispatch", "system_action_assign_task_result", "lifecycle.commit"],
    expectedRuntimeTruth: ["delegated contract dispatched", "delegated worker completes", "assign_task result delivered back to caller session"],
    coverage: ["dispatch", "execution", "system_action_delivery", "frontend_visibility"],
  },
  {
    id: "direct-service-request-review-return",
    message: "executor direct_service request_review verdict returns to same session",
    timeoutMs: 300000,
  },
];

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
  return uniqueAgentIds([
    ...runtimeOrdered,
    ...listAgentIdsByRole(role),
  ]);
}

export function resolveDirectServiceProbeTopology() {
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

function buildCreateTaskProbePrompt() {
  const actionMarker = "[ACTION] "
    + JSON.stringify({
      type: "create_task",
      params: {
        message: "请只回复 CHILD_OK，然后立即停止。不要使用工具，不要扩展。",
        source: "webui",
      },
    });
  return [
    "这是一个 system_action delivery 测试，严格按步骤执行，不要自行发挥。",
    "当前用户已经明确同意你发起 create_task。",
    "如果你当前处在 direct service session：",
    "1. 先读取 inbox/contract.json，确认当前任务；主结果只能写到 contract.output 指向的 markdown 文件。",
    "2. 不要改写 inbox/contract.json，不要写别的文件，也不要只在普通对话里说出 marker。",
    "3. 把 contract.output 文件内容写成且只写成下面这一行 [ACTION] marker：",
    actionMarker,
    "4. 写完后立刻停止，不要输出别的内容。",
    "5. 如果 runtime 稍后把子流程结果送回当前同一会话，就把 contract.output 文件内容改成且只改成 PARENT_RECEIVED，然后停止。",
    "不要自己直接回答 CHILD_OK。",
  ].join("\n");
}

function buildReviewProbePrompt({ artifactPath }) {
  const actionMarker = "[ACTION] "
    + JSON.stringify({
    type: "request_review",
    params: {
      instruction: "请审查这个实现；若存在未定义变量或明显运行错误，请直接给出 reject，并简要指出问题。",
      artifactManifest: [
        { path: artifactPath, label: "review_probe" },
      ],
    },
  });

  return [
    "这是一个 system_action delivery 测试，严格按步骤执行，不要自行发挥。",
    "当前用户已经明确同意你发起 request_review。",
    "如果你当前处在 direct service session：",
    "1. 先读取 inbox/contract.json，确认当前任务；主结果只能写到 contract.output 指向的 markdown 文件。",
    "2. 不要改写 inbox/contract.json，不要写别的文件，也不要只在普通对话里说出 marker。",
    "3. 把 contract.output 文件内容写成且只写成下面这一行 [ACTION] marker：",
    actionMarker,
    "4. 写完后立刻停止，不要输出别的内容。",
    "5. 如果 runtime 稍后把 reviewer 的 verdict 送回当前同一会话，就把 contract.output 文件内容改成且只改成 REVIEW_PARENT_RECEIVED，然后停止。",
    "不要自己直接审查这份代码，也不要跳过 request_review。",
  ].join("\n");
}

function buildAssignTaskProbePrompt({ delegateAgentId }) {
  const actionMarker = "[ACTION] "
    + JSON.stringify({
    type: "assign_task",
    params: {
      targetAgent: delegateAgentId,
      instruction: "请只把 CHILD_ASSIGNEE_OK 写入 output 指定路径，然后立即停止。不要使用 system_action，不要扩展。",
      reason: "direct-service assign_task return probe",
    },
  });

  return [
    "这是一个 system_action delivery 测试，严格按步骤执行，不要自行发挥。",
    "当前用户已经明确同意你发起 assign_task。",
    "如果你当前处在 direct service session：",
    "1. 先读取 inbox/contract.json，确认当前任务；主结果只能写到 contract.output 指向的 markdown 文件。",
    "2. 不要改写 inbox/contract.json，不要写别的文件，也不要只在普通对话里说出 marker。",
    "3. 把 contract.output 文件内容写成且只写成下面这一行 [ACTION] marker：",
    actionMarker,
    "4. 写完后立刻停止，不要输出别的内容。",
    "5. 如果 runtime 稍后把 delegated result 送回当前同一会话，就把 contract.output 文件内容改成且只改成 ASSIGN_PARENT_RECEIVED，然后停止。",
    "不要自己直接回答 CHILD_ASSIGNEE_OK，也不要改派给别的 agent。",
  ].join("\n");
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

function summarizeEvent(evt) {
  return {
    type: evt.type,
    receivedAt: evt.receivedAt,
    data: {
      agentId: evt.data?.agentId ?? null,
      sessionKey: evt.data?.sessionKey ?? null,
      status: evt.data?.status ?? null,
      contractId: evt.data?.contractId ?? null,
      childContractId: evt.data?.childContractId ?? null,
      targetAgent: evt.data?.targetAgent ?? null,
      source: evt.data?.source ?? null,
      alertType: evt.data?.type ?? null,
      task: evt.data?.task ?? null,
      verdict: evt.data?.verdict ?? null,
      artifactCount: evt.data?.artifactCount ?? null,
      delegatedContractId: evt.data?.delegatedContractId ?? null,
    },
  };
}

function findTrackStart(events, {
  agentId,
  afterMs = 0,
  sessionKey = null,
  hookOnly = false,
}) {
  return events.find((evt) => (
    evt.type === "track_start"
    && evt.receivedAt >= afterMs
    && evt.data?.agentId === agentId
    && typeof evt.data?.sessionKey === "string"
    && (!sessionKey || evt.data.sessionKey === sessionKey)
    && (!hookOnly || evt.data.sessionKey.includes(":hook:"))
  )) || null;
}

function findTrackEnd(events, {
  agentId,
  sessionKey,
  afterMs = 0,
}) {
  return events.find((evt) => (
    evt.type === "track_end"
    && evt.receivedAt >= afterMs
    && evt.data?.agentId === agentId
    && evt.data?.sessionKey === sessionKey
  )) || null;
}

function findAlert(events, {
  type,
  afterMs = 0,
  source = null,
  targetAgent = null,
}) {
  return events.find((evt) => (
    evt.type === "alert"
    && evt.receivedAt >= afterMs
    && evt.data?.type === type
    && (!source || evt.data?.source === source)
    && (!targetAgent || evt.data?.targetAgent === targetAgent)
  )) || null;
}

function interestingEvents(events, topology = null) {
  const trackedAgentIds = new Set([
    topology?.callerAgentId,
    topology?.delegateAgentId,
    topology?.reviewerAgentId,
  ].filter(Boolean));
  return events
    .filter((evt) => (
      (evt.type === "track_start" || evt.type === "track_end")
      && trackedAgentIds.has(evt.data?.agentId)
    ) || (
      evt.type === "alert"
      && [
        "direct_session",
        "agent_task_assigned",
        "system_action_assign_task_result_delivered",
        "code_review_requested",
        "system_action_contract_result_delivered",
        "system_action_review_verdict_delivered",
        "runtime_wake_failed",
      ].includes(evt.data?.type)
    ))
    .map(summarizeEvent);
}

function makeCheckpoint(results, {
  id,
  name,
  status,
  elapsed,
  detail = null,
  errorCode = null,
}) {
  const entry = { id, name, status, elapsed };
  if (detail) entry.detail = detail;
  if (errorCode) entry.errorCode = errorCode;
  results.push(entry);
}

function buildStepIds(config) {
  const steps = ["reset"];
  if (config.beforeWakeLabel) steps.push("beforeWake");
  steps.push("wake", "firstStart");
  if (config.intermediateStepName) steps.push("intermediate");
  steps.push("firstEnd", "bridge", "resume", "resumeEnd", "bridgeContractTerminal");
  return Object.fromEntries(steps.map((step, index) => [step, index + 1]));
}

function buildBlockedProbeResult(testCase, {
  reason,
  errorCode,
  topology = null,
} = {}) {
  return {
    testCase,
    results: [
      {
        id: "blocked",
        name: "Runtime topology",
        status: "BLOCKED",
        elapsed: "0.0",
        detail: reason,
        ...(errorCode ? { errorCode } : {}),
      },
    ],
    duration: "0.0",
    pass: false,
    blocked: true,
    pathLabel: "DIRECT-SERVICE",
    directServiceSessionKey: null,
    bridgeAlertSeen: false,
    resumedSameSession: false,
    probeTopology: topology,
    probeEvents: [],
  };
}

async function ensureDirectedEdge(from, to, opts = {}) {
  const graph = await loadGraph();
  if (hasDirectedEdge(graph, from, to)) {
    return { added: false };
  }
  await addEdge(from, to, opts);
  return {
    added: true,
    cleanup: async () => {
      await removeEdge(from, to);
    },
  };
}

async function fetchContractStatus(contractId) {
  if (!contractId) return null;
  try {
    const contracts = await fetchJSON("/watchdog/work-items");
    const contract = contracts.find((entry) => entry.id === contractId);
    return contract?.status || null;
  } catch {
    return null;
  }
}

async function runDirectServiceProbe(testCase, sse, config) {
  const topology = config.topology || null;
  const callerAgentId = topology?.callerAgentId || null;
  let firstStart = null;
  let intermediateEvent = null;
  let firstEnd = null;
  let bridgeAlert = null;
  let resumedStart = null;
  let resumedEnd = null;
  let bridgeContractTerminal = null;
  let wakeContext = {};

  await fullReset();
  await sleep(1500);
  sse.resetBaseline();

  const startMs = Date.now();
  const elapsed = () => ((Date.now() - startMs) / 1000).toFixed(1);
  const results = [];
  const stepIds = buildStepIds(config);

  try {
    makeCheckpoint(results, {
      id: stepIds.reset,
      name: "Runtime reset",
      status: "PASS",
      elapsed: elapsed(),
    });

    if (config.beforeWake) {
      try {
        wakeContext = await config.beforeWake();
        makeCheckpoint(results, {
          id: stepIds.beforeWake,
          name: config.beforeWakeLabel,
          status: "PASS",
          elapsed: elapsed(),
          detail: config.beforeWakeDetail ? config.beforeWakeDetail(wakeContext) : null,
        });
      } catch (error) {
        makeCheckpoint(results, {
          id: stepIds.beforeWake,
          name: config.beforeWakeLabel,
          status: "FAIL",
          elapsed: elapsed(),
          detail: error?.message || String(error),
          errorCode: config.beforeWakeErrorCode || null,
        });
        return {
          testCase,
          results,
          duration: elapsed(),
          pass: false,
          pathLabel: "DIRECT-SERVICE",
          directServiceSessionKey: null,
          bridgeAlertSeen: false,
          resumedSameSession: false,
          probeTopology: topology,
          probeEvents: interestingEvents(sse.events, topology),
        };
      }
    }

    const wakeResult = await wakeAgentNow(callerAgentId, config.promptBuilder(wakeContext));
    if (!wakeResult?.ok) {
      makeCheckpoint(results, {
        id: stepIds.wake,
        name: "Direct service wake",
        status: "FAIL",
        elapsed: elapsed(),
        detail: JSON.stringify(wakeResult),
        errorCode: "E_DIRECT_SERVICE_WAKE_FAIL",
      });
      return {
        testCase,
        results,
        duration: elapsed(),
        pass: false,
        pathLabel: "DIRECT-SERVICE",
        directServiceSessionKey: null,
        bridgeAlertSeen: false,
        resumedSameSession: false,
        probeTopology: topology,
        probeEvents: interestingEvents(sse.events, topology),
      };
    }

    makeCheckpoint(results, {
      id: stepIds.wake,
      name: "Direct service wake",
      status: "PASS",
      elapsed: elapsed(),
      detail: wakeResult.runId || "wake requested",
    });

    const deadline = Date.now() + (testCase.timeoutMs || 240000);
    while (Date.now() < deadline) {
      if (!firstStart) {
        firstStart = findTrackStart(sse.events, {
          agentId: callerAgentId,
          afterMs: startMs,
          hookOnly: true,
        });
        if (firstStart) {
          makeCheckpoint(results, {
            id: stepIds.firstStart,
            name: "First hook session start",
            status: "PASS",
            elapsed: elapsed(),
            detail: firstStart.data.sessionKey,
          });
        }
      }

      if (config.intermediateStepName && !intermediateEvent) {
        intermediateEvent = config.findIntermediateEvent?.(sse.events, startMs) || null;
        if (intermediateEvent) {
          makeCheckpoint(results, {
            id: stepIds.intermediate,
            name: config.intermediateStepName,
            status: "PASS",
            elapsed: elapsed(),
            detail: config.intermediateDetail ? config.intermediateDetail(intermediateEvent) : null,
          });
        }
      }

      if (firstStart && !firstEnd) {
        firstEnd = findTrackEnd(sse.events, {
          agentId: callerAgentId,
          sessionKey: firstStart.data.sessionKey,
          afterMs: firstStart.receivedAt + 1,
        });
        if (firstEnd) {
          makeCheckpoint(results, {
            id: stepIds.firstEnd,
            name: "First hook session end",
            status: "PASS",
            elapsed: elapsed(),
            detail: firstEnd.data.status || "completed",
          });
        }
      }

      if (firstEnd && !bridgeAlert) {
        bridgeAlert = config.findBridgeAlert(sse.events, firstEnd.receivedAt + 1);
        if (bridgeAlert) {
          makeCheckpoint(results, {
            id: stepIds.bridge,
            name: config.bridgeStepName,
            status: "PASS",
            elapsed: elapsed(),
            detail: config.bridgeDetail ? config.bridgeDetail(bridgeAlert) : null,
          });
        }
      }

      if (firstEnd && !resumedStart) {
        resumedStart = findTrackStart(sse.events, {
          agentId: callerAgentId,
          afterMs: firstEnd.receivedAt + 1,
          sessionKey: firstStart.data.sessionKey,
        });
        if (resumedStart) {
          makeCheckpoint(results, {
            id: stepIds.resume,
            name: "Same-session resume",
            status: "PASS",
            elapsed: elapsed(),
            detail: resumedStart.data.sessionKey,
          });
        }
      }

      if (resumedStart && !resumedEnd) {
        const resumedEndEvent = findTrackEnd(sse.events, {
          agentId: callerAgentId,
          sessionKey: firstStart.data.sessionKey,
          afterMs: resumedStart.receivedAt + 1,
        });
        if (resumedEndEvent && TERMINAL_TRACK_STATUSES.has(resumedEndEvent.data?.status || "completed")) {
          resumedEnd = resumedEndEvent;
          makeCheckpoint(results, {
            id: stepIds.resumeEnd,
            name: "Resumed session end",
            status: "PASS",
            elapsed: elapsed(),
            detail: resumedEnd.data.status || "completed",
          });
        }
      }

      if (bridgeAlert && !bridgeContractTerminal) {
        const bridgeContractId = config.contractIdFromAlert
          ? config.contractIdFromAlert(bridgeAlert, firstStart)
          : (bridgeAlert?.data?.contractId || null);
        const bridgeContractStatus = await fetchContractStatus(bridgeContractId);
        if (["completed", "failed", "awaiting_input", "abandoned", "cancelled"].includes(bridgeContractStatus)) {
          bridgeContractTerminal = {
            contractId: bridgeContractId,
            status: bridgeContractStatus,
          };
          makeCheckpoint(results, {
            id: stepIds.bridgeContractTerminal,
            name: "Bridge contract terminal",
            status: "PASS",
            elapsed: elapsed(),
            detail: `${bridgeContractId} ${bridgeContractStatus}`,
          });
        }
      }

      const allSeen = Boolean(
        firstStart
        && firstEnd
        && bridgeAlert
        && resumedStart
        && resumedEnd
        && bridgeContractTerminal
        && (!config.intermediateStepName || intermediateEvent)
      );
      if (allSeen) break;

      await sleep(2000);
    }

    if (!firstStart) {
      makeCheckpoint(results, {
        id: stepIds.firstStart,
        name: "First hook session start",
        status: "FAIL",
        elapsed: elapsed(),
        detail: `${callerAgentId} hook session not observed`,
        errorCode: "E_DIRECT_SERVICE_START_MISS",
      });
    }

    if (config.intermediateStepName && !intermediateEvent) {
      makeCheckpoint(results, {
        id: stepIds.intermediate,
        name: config.intermediateStepName,
        status: "FAIL",
        elapsed: elapsed(),
        detail: config.intermediateMissDetail || `${config.intermediateStepName} not observed`,
        errorCode: config.intermediateErrorCode || null,
      });
    }

    if (firstStart && !firstEnd) {
      makeCheckpoint(results, {
        id: stepIds.firstEnd,
        name: "First hook session end",
        status: "FAIL",
        elapsed: elapsed(),
        detail: "initial direct session did not finish",
        errorCode: "E_DIRECT_SERVICE_END_MISS",
      });
    }

    if (firstEnd && !bridgeAlert) {
      makeCheckpoint(results, {
        id: stepIds.bridge,
        name: config.bridgeStepName,
        status: "FAIL",
        elapsed: elapsed(),
        detail: config.bridgeMissDetail,
        errorCode: config.bridgeErrorCode,
      });
    }

    if (firstEnd && !resumedStart) {
      makeCheckpoint(results, {
        id: stepIds.resume,
        name: "Same-session resume",
        status: "FAIL",
        elapsed: elapsed(),
        detail: `${callerAgentId} did not resume on the original sessionKey`,
        errorCode: "E_SAME_SESSION_RESUME_MISS",
      });
    }

    if (resumedStart && !resumedEnd) {
      makeCheckpoint(results, {
        id: stepIds.resumeEnd,
        name: "Resumed session end",
        status: "FAIL",
        elapsed: elapsed(),
        detail: "resumed direct session did not reach terminal track_end status",
        errorCode: "E_RESUMED_SESSION_STUCK",
      });
    }

    if (bridgeAlert && !bridgeContractTerminal) {
      const bridgeContractId = config.contractIdFromAlert
        ? config.contractIdFromAlert(bridgeAlert, firstStart)
        : (bridgeAlert?.data?.contractId || null);
      makeCheckpoint(results, {
        id: stepIds.bridgeContractTerminal,
        name: "Bridge contract terminal",
        status: "FAIL",
        elapsed: elapsed(),
        detail: bridgeContractId
          ? `${bridgeContractId} did not reach terminal state in /watchdog/work-items`
          : "bridge contract id missing",
        errorCode: "E_BRIDGE_CONTRACT_STUCK",
      });
    }

    const pass = Boolean(
      firstStart
      && firstEnd
      && bridgeAlert
      && resumedStart
      && resumedEnd
      && bridgeContractTerminal
      && (!config.intermediateStepName || intermediateEvent)
    );
    const finalStats = config.buildFinalStats
      ? config.buildFinalStats({ firstStart, intermediateEvent, bridgeAlert })
      : null;

    return {
      testCase,
      results,
      duration: elapsed(),
      pass,
      pathLabel: "DIRECT-SERVICE",
      contractId: config.contractIdFromAlert
        ? config.contractIdFromAlert(bridgeAlert, firstStart)
        : (bridgeAlert?.data?.contractId || firstStart?.data?.contractId || null),
      directServiceSessionKey: firstStart?.data?.sessionKey || null,
      bridgeAlertSeen: Boolean(bridgeAlert),
      resumedSameSession: Boolean(resumedStart),
      finalStats,
      probeTopology: topology,
      probeEvents: interestingEvents(sse.events, topology),
      ...(config.extraResult ? config.extraResult({ intermediateEvent, bridgeAlert }) : {}),
    };
  } finally {
    if (typeof wakeContext?.cleanup === "function") {
      try {
        await wakeContext.cleanup();
      } catch (error) {
        makeCheckpoint(results, {
          id: `${stepIds.bridgeContractTerminal}-cleanup`,
          name: "Probe cleanup",
          status: "FAIL",
          elapsed: elapsed(),
          detail: error?.message || String(error),
        });
      }
    }
  }
}

export async function runDirectServiceCreateTaskProbe(testCase, sse) {
  const topology = resolveDirectServiceProbeTopology();
  if (!topology.callerAgentId) {
    return buildBlockedProbeResult(testCase, {
      reason: "direct-service create_task preset requires at least 1 executor agent",
      errorCode: "E_DIRECT_SERVICE_CALLER_MISSING",
      topology,
    });
  }
  return runDirectServiceProbe(testCase, sse, {
    topology,
    promptBuilder: () => buildCreateTaskProbePrompt(),
    findBridgeAlert: (events, afterMs) => findAlert(events, {
      type: "system_action_contract_result_delivered",
      afterMs,
      targetAgent: topology.callerAgentId,
    }),
    bridgeStepName: "Execution result delivery",
    bridgeErrorCode: "E_EXECUTION_RETURN_MISS",
    bridgeMissDetail: "system_action_contract_result_delivered alert not observed",
    bridgeDetail: (alert) => `${alert.data.contractId} <- ${alert.data.childContractId}`,
    contractIdFromAlert: (alert, firstStart) => alert?.data?.childContractId || firstStart?.data?.contractId || null,
    buildFinalStats: ({ firstStart, bridgeAlert }) => (
      firstStart?.data?.sessionKey
        ? `session=${firstStart.data.sessionKey} delivery=${bridgeAlert?.data?.contractId || "none"} child=${bridgeAlert?.data?.childContractId || "none"}`
        : null
    ),
  });
}

export async function runDirectServiceAssignTaskProbe(testCase, sse) {
  const topology = resolveDirectServiceProbeTopology();
  if (!topology.callerAgentId || !topology.delegateAgentId) {
    return buildBlockedProbeResult(testCase, {
      reason: "direct-service assign_task preset requires at least 2 executor agents",
      errorCode: "E_ASSIGN_TASK_TOPOLOGY_BLOCKED",
      topology,
    });
  }
  return runDirectServiceProbe(testCase, sse, {
    topology,
    beforeWake: async () => ensureDirectedEdge(topology.callerAgentId, topology.delegateAgentId, { label: "delegate" }),
    beforeWakeLabel: "Assign edge prepared",
    beforeWakeDetail: (context) => (
      context?.added
        ? `${topology.callerAgentId} -> ${topology.delegateAgentId}`
        : `${topology.callerAgentId} -> ${topology.delegateAgentId} (existing)`
    ),
    beforeWakeErrorCode: "E_ASSIGN_EDGE_PREP_FAIL",
    promptBuilder: () => buildAssignTaskProbePrompt({ delegateAgentId: topology.delegateAgentId }),
    intermediateStepName: "Assign task accepted",
    intermediateErrorCode: "E_ASSIGN_TASK_REQUEST_MISS",
    intermediateMissDetail: "agent_task_assigned alert not observed",
    findIntermediateEvent: (events, afterMs) => findAlert(events, {
      type: "agent_task_assigned",
      afterMs,
      source: topology.callerAgentId,
      targetAgent: topology.delegateAgentId,
    }),
    intermediateDetail: (alert) => `${alert.data?.targetAgent || "unknown"} <- ${alert.data?.contractId || "none"}`,
    findBridgeAlert: (events, afterMs) => findAlert(events, {
      type: "system_action_assign_task_result_delivered",
      afterMs,
      source: topology.delegateAgentId,
      targetAgent: topology.callerAgentId,
    }),
    bridgeStepName: "Assign task result delivery",
    bridgeErrorCode: "E_ASSIGN_TASK_RETURN_MISS",
    bridgeMissDetail: "system_action_assign_task_result_delivered alert not observed",
    bridgeDetail: (alert) => `${alert.data?.contractId || "none"} <- ${alert.data?.delegatedContractId || "none"} status=${alert.data?.status || "unknown"}`,
    contractIdFromAlert: (alert, firstStart) => alert?.data?.contractId || firstStart?.data?.contractId || null,
    buildFinalStats: ({ firstStart, intermediateEvent, bridgeAlert }) => (
      firstStart?.data?.sessionKey
        ? `session=${firstStart.data.sessionKey} child=${intermediateEvent?.data?.contractId || "none"} delivery=${bridgeAlert?.data?.contractId || "none"} delegated=${bridgeAlert?.data?.delegatedContractId || "none"}`
        : null
    ),
    extraResult: ({ intermediateEvent, bridgeAlert }) => ({
      delegatedContractId: bridgeAlert?.data?.delegatedContractId || intermediateEvent?.data?.contractId || null,
      delegatedStatus: bridgeAlert?.data?.status || null,
    }),
  });
}

export async function runDirectServiceRequestReviewProbe(testCase, sse) {
  const topology = resolveDirectServiceProbeTopology();
  if (!topology.callerAgentId) {
    return buildBlockedProbeResult(testCase, {
      reason: "direct-service request_review preset requires at least 1 executor agent",
      errorCode: "E_REVIEW_CALLER_MISSING",
      topology,
    });
  }
  if (!topology.reviewerAgentId) {
    return buildBlockedProbeResult(testCase, {
      reason: "direct-service request_review preset requires a reviewer agent in current runtime",
      errorCode: "E_REVIEW_TOPOLOGY_BLOCKED",
      topology,
    });
  }
  return runDirectServiceProbe(testCase, sse, {
    topology,
    beforeWake: async () => {
      const context = await prepareReviewFixture();
      const edge = await ensureDirectedEdge(topology.callerAgentId, topology.reviewerAgentId, { label: "review" });
      return {
        ...context,
        cleanup: edge.cleanup || null,
      };
    },
    beforeWakeLabel: "Review fixture prepared",
    beforeWakeErrorCode: "E_REVIEW_FIXTURE_PREP_FAIL",
    beforeWakeDetail: ({ artifactPath }) => artifactPath || null,
    promptBuilder: (context) => buildReviewProbePrompt(context),
    intermediateStepName: "Review request accepted",
    intermediateErrorCode: "E_REVIEW_REQUEST_MISS",
    intermediateMissDetail: "code_review_requested alert not observed",
    findIntermediateEvent: (events, afterMs) => findAlert(events, {
      type: "code_review_requested",
      afterMs,
      source: topology.callerAgentId,
      targetAgent: topology.reviewerAgentId,
    }),
    intermediateDetail: (alert) => `artifacts=${alert.data?.artifactCount ?? "unknown"}`,
    findBridgeAlert: (events, afterMs) => findAlert(events, {
      type: "system_action_review_verdict_delivered",
      afterMs,
      source: topology.reviewerAgentId,
      targetAgent: topology.callerAgentId,
    }),
    bridgeStepName: "Review verdict delivery",
    bridgeErrorCode: "E_REVIEW_RETURN_MISS",
    bridgeMissDetail: "system_action_review_verdict_delivered alert not observed",
    bridgeDetail: (alert) => `${alert.data?.contractId || "none"} verdict=${alert.data?.verdict || "unknown"}`,
    contractIdFromAlert: (alert, firstStart) => alert?.data?.contractId || firstStart?.data?.contractId || null,
    buildFinalStats: ({ firstStart, bridgeAlert }) => (
      firstStart?.data?.sessionKey
        ? `session=${firstStart.data.sessionKey} delivery=${bridgeAlert?.data?.contractId || "none"} verdict=${bridgeAlert?.data?.verdict || "none"}`
        : null
    ),
    extraResult: ({ intermediateEvent, bridgeAlert }) => ({
      reviewRequested: Boolean(intermediateEvent),
      reviewVerdict: bridgeAlert?.data?.verdict || null,
    }),
  });
}

export async function runDirectServiceCase(testCase, sse) {
  if (testCase?.id === "direct-service-create-task-return") {
    return runDirectServiceCreateTaskProbe(testCase, sse);
  }
  if (testCase?.id === "direct-service-assign-task-return") {
    return runDirectServiceAssignTaskProbe(testCase, sse);
  }
  if (testCase?.id === "direct-service-request-review-return") {
    return runDirectServiceRequestReviewProbe(testCase, sse);
  }
  throw new Error(`Unknown direct-service case: ${testCase?.id || "unknown"}`);
}
