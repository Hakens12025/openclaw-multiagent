import {
  createAgentJoinDefinition,
  deleteAgentJoinDefinition,
  disableAgentJoinDefinition,
  enableAgentJoinDefinition,
  updateAgentJoinDefinition,
} from "../agent/agent-join-admin.js";
import {
  changeDefaultAgentHeartbeat,
  changeDefaultAgentPrimaryModel,
  changeDefaultAgentSkills,
  changeAgentHeartbeat,
  changeAgentPolicies,
  changeAgentCardFormats,
  changeAgentCardTools,
  changeAgentConstraints,
  changeAgentDescription,
  changeAgentPrimaryModel,
  changeAgentName,
  changeAgentRole,
  changeAgentSkills,
  createAgentDefinition,
  deleteAgentDefinition,
  hardDeleteAgentDefinition,
} from "../agent/agent-admin.js";
import {
  joinLocalAgentDefinition,
} from "../agent/agent-enrollment.js";
import { takeOverLocalAgentGuidance } from "../agent/agent-enrollment-guidance.js";
import { startTestRun } from "../test-runs.js";
import { dispatchAcceptIngressMessage } from "../ingress/dispatch-entry.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";
import { normalizeOperatorContext } from "../operator/operator-context.js";
import { resetRuntimeState } from "./runtime-admin.js";
import {
  interruptLoopRound,
  resumeLoopRound,
} from "../loop/loop-round-runtime.js";
import {
  createScheduleDefinition,
  deleteScheduleDefinition,
  disableScheduleDefinition,
  enableScheduleDefinition,
  updateScheduleDefinition,
} from "../schedule/schedule-admin.js";
import {
  createAutomationDefinition,
  deleteAutomationDefinition,
  disableAutomationDefinition,
  enableAutomationDefinition,
  runAutomationDefinition,
  updateAutomationDefinition,
} from "../automation/automation-admin.js";
import {
  mutateGraphEdge,
  composeGraphLoop,
  repairGraphLoop,
} from "./admin-surface-graph-operations.js";
import {
  resolveLoopTargetId,
  buildAdminWakeup,
  startRuntimeLoop,
} from "./admin-surface-loop-operations.js";

function createAgentAdminOperation(action, mapPayload) {
  return ({ payload, logger, onAlert }) => action({
    ...mapPayload(normalizeRecord(payload)),
    logger,
    onAlert,
  });
}

function resolveConstraintOperationPayload(payload) {
  const normalizedPayload = normalizeRecord(payload);
  const constraints = normalizedPayload.constraints && typeof normalizedPayload.constraints === "object"
    ? normalizedPayload.constraints
    : normalizedPayload;
  return {
    agentId: normalizedPayload.agentId,
    serialExecution: constraints.serialExecution,
    maxConcurrent: constraints.maxConcurrent,
    timeoutSeconds: constraints.timeoutSeconds,
    maxRetry: constraints.maxRetry,
  };
}

