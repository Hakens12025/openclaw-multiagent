import {
  addGraphEdgeViaSurface,
  deleteGraphEdgeViaSurface,
} from "./infra.js";
import {
  hasDirectedEdge,
  loadGraph,
} from "../agent/agent-graph.js";
import {
  AGENT_ROLE,
  getAgentRole,
  listAgentIdsByRole,
  listRuntimeAgentIds,
  resolvePreferredExecutorAgentId,
} from "../agent/agent-identity.js";
import {
  buildCreateTaskProbePrompt,
  buildReviewProbePrompt,
  buildAssignTaskProbePrompt,
  prepareReviewFixture,
} from "./suite-direct-service-prompts.js";
import { findAlert } from "./suite-direct-service-events.js";
import {
  buildBlockedProbeResult,
  runDirectServiceProbe,
} from "./suite-direct-service-probe.js";

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

async function ensureDirectedEdge(from, to, opts = {}) {
  const graph = await loadGraph();
  if (hasDirectedEdge(graph, from, to)) {
    return { added: false };
  }
  const addResult = await addGraphEdgeViaSurface(from, to, opts);
  if (!addResult?.ok) {
    throw new Error(addResult?.error || `failed to add graph edge ${from} -> ${to}`);
  }
  return {
    added: true,
    cleanup: async () => {
      const deleteResult = await deleteGraphEdgeViaSurface(from, to);
      if (!deleteResult?.ok) {
        throw new Error(deleteResult?.error || `failed to delete graph edge ${from} -> ${to}`);
      }
    },
  };
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
      type: "system_action_runtime_result_delivered",
      afterMs,
      targetAgent: topology.callerAgentId,
    }),
    bridgeStepName: "Execution result delivery",
    bridgeErrorCode: "E_EXECUTION_RETURN_MISS",
    bridgeMissDetail: "system_action_runtime_result_delivered alert not observed",
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
