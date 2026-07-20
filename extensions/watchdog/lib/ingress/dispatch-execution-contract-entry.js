// lib/dispatch-execution-contract-entry.js — execution-contract ingress handling

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  CONTRACTS_DIR,
} from "../state.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import {
  rememberDispatchChainOrigin,
  rememberDispatchChainOrigins,
} from "../store/contract-flow-store.js";
import { buildConversationId, loadConversation, buildPriorContext } from "../conversations.js";
import { getContractPath, persistContractSnapshot } from "../contracts.js";
import { normalizeDeliveryTargets } from "../routing/delivery-targets.js";
import { annotateExecutionContract, buildRuntimeContext } from "../protocol-primitives.js";
import { attachOperatorContext } from "../operator/operator-context.js";
import { attachRouteMetadataDiagnostics } from "../route-metadata.js";
import { attachSystemActionDeliveryTicket } from "../routing/delivery-system-action-ticket.js";
import { listResolvedGraphLoops } from "../loop/graph-loop-registry.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import {
  buildInitialTaskStageRuntime,
  deriveDisplayPhases,
  deriveDisplayTotal,
} from "../task-stage-plan.js";
import { buildTaskStagePlanFromTask } from "../task-stage-planner.js";
import {
  canAutoWakeForTaskRuntime,
} from "../agent/agent-activation-policy.js";
import {
  buildGatewayReplyTarget,
  getAgentIdentitySnapshot,
  isGatewayAgent,
  isQQIngressAgent,
  listRuntimeAgentIds,
} from "../agent/agent-identity.js";
import {
  dispatchResolveFirstHop,
  dispatchRouteExecutionContract,
  resolveRouteAfterAgentEndTarget,
} from "../routing/dispatch-graph-policy.js";
import {
  listDispatchTargetIds,
} from "../routing/dispatch-runtime-state.js";
import { buildAgentMainSessionKey } from "../session-keys.js";
import {
  assertLiveQQIngressReplyTarget,
  assertLiveQQReplyTarget,
  isQQIngressSource,
  normalizeQQIngressSource,
} from "../qq-reply-target.js";

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

  const sourceGatewayAgentId = buildGatewayReplyTarget(source)?.agentId || null;
  const controllerGatewayAgentId = buildGatewayReplyTarget("webui")?.agentId || null;
  if (
    sourceGatewayAgentId
    && controllerGatewayAgentId
    && sourceGatewayAgentId !== controllerGatewayAgentId
  ) {
    return controllerGatewayAgentId;
  }

  const replyToAgentId = typeof effectiveReplyTo?.agentId === "string" && effectiveReplyTo.agentId.trim()
    ? effectiveReplyTo.agentId.trim()
    : null;
  if (
    replyToAgentId
    && controllerGatewayAgentId
    && replyToAgentId !== controllerGatewayAgentId
    && isGatewayAgent(replyToAgentId)
  ) {
    return controllerGatewayAgentId;
  }

  if (!sourceGatewayAgentId && controllerGatewayAgentId) {
    return controllerGatewayAgentId;
  }

  return sourceGatewayAgentId
    || replyToAgentId
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

function buildIngressTaskMessage(message) {
  return String(message || "").trim();
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
  const contractId = buildExecutionContractId(ts);
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
  const { conversationId, priorContext } = await loadPriorContextForReply(effectiveReplyTo);

  let contract = annotateExecutionContract({
    id: contractId,
    task: taskMessage,
    assignee: firstHopAgentId || null,
    dispatchDepth: 0, // FIX(A2-fanout-depth): no hop counter at contract birth -> initialize the runtime hop counter
    originChain: [], // FIX(A2-fanout-depth): no cross-session cycle trail -> initialize the origin chain
    dispatchOwnerAgentId: fromAgent,
    replyTo: effectiveReplyTo,
    ...(upstreamReplyTo ? { upstreamReplyTo } : {}),
    ...(returnContext ? { returnContext } : {}),
    ...(serviceSession ? { serviceSession } : {}),
    ...(stagePlan ? { stagePlan } : {}),
    ...(stageRuntime ? { stageRuntime } : {}),
    ...(displayPhases ? { phases: displayPhases } : {}),
    ...(displayTotal != null ? { total: displayTotal } : {}),
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
    ...(priorContext ? { priorContext } : {}),
  }, {
    source,
  });
  contract = await attachPlannerContext(contract);
  attachOperatorContext(contract, operatorContext);
  attachRouteMetadataDiagnostics(contract, routeMetadataDiagnostics);
  attachSystemActionDeliveryTicket(contract, systemActionDeliveryTicket);

  await mkdir(CONTRACTS_DIR, { recursive: true });
  const contractPath = getContractPath(contractId);
  await persistContractSnapshot(contractPath, contract, logger, {
    logMessage: `[ingress] created ${contractId} (from=${fromAgent})`,
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
