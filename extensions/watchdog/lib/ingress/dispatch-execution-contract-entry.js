// lib/dispatch-execution-contract-entry.js — execution-contract ingress handling

import { join } from "node:path";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { buildHopExpectations } from "../contract/contract-expectations.js";
import {
  rememberDispatchChainOrigin,
  rememberDispatchChainOrigins,
} from "../store/contract-flow-store.js";
import { persistContractById } from "../contract/contracts.js";
import { buildLineage, ensureLineage, mintRunId, mintThreadId, normalizeLineage } from "../contract/contract-lineage.js";
import { wireContractCreated } from "../archive/run-event-wiring.js";
import { normalizeString } from "../core/normalize.js";
import { normalizeDeliveryTargets } from "../routing/delivery/delivery-targets.js";
import { annotateExecutionContract, buildRuntimeContext } from "../protocol/protocol-primitives.js";
import { attachOperatorContext } from "../operator/operator-context.js";
import { attachRouteMetadataDiagnostics } from "../routing/route-metadata.js";
import { attachSystemActionDeliveryTicket } from "../routing/delivery/delivery-system-action-ticket.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { mintContractId } from "../core/mint-id.js";
import {
  buildInitialTaskStageRuntime,
  deriveDisplayPhases,
  deriveDisplayTotal,
} from "../stage/task-stage-plan.js";
import { buildTaskStagePlanFromTask } from "../stage/task-stage-planner.js";
import {
  canAutoWakeForTaskRuntime,
} from "../agent/agent-activation-policy.js";
import {
  buildGatewayReplyTarget,
  getAgentIdentitySnapshot,
  isQQIngressAgent,
  listRuntimeAgentIds,
} from "../agent/agent-identity.js";
import {
  dispatchResolveFirstHop,
  dispatchRouteExecutionContract,
  resolveRouteAfterAgentEndTarget,
} from "../routing/dispatch/dispatch-graph-policy.js";
import {
  listDispatchTargetIds,
} from "../routing/dispatch/dispatch-runtime-state.js";
import { buildAgentMainSessionKey } from "../session/session-keys.js";
import {
  assertLiveQQIngressReplyTarget,
  assertLiveQQReplyTarget,
  isQQIngressSource,
  normalizeQQIngressSource,
} from "../routing/qq-reply-target.js";

export function dispatchResolveIngressReplyTarget(source, replyTo) {
  const normalizedSource = normalizeQQIngressSource(source) || source;
  const isQQSource = isQQIngressSource(source);
  assertLiveQQIngressReplyTarget(source, replyTo);
  const defaultReplyTo = buildGatewayReplyTarget(normalizedSource);
  const targetIsQQBridge = isQQSource && isQQIngressAgent(replyTo?.agentId || defaultReplyTo?.agentId || null);

  if (replyTo?.agentId) {
    return {
      ...replyTo,
      ...(targetIsQQBridge && !replyTo.channel ? { channel: "qqbot" } : {}),
    };
  }

  return {
    ...defaultReplyTo,
    ...(targetIsQQBridge ? { channel: "qqbot" } : {}),
  };
}

// 单前台(备忘录156 §三方向B):controller 是唯一 gateway/bridge。渠道来源(qq 等)
// 没有专属 gateway agent → 源解析落空时归 webui 前台。两桥时代的"跨桥改判归
// controller"分支已随 QQ 桥壳 agent 退役删除——单 gateway 下源解析与 replyTo
// 都落不到第二个 gateway agent 上,改判分支恒为死码。
function resolveIngressDispatchOwnerAgent(source, effectiveReplyTo, dispatchOwnerAgentId = null) {
  const explicitDispatchOwnerAgentId = typeof dispatchOwnerAgentId === "string" && dispatchOwnerAgentId.trim()
    ? dispatchOwnerAgentId.trim()
    : null;
  if (explicitDispatchOwnerAgentId) {
    return explicitDispatchOwnerAgentId;
  }

  const sourceGatewayAgentId = buildGatewayReplyTarget(source)?.agentId || null;
  const webuiGatewayAgentId = buildGatewayReplyTarget("webui")?.agentId || null;
  const replyToAgentId = typeof effectiveReplyTo?.agentId === "string" && effectiveReplyTo.agentId.trim()
    ? effectiveReplyTo.agentId.trim()
    : null;
  return sourceGatewayAgentId
    || webuiGatewayAgentId
    || replyToAgentId
    || null;
}

function buildIngressTaskMessage(message) {
  return String(message || "").trim();
}

// 外部业务身份:能给出稳定跨 run 标识的入口只有 QQ 会话(群/私聊地址恒定)。
// 这里只解身份、不存状态——跨 run 的历史归 thread 树账(threads/<threadId>/),
// 本函数的产物是下面 resolveIngressThreadSeed 的种子。
function buildConversationId(replyTo) {
  if (replyTo?.channel === "qqbot" && replyTo.target) {
    return `qq:${replyTo.target}`;
  }
  return null;
}

