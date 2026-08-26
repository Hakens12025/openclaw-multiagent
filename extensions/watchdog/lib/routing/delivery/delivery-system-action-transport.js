import { join } from "node:path";
import {
  RUNTIME_WAKE_SEMANTICS,
  runtimeWakeAgentDetailed,
} from "../../transport/runtime-wake-transport.js";
import { agentWorkspace } from "../../state.js";
import { broadcast } from "../../transport/sse.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import {
  getTrackingState,
  waitForTrackingContractClaim,
} from "../../store/tracker-store.js";
import {
  buildQueuedWakeDiagnostic,
  getWakeError,
  normalizeWakeDiagnostic,
} from "../runtime-diagnostics.js";
import {
  isRunningTrackingStatus,
  isTerminalContractStatus,
} from "../../core/runtime-status.js";
import { SESSION_PHASE, getSessionPhase } from "../../session/session-phase-store.js";
import {
  DELIVERY_LEGS,
  buildDeliverIdempotencyKey,
  hasDeliveryKey,
  recordDeliveryKey,
} from "../../store/delivery-idempotency-store.js";
import { dispatchSendDirectRequest } from "../dispatch/dispatch-transport.js";

function createDeliveryTargetContext({
  lane,
  targetAgent,
  targetSessionKey = null,
  contractId = null,
  api = null,
  logger,
  wakeReason = null,
  wakeHandler = null,
  wakeSemantic = null,
  deliveryTicketId = null,
  sourceAgentId = null,
  actionType = null,
  sourceContractId = null,
  missingWakeReason = "wake_callback_missing",
  missingWakeError = "wake callback missing",
} = {}) {
  return {
    lane,
    targetAgent,
    targetSessionKey,
    contractId,
    api,
    logger,
    wakeReason,
    wakeHandler,
    wakeSemantic,
    deliveryTicketId,
    sourceAgentId,
    actionType,
    sourceContractId,
    missingWakeReason,
    missingWakeError,
  };
}

function normalizeDeliveryWakeOptions({
  wake = null,
  targetSessionKey = null,
} = {}) {
  return {
    reason: wake?.reason ?? null,
    handler: wake?.handler ?? null,
    targetSessionKey: wake?.targetSessionKey ?? targetSessionKey ?? null,
    failureAlert: wake?.failureAlert ?? null,
    wakeSemantic: wake?.wakeSemantic ?? null,
    deliveryTicketId: wake?.deliveryTicketId ?? null,
    sourceAgentId: wake?.sourceAgentId ?? null,
    actionType: wake?.actionType ?? null,
    sourceContractId: wake?.sourceContractId ?? null,
    missingReason: wake?.missingReason ?? "wake_callback_missing",
    missingError: wake?.missingError ?? "wake callback missing",
  };
}

function buildMissingWakeDiagnostic(deliveryTargetContext, {
  promoted,
  missingWakeReason = deliveryTargetContext.missingWakeReason,
  missingWakeError = deliveryTargetContext.missingWakeError,
} = {}) {
  return normalizeWakeDiagnostic({
    ok: false,
    requested: false,
    reason: missingWakeReason,
    error: missingWakeError,
  }, {
    lane: deliveryTargetContext.lane,
    targetAgent: deliveryTargetContext.targetAgent,
    promoted,
  });
}

function getLiveTargetSession(targetSessionKey) {
  if (!targetSessionKey) {
    return null;
  }
  const trackingState = getTrackingState(targetSessionKey);
  if (!trackingState || !isRunningTrackingStatus(trackingState.status)) {
    return null;
  }
  return trackingState;
}

async function requestSystemActionDeliveryHeartbeat(deliveryTargetContext, { wakeReason = null } = {}) {
  const {
    api,
    targetAgent,
    targetSessionKey,
    logger,
    deliveryTicketId,
    sourceAgentId,
    actionType,
    sourceContractId,
  } = deliveryTargetContext;
  if (!targetSessionKey || !targetAgent) {
    return { requested: false, mode: null };
  }
  const reason = wakeReason || deliveryTargetContext.wakeReason || null;
  const result = await runtimeWakeAgentDetailed(targetAgent, reason, api, logger, {
    sessionKey: targetSessionKey,
    wakeSemantic: RUNTIME_WAKE_SEMANTICS.SYSTEM_ACTION_DELIVERY_RESUME,
    deliveryTicketId,
    sourceAgentId,
    actionType,
    sourceContractId,
  });
  return { requested: result.ok, mode: result.mode || null };
}

