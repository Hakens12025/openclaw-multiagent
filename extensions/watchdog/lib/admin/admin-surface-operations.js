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
  changeAgentConstraints,
  changeAgentDescription,
  changeAgentPrimaryModel,
  changeAgentName,
  changeAgentRole,
  changeAgentSkills,
  changeAgentTools,
  createAgentDefinition,
  deleteAgentDefinition,
  hardDeleteAgentDefinition,
} from "../agent/agent-admin.js";
import {
  joinLocalAgentDefinition,
} from "../agent/agent-enrollment.js";
import { takeOverLocalAgentGuidance } from "../agent/agent-enrollment-guidance.js";
import { startTestRun } from "../test-runs.js";
import { normalizeTestRunCleanMode } from "../test-run-presets.js";
import { dispatchAcceptIngressMessage } from "../ingress/dispatch-entry.js";
import { normalizeQQIngressSource } from "../qq-reply-target.js";
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
  controlAutomationGovernance,
} from "../automation/automation-admin.js";
import {
  mutateGraphEdge,
  composeGraphLoop,
  composeGraphGroup,
  deleteGraphLoop,
  repairGraphLoop,
} from "./admin-surface-graph-operations.js";
import { authorSkillSurface } from "./skill-author.js";
import { buildWikiRagIndex } from "../operator/wiki-rag-store.js";
import { buildKbIndex } from "../operator/knowledge-base.js";
import {
  addKnowledgeBaseSource,
  removeKnowledgeBaseSource,
  removeKnowledgeBase,
  configureKnowledgeBase,
} from "../operator/knowledge-base-registry.js";
import { saveKnowledgeEvalSet, deleteKnowledgeEvalSet } from "../operator/knowledge-eval-registry.js";
import { runKnowledgeEval, runKnowledgeFaithfulness } from "../operator/knowledge-eval-runner.js";
import { createChartDefinition, moveChartPosition } from "./chart-operations.js";
import {
  resolveLoopTargetId,
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
  "agents.tools": createAgentAdminOperation(changeAgentTools, (payload) => ({
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
  // P4 安全阀（必备非可选）：熔断 governanceSnapshot / 复活 retired profile。
  "automations.governance": ({ payload, logger, onAlert }) => controlAutomationGovernance({
    payload,
    logger,
    onAlert,
  }),
});

const ADMIN_SURFACE_OPERATION_HANDLERS = Object.freeze({
  ...AGENT_ADMIN_SURFACE_OPERATIONS,
  "graph.edge.add": (args) => mutateGraphEdge({ ...args, mode: "add" }),
  "graph.edge.delete": (args) => mutateGraphEdge({ ...args, mode: "delete" }),
  "graph.loop.compose": composeGraphLoop,
  "graph.group.compose": composeGraphGroup,
  "graph.loop.delete": deleteGraphLoop,
  "graph.loop.repair": repairGraphLoop,
  "skills.create": authorSkillSurface,
  "runtime.reset": ({ logger, onAlert, runtimeContext }) => resetRuntimeState({
    logger,
    onAlert,
    runtimeApi: runtimeContext?.api || null,
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
    runtimeApi: runtimeContext?.api || null,
  }, null, logger),
  "test_runs.start": ({ payload, logger, runtimeContext, surfaceId }) => ({
    ok: true,
    run: startTestRun({
      presetId: payload.presetId,
      caseId: payload.caseId,
      cleanMode: normalizeTestRunCleanMode(payload.cleanMode),
      originDraftId: runtimeContext?.originDraftId || null,
      originExecutionId: runtimeContext?.originExecutionId || null,
      originSurfaceId: runtimeContext?.originSurfaceId || surfaceId,
      runtimeContext,
    }, logger),
  }),
  // wiki-only RAG 增量 reindex。buildWikiRagIndex 永远返回 {ok:true,...}（degraded
  // 时也是 ok:true）—— executor 把 {ok:false} 当失败会回滚，故此处必须保持 ok:true。
  "apply.wiki_reindex": async ({ payload, logger }) => ({ ...(await buildWikiRagIndex({ force: payload?.force === true, logger })) }),
  // 知识库:加源(自动建索引,库不存在则新建)。addKnowledgeBaseSource 校验失败会 throw（safe
  // surface 无 pre-apply 快照→无回滚副作用,throw 即清晰失败,无状态改动）。buildKbIndex 永 ok:true。
  "apply.knowledge_add": async ({ payload, logger }) => {
    const kb = await addKnowledgeBaseSource(
      normalizeString(payload?.kbId),
      normalizeString(payload?.sourcePath),
      {
        label: normalizeString(payload?.label) || undefined,
        scope: normalizeString(payload?.scope) || undefined,
        agentId: normalizeString(payload?.agentId) || undefined,
      },
    );
    const index = await buildKbIndex(kb.id, { force: payload?.force === true, logger });
    return { ok: true, knowledgeBase: kb, index };
  },
  // 知识库:重建索引。buildKbIndex 对未知库返回 {ok:false}→包成 ok:true+reindexed:false
  // 避免 executor 回滚（reindex 无可回滚副作用,未知库只是无操作）。
  "apply.knowledge_reindex": async ({ payload, logger }) => {
    const result = await buildKbIndex(normalizeString(payload?.kbId), { force: payload?.force === true, logger });
    return result.ok ? { ok: true, reindexed: true, ...result } : { ok: true, reindexed: false, error: result.error };
  },
  // 知识库:删源或删整库(destructive,confirmation:explicit)。给 sourcePath→只删该源;
  // 否则删整库。removeKnowledgeBase('wiki') 在注册表层 throw(内置不可删)。
  "apply.knowledge_remove": async ({ payload }) => {
    const kbId = normalizeString(payload?.kbId);
    const sourcePath = normalizeString(payload?.sourcePath);
    const result = sourcePath
      ? await removeKnowledgeBaseSource(kbId, sourcePath)
      : await removeKnowledgeBase(kbId);
    return { ok: true, ...result };
  },
  // 知识库评测:新建/覆盖评测集。cases 容忍数组或 JSON 串(防 planner/HTTP 形态差异)。
  "apply.knowledge_eval_set_save": async ({ payload }) => {
    let cases = payload?.cases;
    if (typeof cases === "string") { try { cases = JSON.parse(cases); } catch { cases = []; } }
    const evalSet = await saveKnowledgeEvalSet({
      kbId: normalizeString(payload?.kbId),
      evalSetId: normalizeString(payload?.evalSetId),
      label: normalizeString(payload?.label) || undefined,
      topK: payload?.topK,
      cases: Array.isArray(cases) ? cases : [],
    });
    return { ok: true, evalSet };
  },
  // 知识库评测:跑评测集。未知/空集 → ok:true+ran:false(避免 executor 把 ok:false 当失败回滚;评测无副作用)。
  "apply.knowledge_eval_run": async ({ payload, logger }) => {
    const result = await runKnowledgeEval(normalizeString(payload?.kbId), normalizeString(payload?.evalSetId), { logger });
    return result.ok ? { ok: true, ran: true, ...result } : { ok: true, ran: false, error: result.error };
  },
  // 知识库评测:跑生成侧 faithfulness/context-precision(本地 qwen judge;需 case 带 answer)。无副作用→不回滚。
  "apply.knowledge_eval_faithfulness": async ({ payload, logger }) => {
    const result = await runKnowledgeFaithfulness(normalizeString(payload?.kbId), normalizeString(payload?.evalSetId), { logger });
    return result.ok ? { ok: true, ran: true, ...result } : { ok: true, ran: false, error: result.error };
  },
  // 知识库评测:删评测集(幂等)。
  "apply.knowledge_eval_set_remove": async ({ payload }) => {
    const result = await deleteKnowledgeEvalSet(normalizeString(payload?.kbId), normalizeString(payload?.evalSetId));
    return { ok: true, ...result };
  },
  // 知识库:配置时态/元数据/分歧规则(Phase5 的 on-switch)。metadataRules/conflict 容忍对象或 JSON 串。需重建索引生效。
  "apply.knowledge_configure": async ({ payload }) => {
    const parseMaybe = (v) => {
      if (typeof v !== "string") return v;
      try { return JSON.parse(v); } catch { return undefined; }
    };
    const kb = await configureKnowledgeBase(normalizeString(payload?.kbId), {
      temporal: payload?.temporal,
      metadataRules: parseMaybe(payload?.metadataRules),
      conflict: parseMaybe(payload?.conflict),
    });
    return { ok: true, knowledgeBase: kb };
  },
  // 图表(非真值控制面,charts.json,knowledge-bases.json 同级)。viz-master 是 chart 面唯一写入者。
  // 校验失败 createChartDefinition/moveChartPosition 内部捕获成 {ok:false,error}——不抛过 handler 边界。
  "apply.chart_create": createChartDefinition,
  "apply.chart_move": moveChartPosition,
  "test.inject": ({ payload, logger, runtimeContext }) => {
    if (!runtimeContext?.api) {
      throw new Error("missing runtime context for test.inject");
    }
    const operatorContext = normalizeOperatorContext({
      originDraftId: runtimeContext?.originDraftId,
      originExecutionId: runtimeContext?.originExecutionId,
      originSurfaceId: runtimeContext?.originSurfaceId,
    });
    return dispatchAcceptIngressMessage(payload.message, {
      source: normalizeQQIngressSource(payload.source) === "qq" ? "qq" : "webui",
      replyTo: payload.replyTo && typeof payload.replyTo === "object" ? payload.replyTo : undefined,
      operatorContext,
      ingressDirective: payload,
      api: runtimeContext.api,
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

// B3 兜底网：destructive/structural surface 落地前自动拍结构快照（best-effort），snapshotId 回传供回滚。
// 这是所有 apply 路径（operator executeCliSystemSurface / HTTP / change-set）的共同 choke。
// 懒加载 import 避开 admin-surface-registry↔admin-surface-operations 既有静态循环。
async function maybePreApplyStructureSnapshot(surfaceId, logger) {
  try {
    const { getAdminSurface } = await import("./admin-surface-registry.js");
    const risk = getAdminSurface(surfaceId)?.risk || null;
    if (risk !== "destructive" && risk !== "structural") {
      return null;
    }
    // 非真值控制面族(knowledge/chart)即便 risk=destructive 也不拍结构快照:structure-snapshot
    // 只覆盖 graph/config，捕不到 KB/chart 内容——拍了反而给出误导性的"可回滚"承诺。skip→null。
    const { resolveSurfaceFamily, NON_TRUTH_BACKED_FAMILIES } = await import("../cli-system/meta-agent-surface-ownership.js");
    if (NON_TRUTH_BACKED_FAMILIES.has(resolveSurfaceFamily(surfaceId))) {
      return null;
    }
    const { captureStructureSnapshot } = await import("../control-plane/structure-snapshot.js");
    const snap = await captureStructureSnapshot({ reason: `pre-apply:${surfaceId}`, label: `pre-apply:${surfaceId}` });
    return snap?.id || null;
  } catch (error) {
    logger?.warn?.(`[watchdog] pre-apply structure snapshot skipped for ${surfaceId}: ${error.message}`);
    return null;
  }
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
  const preApplySnapshot = await maybePreApplyStructureSnapshot(surfaceId, logger);
  let result;
  try {
    result = await handler({
      surfaceId,
      payload: normalizeRecord(payload),
      logger,
      onAlert,
      runtimeContext,
    });
  } catch (error) {
    // ⑪ The pre-apply snapshot was captured but NEVER used on a handler THROW — a structural surface that
    // half-mutated then threw left the system half-applied with no rollback. Restore it here at the single
    // choke so every caller (operator / HTTP / change-set) inherits auto-restore, attach the rollback
    // outcome to the re-thrown error, then re-throw so callers still see the failure. Reuses the existing
    // snapshot mechanism (lazy import to avoid the registry↔operations cycle); no new system, no branching.
    if (preApplySnapshot) {
      const { restoreStructureSnapshot } = await import("../control-plane/structure-snapshot.js");
      error.preApplyRollback = await restoreStructureSnapshot(preApplySnapshot).catch((e) => ({ ok: false, error: e.message }));
    }
    throw error;
  }
  if (preApplySnapshot && result && typeof result === "object" && !Array.isArray(result)) {
    return { ...result, preApplySnapshot };
  }
  return result;
}