// 谱系 thread 种子(批①,备忘录142 §三):QQ 会话(conversationId)/schedule/automation
// 有稳定业务身份 → threadId 确定性派生(同线同 id,续接归队);webui/a2a/test-inject
// 现状无 thread 身份 → null → mintThreadId 随机新线。
function resolveIngressThreadSeed({ conversationId, scheduleContext, automationContext }) {
  if (conversationId) {
    return `conversation:${conversationId}`;
  }
  const scheduleId = normalizeString(scheduleContext?.id);
  if (scheduleId) {
    return `schedule:${scheduleId}`;
  }
  const automationId = normalizeString(automationContext?.automationId);
  if (automationId) {
    return `automation:${automationId}`;
  }
  return null;
}

function validateTaskRuntimeTarget(agentId) {
  const targetAgent = typeof agentId === "string" && agentId.trim()
    ? agentId.trim()
    : null;
  if (!targetAgent) {
    return {
      ok: false,
      error: "missing_target",
      targetAgent: null,
    };
  }
  const identity = getAgentIdentitySnapshot(targetAgent);
  if (listRuntimeAgentIds().length === 0 && targetAgent !== "operator") {
    return {
      ok: true,
      targetAgent,
      plane: identity.plane || null,
    };
  }
  if (!canAutoWakeForTaskRuntime(identity)) {
    return {
      ok: false,
      error: "target_not_task_runtime",
      targetAgent,
      plane: identity.plane || null,
    };
  }
  return {
    ok: true,
    targetAgent,
    plane: identity.plane || null,
  };
}

// Layer 3 notifyIngressReceipt removed — Layer 1 (qqbot gateway DISPATCH receipt) already covers this.

function resolveDispatchChainOriginSessionKey(fromAgent, effectiveReplyTo) {
  const replySessionKey = typeof effectiveReplyTo?.sessionKey === "string" && effectiveReplyTo.sessionKey.trim()
    ? effectiveReplyTo.sessionKey.trim()
    : null;
  if (effectiveReplyTo?.agentId === fromAgent && replySessionKey) {
    return replySessionKey;
  }
  return buildAgentMainSessionKey(fromAgent);
}

async function recordIngressDispatchChain({ fromAgent, effectiveReplyTo, firstHopAgentId, ts, logger }) {
  const chainOrigin = {
    originAgentId: fromAgent,
    originSessionKey: resolveDispatchChainOriginSessionKey(fromAgent, effectiveReplyTo),
    ts,
  };
  if (firstHopAgentId) {
    await rememberDispatchChainOrigin(firstHopAgentId, chainOrigin, { logger });
  } else {
    await rememberDispatchChainOrigins(listDispatchTargetIds(), chainOrigin, { logger });
  }
}