function hasTargetSessionClaimedContract(targetSessionKey, contractId) {
  const trackingState = getLiveTargetSession(targetSessionKey);
  if (!trackingState) {
    return false;
  }
  if (!contractId) {
    return true;
  }
  return trackingState.contract?.id === contractId;
}

function getTargetSessionTerminalReason(targetSessionKey) {
  const trackingState = getTrackingState(targetSessionKey);
  if (
    trackingState
    && !trackingState.followUpLease?.active
    && (
      isTerminalContractStatus(trackingState.status)
      || isTerminalContractStatus(trackingState.contract?.status)
    )
  ) {
    return "tracker_terminal";
  }
  return null;
}

// export：确认-重试环的行为锁（tests/delivery-wake-retry-live-session.test.js）。
export async function confirmTargetSessionWake(deliveryTargetContext, {
  maxAttempts = 3,
  retryDelayMs = 1500,
} = {}) {
  const {
    lane,
    targetAgent,
    targetSessionKey,
    contractId,
    api,
    logger,
  } = deliveryTargetContext;
  if (!targetSessionKey || !api) {
    return null;
  }

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const terminalReasonBeforeWait = getTargetSessionTerminalReason(targetSessionKey);
    if (terminalReasonBeforeWait) {
      logger?.info?.(
        `[system_action_delivery] skipping exact-session confirm retry for ${targetSessionKey} `
        + `(${lane}, reason=${terminalReasonBeforeWait})`,
      );
      return {
        confirmed: false,
        attempts: attempt,
        terminalReason: terminalReasonBeforeWait,
      };
    }

    if (hasTargetSessionClaimedContract(targetSessionKey, contractId)) {
      return { confirmed: true, attempts: attempt };
    }

    const claimResult = await waitForTrackingContractClaim(
      targetSessionKey,
      contractId,
      retryDelayMs,
    );
    if (claimResult.claimed) {
      return {
        confirmed: true,
        attempts: attempt,
        source: claimResult.source || "waiter",
      };
    }

    if (attempt === maxAttempts) {
      break;
    }

    const terminalReasonAfterWait = getTargetSessionTerminalReason(targetSessionKey);
    if (terminalReasonAfterWait) {
      logger?.info?.(
        `[system_action_delivery] stopping exact-session confirm retry for ${targetSessionKey} `
        + `(${lane}, reason=${terminalReasonAfterWait})`,
      );
      return {
        confirmed: false,
        attempts: attempt + 1,
        terminalReason: terminalReasonAfterWait,
      };
    }

    // 目标会话非 idle（running=正在跑一个尚未认领的回合 / closing=收尾在飞）时
    // 不补发唤醒——补发只会在回合边界多落一次 before_agent_start，甚至撞进收尾
    // 窗口。相位真值消费 session-phase-store（与原语级相位门同一真值源）。只继续
    // 等认领：回合结束后若仍未认领，下一轮循环见相位已 idle 才真正补发。
    if (getSessionPhase(targetSessionKey) !== SESSION_PHASE.IDLE) {
      logger?.info?.(
        `[system_action_delivery] target session live for ${targetSessionKey} `
        + `(${lane}, attempt ${attempt + 1}/${maxAttempts}) — waiting for claim without re-waking`,
      );
      continue;
    }

    try {
      const heartbeat = await requestSystemActionDeliveryHeartbeat(deliveryTargetContext);
      logger?.info?.(
        heartbeat.mode === "deduplicated"
          ? `[system_action_delivery] exact-session wake already queued for ${targetAgent} `
            + `(${lane}, attempt ${attempt + 1}/${maxAttempts}) — deduplicated, waiting for claim`
          : `[system_action_delivery] retrying exact-session wake for ${targetAgent} `
            + `(${lane}, attempt ${attempt + 1}/${maxAttempts})`,
      );
    } catch (error) {
      logger?.warn?.(
        `[system_action_delivery] system_action delivery resume retry failed for ${targetSessionKey}: ${error.message}`,
      );
    }
  }

  return { confirmed: false, attempts: maxAttempts };
}

async function requestFallbackAgentWake(deliveryTargetContext) {
  const {
    targetAgent,
    api,
    logger,
    lane,
    targetSessionKey,
    contractId,
    deliveryTicketId,
    sourceAgentId,
    actionType,
    sourceContractId,
  } = deliveryTargetContext;
  if (!targetAgent || !api) {
    return false;
  }

  try {
    const wake = await runtimeWakeAgentDetailed(
      targetAgent,
      null,
      api,
      logger,
      {
        sessionKey: targetSessionKey,
        wakeSemantic: RUNTIME_WAKE_SEMANTICS.SYSTEM_ACTION_DELIVERY_RESUME,
        deliveryTicketId,
        sourceAgentId,
        actionType,
        sourceContractId,
      },
    );
    const deduplicated = wake?.mode === "deduplicated";
    logger?.info?.(
      `[system_action_delivery] ${deduplicated ? "fallback wake skipped (already queued, deduplicated)" : "requested fallback wake"} `
      + `for ${targetAgent} after exact-session confirm miss `
      + `(${lane}, session=${targetSessionKey || "unknown"}, mode=${wake?.mode || "unknown"})`,
    );
    return wake?.ok === true && !deduplicated;
  } catch (error) {
    logger?.warn?.(
      `[system_action_delivery] fallback wake failed for ${targetAgent}: ${error.message}`,
    );
    return false;
  }
}

