// lib/dispatch-execution-contract-entry.js — execution-contract ingress handling

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  OC, CONTRACTS_DIR, QQ_OPENID,
} from "../state.js";
import {
  rememberDispatchChainOrigin,
  rememberDispatchChainOrigins,
} from "../store/contract-flow-store.js";
import { qqNotify } from "../qq.js";
import { buildConversationId, loadConversation, buildPriorContext } from "../conversations.js";
import { getContractPath, persistContractSnapshot } from "../contracts.js";
import { normalizeDeliveryTargets } from "../routing/delivery-targets.js";
import { annotateExecutionContract } from "../protocol-primitives.js";
import { attachOperatorContext } from "../operator/operator-context.js";
import { attachRouteMetadataDiagnostics } from "../route-metadata.js";
import { attachSystemActionDeliveryTicket } from "../routing/delivery-system-action-ticket.js";
import { listResolvedGraphLoops } from "../loop/graph-loop-registry.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import {
  buildInitialTaskStageRuntime,
  deriveCompatibilityPhases,
  deriveCompatibilityTotal,
} from "../task-stage-plan.js";
import { buildTaskStagePlanFromTask } from "../task-stage-planner.js";
import {
  buildGatewayReplyTarget,
  isQQIngressAgent,
} from "../agent/agent-identity.js";
import { dispatchResolveFirstHop, dispatchRouteExecutionContract } from "../routing/dispatch-graph-policy.js";
import {
  buildDispatchRuntimeSnapshot,
  listDispatchTargetIds,
} from "../routing/dispatch-runtime-state.js";
import { buildAgentMainSessionKey } from "../session-keys.js";

export function dispatchResolveIngressReplyTarget(source, replyTo) {
  if (replyTo?.agentId) return replyTo;

  const defaultReplyTo = buildGatewayReplyTarget(source);
  const fromAgent = defaultReplyTo?.agentId;
  return {
    ...defaultReplyTo,
    ...(isQQIngressAgent(fromAgent) ? { channel: "qqbot", target: QQ_OPENID } : {}),
  };
}

function buildExecutionContractId(now = Date.now()) {
  return `TC-${now}-${randomBytes(3).toString("hex")}`;
}

function resolveIngressDispatchOwnerAgent(source, effectiveReplyTo, dispatchOwnerAgentId = null) {
  const explicitDispatchOwnerAgentId = typeof dispatchOwnerAgentId === "string" && dispatchOwnerAgentId.trim()
    ? dispatchOwnerAgentId.trim()
    : null;
  if (explicitDispatchOwnerAgentId) {
    return explicitDispatchOwnerAgentId;
  }
  return buildGatewayReplyTarget(source)?.agentId
    || effectiveReplyTo?.agentId
    || null;
}

async function loadPriorContextForReply(replyTo) {
  const conversationId = buildConversationId(replyTo);
  if (!conversationId) {
    return { conversationId: null, priorContext: null };
  }

  try {
    const convState = await loadConversation(conversationId);
    return {
      conversationId,
      priorContext: buildPriorContext(convState),
    };
  } catch {
    return { conversationId, priorContext: null };
  }
}

async function notifyIngressReceipt({ fromAgent, message, simple }) {
  if (!isQQIngressAgent(fromAgent)) return;

  const runtimeSnapshot = buildDispatchRuntimeSnapshot();
  const idleWorkers = Object.values(runtimeSnapshot.targets || {})
    .filter((state) => !state?.busy && !state?.dispatching)
    .length;
  if (simple) {
    await qqNotify(QQ_OPENID, `📋 任务已收到\n${message.slice(0, 60)}\n⚡ 快速通道，${idleWorkers > 0 ? "立即处理" : "排队中"}`);
    return;
  }

  await qqNotify(QQ_OPENID, `📋 任务已收到\n${message.slice(0, 60)}\n🔍 需要规划，正在分配 Planner...`);
}

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

async function attachPlannerContext(contract) {
  const activeLoopCandidates = (await listResolvedGraphLoops())
    .filter((loop) => loop?.active === true)
    .map((loop) => ({
      loopId: loop.id,
      kind: loop.kind || null,
      entryAgentId: loop.entryAgentId || null,
      nodes: Array.isArray(loop.nodes) ? loop.nodes : [],
      continueSignal: loop.continueSignal || null,
      concludeSignal: loop.concludeSignal || null,
    }));

  return {
    ...contract,
    planningContext: {
      route: contract?.protocol?.route || "long",
      activeLoopCount: activeLoopCandidates.length,
      activeLoopCandidates,
    },
  };
}

export async function dispatchCreateExecutionContractEntry({
  message,
  source,
  effectiveReplyTo,
  dispatchOwnerAgentId = null,
  deliveryTargets = null,
  scheduleContext = null,
  automationContext = null,
  operatorContext,
  upstreamReplyTo,
  returnContext,
  serviceSession,
  routeMetadataDiagnostics = null,
  systemActionDeliveryTicket,
  simple,
  phases,
  api,
  logger,
}) {
  if (!effectiveReplyTo?.agentId) {
    throw new TypeError("dispatchCreateExecutionContractEntry requires effectiveReplyTo.agentId");
  }

  const fromAgent = resolveIngressDispatchOwnerAgent(source, effectiveReplyTo, dispatchOwnerAgentId);
  if (!fromAgent) {
    throw new TypeError("dispatchCreateExecutionContractEntry requires a dispatch owner agent");
  }
  const ts = Date.now();
  const contractId = buildExecutionContractId(ts);
  const firstHopAgentId = await dispatchResolveFirstHop(source, {
    dispatchOwnerAgentId: fromAgent,
  });
  const stagePlan = buildTaskStagePlanFromTask({
    contractId,
    task: message,
    phases,
  });
  const stageRuntime = buildInitialTaskStageRuntime({ stagePlan });
  const compatibilityPhases = stagePlan ? deriveCompatibilityPhases(stagePlan) : null;
  const { conversationId, priorContext } = await loadPriorContextForReply(effectiveReplyTo);

  let contract = annotateExecutionContract({
    id: contractId,
    task: message,
    assignee: firstHopAgentId || null,
    dispatchOwnerAgentId: fromAgent,
    replyTo: effectiveReplyTo,
    ...(upstreamReplyTo ? { upstreamReplyTo } : {}),
    ...(returnContext ? { returnContext } : {}),
    ...(serviceSession ? { serviceSession } : {}),
    stagePlan,
    stageRuntime,
    phases: compatibilityPhases,
    total: stagePlan ? deriveCompatibilityTotal(stagePlan) : null,
    output: join(OC, "workspaces", "controller", "output", `${contractId}.md`),
    status: CONTRACT_STATUS.PENDING,
    fastTrack: simple,
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
    ...(priorContext ? { priorContext } : {}),
  }, {
    source,
    route: simple ? "short" : "long",
  });
  contract = await attachPlannerContext(contract);
  attachOperatorContext(contract, operatorContext);
  attachRouteMetadataDiagnostics(contract, routeMetadataDiagnostics);
  attachSystemActionDeliveryTicket(contract, systemActionDeliveryTicket);

  await mkdir(CONTRACTS_DIR, { recursive: true });
  const contractPath = getContractPath(contractId);
  await persistContractSnapshot(contractPath, contract, logger, {
    logMessage: `[ingress] created ${contractId} (from=${fromAgent}, fastTrack=${simple})`,
  });

  await notifyIngressReceipt({ fromAgent, message, simple });
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