export async function dispatchCreateExecutionContractEntry({
  message,
  source,
  effectiveReplyTo,
  dispatchOwnerAgentId = null,
  targetAgent = null,
  deliveryTargets = null,
  scheduleContext = null,
  automationContext = null,
  operatorContext,
  upstreamReplyTo,
  returnContext,
  serviceSession,
  routeMetadataDiagnostics = null,
  systemActionDeliveryTicket,
  // 谱系(批①):undefined=触发点(本工厂就地铸新 thread/run);显式传入(含 null)=
  // 派生点(create_task)的继承结果,原样归一落约 —— 源约无谱系时为 null,不补铸。
  lineage,
  phases,
  api,
  logger,
}) {
  if (!effectiveReplyTo?.agentId) {
    throw new TypeError("dispatchCreateExecutionContractEntry requires effectiveReplyTo.agentId");
  }
  assertLiveQQReplyTarget(effectiveReplyTo);

  const fromAgent = resolveIngressDispatchOwnerAgent(source, effectiveReplyTo, dispatchOwnerAgentId);
  if (!fromAgent) {
    throw new TypeError("dispatchCreateExecutionContractEntry requires a dispatch owner agent");
  }
  const ts = Date.now();
  const contractId = mintContractId(ts);
  const explicitTargetAgentId = typeof targetAgent === "string" && targetAgent.trim()
    ? targetAgent.trim()
    : null;
  if (explicitTargetAgentId) {
    const authorization = await resolveRouteAfterAgentEndTarget(fromAgent, {
      targetAgent: explicitTargetAgentId,
    });
    if (!authorization.routable) {
      logger?.warn?.(
        `[ingress] blocked explicit target without graph edge: ${fromAgent} -> ${explicitTargetAgentId}`,
      );
      return {
        ok: false,
        error: authorization.action || "unauthorized_explicit_target",
        targetAgent: explicitTargetAgentId,
      };
    }
  }
  const firstHopAgentId = explicitTargetAgentId || await dispatchResolveFirstHop(source, {
    dispatchOwnerAgentId: fromAgent,
  });
  if (firstHopAgentId) {
    const targetValidation = validateTaskRuntimeTarget(firstHopAgentId);
    if (!targetValidation.ok) {
      logger?.warn?.(
        `[ingress] blocked execution contract target outside task runtime: ${firstHopAgentId}`,
      );
      return {
        ok: false,
        error: targetValidation.error,
        targetAgent: firstHopAgentId,
      };
    }
  }
  const taskMessage = buildIngressTaskMessage(message);
  const stagePlan = buildTaskStagePlanFromTask({
    contractId,
    task: taskMessage,
    phases,
  });
  const stageRuntime = stagePlan ? buildInitialTaskStageRuntime({ stagePlan }) : null;
  const displayPhases = stagePlan ? deriveDisplayPhases(stagePlan) : null;
  const displayTotal = stagePlan ? deriveDisplayTotal(stagePlan) : null;
  const conversationId = buildConversationId(effectiveReplyTo);
  // 固定管线每跳期望重导出挂点(spec 决议 20):图 schema 尚无期望定义 → null → 跳过。
  const hopExpectations = buildHopExpectations();
  // 批① 谱系铸造(备忘录142 §五)+ 批② 工厂兜底:lineage 缺席/不全 → 铸孤儿线,
  // 每约必有家(树店全覆盖;兜底发生在工厂,非继承点——与批①"继承不造假"不冲突)。
  const explicitLineage = lineage === undefined ? null : normalizeLineage(lineage);
  const runMinted = lineage === undefined || !explicitLineage?.runId;
  const contractLineage = lineage === undefined
    ? buildLineage({
        threadId: mintThreadId(resolveIngressThreadSeed({ conversationId, scheduleContext, automationContext })),
        runId: mintRunId(ts),
      })
    : ensureLineage(explicitLineage, { now: ts });

  const contract = annotateExecutionContract({
    id: contractId,
    task: taskMessage,
    assignee: firstHopAgentId || null,
    dispatchDepth: 0, // FIX(A2-fanout-depth): no hop counter at contract birth -> initialize the runtime hop counter
    originChain: [], // FIX(A2-fanout-depth): no cross-session cycle trail -> initialize the origin chain
    lineage: contractLineage,
    // 账物分离 batch2:dispatchOwnerAgentId 不再写进正本。owner 只是 ingress 内部路由
    // 入参(`fromAgent`),用于本工厂内解首跳(dispatchResolveFirstHop)+ 校验图边授权;
    // 正本里全库零读者(同名值全是写入点/入参,无一从 contract 读回),留着只是每轮
    // dispatch/claim/agent_end 全量搬运的死重量。谁派的工由谱系/replyTo 承载。
    replyTo: effectiveReplyTo,
    ...(upstreamReplyTo ? { upstreamReplyTo } : {}),
    ...(returnContext ? { returnContext } : {}),
    ...(serviceSession ? { serviceSession } : {}),
    ...(stagePlan ? { stagePlan } : {}),
    ...(stageRuntime ? { stageRuntime } : {}),
    ...(displayPhases ? { phases: displayPhases } : {}),
    ...(displayTotal != null ? { total: displayTotal } : {}),
    ...(hopExpectations ? { expectations: hopExpectations } : {}),
    runtimeContext: buildRuntimeContext({ now: ts }),
    output: join(CONTROL_PLANE_PATHS.outputDir, `${contractId}.md`),
    status: CONTRACT_STATUS.PENDING,
    retryCount: 0,
    createdAt: ts,
    deliveryTargets: normalizeDeliveryTargets(deliveryTargets || []),
    scheduleContext: scheduleContext && typeof scheduleContext === "object"
      ? scheduleContext
      : null,
    automationContext: automationContext && typeof automationContext === "object"
      ? automationContext
      : null,
    ...(conversationId ? { conversationId } : {}),
  }, {
    source,
  });
  attachOperatorContext(contract, operatorContext);
  attachRouteMetadataDiagnostics(contract, routeMetadataDiagnostics);
  attachSystemActionDeliveryTicket(contract, systemActionDeliveryTicket);

  await persistContractById(contract, logger, {
    logMessage: `[ingress] created ${contractId} (from=${fromAgent})`,
  });
  // 事件接线(批② §八):铸造点落 run_triggered,工厂 persist 后落 contract_created。
  // fire-and-forget — 记账失败绝不拦执行面。
  void wireContractCreated({
    contract,
    trigger: runMinted ? { origin: source || "ingress" } : null,
    logger,
  });

  await recordIngressDispatchChain({ fromAgent, effectiveReplyTo, firstHopAgentId, ts, logger });

  // Route via graph: resolve out-edge from source agent
  if (firstHopAgentId) {
    // Dispatch via graph policy (respects FIFO queue if target is busy).
    // No planner-side draft side-store — dispatch-graph-policy handles dispatch directly.
    const dispatchResult = await dispatchRouteExecutionContract(contractId, fromAgent, firstHopAgentId, api, logger);

    if (dispatchResult?.failed) {
      logger.error(`[ingress] dispatch failed for ${contractId} → ${firstHopAgentId}`);
      return { ok: false, contractId, error: "dispatch_failed", targetAgent: firstHopAgentId };
    }

    return {
      ok: true,
      contractId,
      source,
      targetAgent: firstHopAgentId,
      queued: dispatchResult?.queued === true,
    };
  }

  // No out-edge from controller → error
  logger.error(`[ingress] ${fromAgent} has no graph out-edges, cannot route contract ${contractId}`);
  return { ok: false, error: "no graph out-edge from source agent" };
}