async function requestExactSessionWake(deliveryTargetContext) {
  const {
    lane,
    targetAgent,
    targetSessionKey,
    api,
    logger,
  } = deliveryTargetContext;
  if (!targetSessionKey || !api) {
    return null;
  }

  try {
    const heartbeatRequest = await requestSystemActionDeliveryHeartbeat(deliveryTargetContext);
    if (!heartbeatRequest.requested) {
      return null;
    }

    logger?.info?.(
      `[system_action_delivery] requested exact-session heartbeat for ${targetAgent} `
      + `(${lane}, session=${targetSessionKey}, mode=${heartbeatRequest.mode || "unknown"})`,
    );

    return normalizeWakeDiagnostic({
      ok: true,
      requested: true,
      mode: "heartbeat",
      fallbackUsed: false,
      error: null,
    }, {
      lane,
      targetAgent,
      promoted: true,
    });
  } catch (error) {
    logger?.warn?.(
      `[system_action_delivery] exact-session heartbeat failed for ${targetSessionKey}: ${error.message}`,
    );
    return null;
  }
}

async function resolveDeliveryWake(deliveryTargetContext) {
  const {
    lane,
    targetAgent,
    targetSessionKey,
    api,
    logger,
    wakeReason,
    wakeHandler,
  } = deliveryTargetContext;
  if (typeof wakeHandler === "function") {
    return normalizeWakeDiagnostic(await wakeHandler(targetAgent), {
      lane,
      targetAgent,
      promoted: true,
    });
  }

  if (targetSessionKey && api) {
    const exactSessionWake = await requestExactSessionWake(deliveryTargetContext);
    if (exactSessionWake) {
      return exactSessionWake;
    }
  }

  if (wakeReason && api) {
    return normalizeWakeDiagnostic(
      await runtimeWakeAgentDetailed(targetAgent, wakeReason, api, logger, {
        sessionKey: targetSessionKey,
        wakeSemantic: deliveryTargetContext.wakeSemantic,
        deliveryTicketId: deliveryTargetContext.deliveryTicketId,
        sourceAgentId: deliveryTargetContext.sourceAgentId,
        actionType: deliveryTargetContext.actionType,
        sourceContractId: deliveryTargetContext.sourceContractId,
      }),
      {
        lane,
        targetAgent,
        promoted: true,
      },
    );
  }

  return buildMissingWakeDiagnostic(deliveryTargetContext, { promoted: true });
}

async function finalizeDeliveryWake(deliveryTargetContext, wake) {
  const {
    lane,
    targetAgent,
    targetSessionKey,
    contractId,
    api,
    logger,
  } = deliveryTargetContext;
  if (!wake?.ok || !targetSessionKey) {
    return wake;
  }

  let confirmedWake = await confirmTargetSessionWake(deliveryTargetContext);
  if (confirmedWake && confirmedWake.confirmed === false) {
    logger?.warn?.(
      `[system_action_delivery] target session ${targetSessionKey} did not claim ${contractId} `
      + `after ${confirmedWake.attempts} retry attempts`,
    );
    confirmedWake = {
      ...confirmedWake,
      fallbackAgentWakeRequested: false,
      fallbackSkipped: confirmedWake.terminalReason
        ? "target_session_terminal"
        : (wake?.mode === "hooks" ? "already_hook_wake" : null),
    };
    if (!confirmedWake.terminalReason && wake?.mode !== "hooks") {
      confirmedWake.fallbackAgentWakeRequested = await requestFallbackAgentWake(deliveryTargetContext);
    }
  }

  return confirmedWake
    ? {
        ...wake,
        confirmedSessionBind: confirmedWake.confirmed,
        confirmAttempts: confirmedWake.attempts,
        ...(api && !confirmedWake.confirmed
          ? {
              fallbackAgentWakeRequested: confirmedWake.fallbackAgentWakeRequested,
              fallbackSkipped: confirmedWake.fallbackSkipped || null,
            }
          : {}),
      }
    : wake;
}