const AGENT_ADMIN_SURFACE_OPERATIONS = Object.freeze({
  "agents.create": createAgentAdminOperation(createAgentDefinition, (payload) => ({
    id: payload.id,
    model: payload.model,
    role: payload.role,
  })),
  "agents.join": ({ payload, logger, onAlert }) => joinLocalAgentDefinition({
    payload,
    logger,
    onAlert,
  }),
  "agents.guidance.takeover": ({ payload, logger, onAlert }) => takeOverLocalAgentGuidance({
    payload,
    logger,
    onAlert,
  }),
  "agents.defaults.model": createAgentAdminOperation(changeDefaultAgentPrimaryModel, (payload) => ({
    model: payload.model,
  })),
  "agents.defaults.heartbeat": createAgentAdminOperation(changeDefaultAgentHeartbeat, (payload) => ({
    every: payload.every,
  })),
  "agents.defaults.skills": createAgentAdminOperation(changeDefaultAgentSkills, (payload) => ({
    skills: payload.skills,
  })),
  "agents.model": createAgentAdminOperation(changeAgentPrimaryModel, (payload) => ({
    agentId: payload.agentId,
    model: payload.model,
  })),
  "agents.heartbeat": createAgentAdminOperation(changeAgentHeartbeat, (payload) => ({
    agentId: payload.agentId,
    every: payload.every,
  })),
  "agents.policy": createAgentAdminOperation(changeAgentPolicies, (payload) => ({
    agentId: payload.agentId,
    gateway: payload.gateway,
    protected: payload.protected,
    ingressSource: payload.ingressSource,
    specialized: payload.specialized,
  })),
  "agents.constraints": createAgentAdminOperation(changeAgentConstraints, resolveConstraintOperationPayload),
  "agents.name": createAgentAdminOperation(changeAgentName, (payload) => ({
    agentId: payload.agentId,
    name: payload.name,
  })),
  "agents.description": createAgentAdminOperation(changeAgentDescription, (payload) => ({
    agentId: payload.agentId,
    description: payload.description,
  })),
  "agents.card.tools": createAgentAdminOperation(changeAgentCardTools, (payload) => ({
    agentId: payload.agentId,
    tools: payload.tools,
  })),
  "agents.card.formats": createAgentAdminOperation(changeAgentCardFormats, (payload) => ({
    agentId: payload.agentId,
    inputFormats: payload.inputFormats,
    outputFormats: payload.outputFormats,
  })),
  "agents.role": createAgentAdminOperation(changeAgentRole, (payload) => ({
    agentId: payload.agentId,
    role: payload.role,
  })),
  "agents.skills": createAgentAdminOperation(changeAgentSkills, (payload) => ({
    agentId: payload.agentId,
    skills: payload.skills,
  })),
  "agents.delete": createAgentAdminOperation(deleteAgentDefinition, (payload) => ({
    agentId: payload.agentId,
  })),
  "agents.hard_delete": createAgentAdminOperation(hardDeleteAgentDefinition, (payload) => ({
    agentId: payload.agentId,
  })),
  "agent_joins.create": ({ payload, logger, onAlert }) => createAgentJoinDefinition({
    payload,
    logger,
    onAlert,
  }),
  "agent_joins.update": ({ payload, logger, onAlert }) => updateAgentJoinDefinition({
    payload,
    logger,
    onAlert,
  }),
  "agent_joins.enable": ({ payload, logger, onAlert }) => enableAgentJoinDefinition({
    payload,
    logger,
    onAlert,
  }),
  "agent_joins.disable": ({ payload, logger, onAlert }) => disableAgentJoinDefinition({
    payload,
    logger,
    onAlert,
  }),
  "agent_joins.delete": ({ payload, logger, onAlert }) => deleteAgentJoinDefinition({
    payload,
    logger,
    onAlert,
  }),
  "schedules.create": ({ payload, logger, onAlert, runtimeContext }) => createScheduleDefinition({
    payload,
    logger,
    onAlert,
    runtimeContext,
  }),
  "schedules.update": ({ payload, logger, onAlert, runtimeContext }) => updateScheduleDefinition({
    payload,
    logger,
    onAlert,
    runtimeContext,
  }),
  "schedules.enable": ({ payload, logger, onAlert, runtimeContext }) => enableScheduleDefinition({
    payload,
    logger,
    onAlert,
    runtimeContext,
  }),
  "schedules.disable": ({ payload, logger, onAlert, runtimeContext }) => disableScheduleDefinition({
    payload,
    logger,
    onAlert,
    runtimeContext,
  }),
  "schedules.delete": ({ payload, logger, onAlert, runtimeContext }) => deleteScheduleDefinition({
    payload,
    logger,
    onAlert,
    runtimeContext,
  }),
  "automations.create": ({ payload, logger, onAlert, runtimeContext }) => createAutomationDefinition({
    payload,
    logger,
    onAlert,
    runtimeContext,
  }),
  "automations.update": ({ payload, logger, onAlert, runtimeContext }) => updateAutomationDefinition({
    payload,
    logger,
    onAlert,
    runtimeContext,
  }),
  "automations.enable": ({ payload, logger, onAlert, runtimeContext }) => enableAutomationDefinition({
    payload,
    logger,
    onAlert,
    runtimeContext,
  }),
  "automations.disable": ({ payload, logger, onAlert, runtimeContext }) => disableAutomationDefinition({
    payload,
    logger,
    onAlert,
    runtimeContext,
  }),
  "automations.delete": ({ payload, logger, onAlert, runtimeContext }) => deleteAutomationDefinition({
    payload,
    logger,
    onAlert,
    runtimeContext,
  }),
  "automations.run": ({ payload, logger, onAlert, runtimeContext }) => runAutomationDefinition({
    payload,
    logger,
    onAlert,
    runtimeContext,
  }),
});