export async function deliveryEnqueueSystemActionReturn({
  lane,
  targetAgent,
  contract,
  api = null,
  logger,
  wake: wakeConfig = null,
  queuedLogMessage = null,
  deliveryLeg = DELIVERY_LEGS.RETURN,
}) {
  const wakeOptions = normalizeDeliveryWakeOptions({
    wake: wakeConfig,
    targetSessionKey: wakeConfig?.targetSessionKey ?? null,
  });
  const deliveryTicketId = wakeOptions.deliveryTicketId || contract?.systemActionDeliveryTicket?.id || null;
  const deliveryTargetContext = createDeliveryTargetContext({
    lane,
    targetAgent,
    targetSessionKey: wakeOptions.targetSessionKey,
    contractId: contract?.id || null,
    api,
    logger,
    wakeReason: wakeOptions.reason,
    wakeHandler: wakeOptions.handler,
    wakeSemantic: wakeOptions.wakeSemantic,
    deliveryTicketId,
    sourceAgentId: wakeOptions.sourceAgentId || null,
    actionType: wakeOptions.actionType || null,
    sourceContractId: wakeOptions.sourceContractId || null,
    missingWakeReason: wakeOptions.missingReason,
    missingWakeError: wakeOptions.missingError,
  });
  const targetInbox = join(agentWorkspace(targetAgent), "inbox");

  // 投递票据键(备忘录141 §三,腿别限定):同一票据【同一腿】的重复投递 → no-op(双总线
  // 重复到达无害化)。腿别必须入键——assign 派发腿与回投腿共用同一 SADT 票据且同走
  // 本漏斗,无腿别时派发记键会把回投永久去重(跨腿碰撞)。无票据时键为 null,照常投递。
  const deliverIdempotencyKey = buildDeliverIdempotencyKey(deliveryTicketId, deliveryLeg);
  if (deliverIdempotencyKey && await hasDeliveryKey(deliverIdempotencyKey)) {
    logger?.info?.(`[system_action_delivery] ${lane} → ${targetAgent} deduplicated: ${deliverIdempotencyKey}`);
    return {
      targetInbox,
      enqueueResult: null,
      wake: normalizeWakeDiagnostic({
        ok: true,
        requested: false,
        mode: "deduplicated",
        reason: "duplicate_delivery_ticket",
        error: null,
      }, {
        lane,
        targetAgent,
      }),
    };
  }

  const dispatchResult = await dispatchSendDirectRequest({
    targetAgent,
    inboxDir: targetInbox,
    contract,
    from: lane,
    runtimeAuthority: {
      kind: "system_action_delivery",
      deliveryId: lane,
      targetAgent,
      targetSessionKey: wakeOptions.targetSessionKey || null,
      deliveryTicketId,
    },
    logger,
    broadcastDispatch: false,
    skipWake: true,
  });
  if (dispatchResult?.blocked) {
    return {
      targetInbox,
      enqueueResult: null,
      wake: dispatchResult.wake || normalizeWakeDiagnostic({
        ok: false,
        requested: false,
        reason: "control_plane_activation_blocked",
        error: dispatchResult.blockReason || `ordinary task runtime cannot dispatch to ${targetAgent}`,
      }, {
        lane,
        targetAgent,
      }),
    };
  }
  const enqueueResult = dispatchResult.enqueueResult;

  // 入箱成功(promoted 与 queued 都算已投递)才记键——blocked/异常路径不记,重试照发。
  if (deliverIdempotencyKey && enqueueResult) {
    await recordDeliveryKey(deliverIdempotencyKey, { lane, leg: deliveryLeg, targetAgent });
  }

  if (!enqueueResult.promoted) {
    if (queuedLogMessage) {
      logger?.info?.(queuedLogMessage);
    }
    return {
      targetInbox,
      enqueueResult,
      wake: buildQueuedWakeDiagnostic({ lane, targetAgent }),
    };
  }

  const wake = await resolveDeliveryWake({
    ...deliveryTargetContext,
  });

  if (!wake?.ok) {
    broadcast("alert", {
      type: EVENT_TYPE.RUNTIME_WAKE_FAILED,
      lane,
      targetAgent,
      contractId: contract.id,
      error: getWakeError(wake) || "wake failed",
      ts: Date.now(),
      ...(wakeOptions.failureAlert && typeof wakeOptions.failureAlert === "object" ? wakeOptions.failureAlert : {}),
    });
  }

  const finalWake = await finalizeDeliveryWake(deliveryTargetContext, wake);

  return {
    targetInbox,
    enqueueResult,
    wake: finalWake,
  };
}