const ADMIN_SURFACE_OPERATION_HANDLERS = Object.freeze({
  ...AGENT_ADMIN_SURFACE_OPERATIONS,
  "graph.edge.add": (args) => mutateGraphEdge({ ...args, mode: "add" }),
  "graph.edge.delete": (args) => mutateGraphEdge({ ...args, mode: "delete" }),
  "graph.loop.compose": composeGraphLoop,
  "graph.loop.repair": repairGraphLoop,
  "runtime.reset": ({ logger, onAlert }) => resetRuntimeState({
    logger,
    onAlert,
  }),
  "runtime.loop.start": startRuntimeLoop,
  "runtime.loop.interrupt": ({ payload, logger }) => interruptLoopRound({
    loopId: resolveLoopTargetId(payload),
    reason: normalizeString(payload.reason) || "manual_interrupt",
  }, logger),
  "runtime.loop.resume": ({ payload, logger, runtimeContext }) => resumeLoopRound({
    loopId: resolveLoopTargetId(payload),
    startStage: normalizeString(payload.startStage) || null,
    reason: normalizeString(payload.reason) || "manual_resume",
  }, buildAdminWakeup(runtimeContext, logger), logger),
  "test_runs.start": ({ payload, logger, runtimeContext, surfaceId }) => ({
    ok: true,
    run: startTestRun({
      presetId: payload.presetId,
      cleanMode: payload.cleanMode || "session-clean",
      originDraftId: runtimeContext?.originDraftId || null,
      originExecutionId: runtimeContext?.originExecutionId || null,
      originSurfaceId: surfaceId,
      runtimeContext,
    }, logger),
  }),
  "test.inject": ({ payload, logger, runtimeContext }) => {
    if (!runtimeContext?.api || typeof runtimeContext.enqueue !== "function" || typeof runtimeContext.wakePlanner !== "function") {
      throw new Error("missing runtime context for test.inject");
    }
    const operatorContext = normalizeOperatorContext({
      originDraftId: runtimeContext?.originDraftId,
      originExecutionId: runtimeContext?.originExecutionId,
      originSurfaceId: runtimeContext?.originSurfaceId,
    });
    return dispatchAcceptIngressMessage(payload.message, {
      source: payload.source === "qq" ? "qq" : "webui",
      replyTo: payload.replyTo && typeof payload.replyTo === "object" ? payload.replyTo : undefined,
      operatorContext,
      ingressDirective: payload,
      api: runtimeContext.api,
      enqueue: runtimeContext.enqueue,
      wakePlanner: runtimeContext.wakePlanner,
      logger,
    });
  },
});

export function getAdminSurfaceOperationHandler(surfaceId) {
  return ADMIN_SURFACE_OPERATION_HANDLERS[surfaceId] || null;
}

export function hasAdminSurfaceOperationHandler(surfaceId) {
  return typeof getAdminSurfaceOperationHandler(surfaceId) === "function";
}

export async function executeAdminSurfaceOperation({
  surfaceId,
  payload = {},
  logger = null,
  onAlert = null,
  runtimeContext = null,
} = {}) {
  const handler = getAdminSurfaceOperationHandler(surfaceId);
  if (!handler) {
    throw new Error(`unsupported admin surface: ${surfaceId}`);
  }
  return handler({
    surfaceId,
    payload: normalizeRecord(payload),
    logger,
    onAlert,
    runtimeContext,
  });
}
