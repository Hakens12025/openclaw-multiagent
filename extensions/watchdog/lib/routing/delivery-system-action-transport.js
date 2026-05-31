import { join } from "node:path";
import {
  RUNTIME_WAKE_SEMANTICS,
  runtimeWakeAgentDetailed,
} from "../transport/runtime-wake-transport.js";
import { agentWorkspace } from "../state.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  getTrackingState,
  waitForTrackingContractClaim,
} from "../store/tracker-store.js";
import {
  buildQueuedWakeDiagnostic,
  getWakeError,
  normalizeWakeDiagnostic,
} from "../lifecycle/runtime-diagnostics.js";
import {
  isRunningTrackingStatus,
  isTerminalContractStatus,
} from "../core/runtime-status.js";
import { dispatchSendDirectRequest } from "./dispatch-transport.js";

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

async function confirmTargetSessionWake(deliveryTargetContext, {
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

    try {
      await requestSystemActionDeliveryHeartbeat(deliveryTargetContext);
      logger?.info?.(
        `[system_action_delivery] retrying exact-session wake for ${targetAgent} `
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
    logger?.info?.(
      `[system_action_delivery] requested fallback wake for ${targetAgent} `
      + `after exact-session confirm miss `
      + `(${lane}, session=${targetSessionKey || "unknown"}, mode=${wake?.mode || "unknown"})`,
    );
    return wake?.ok === true;
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
}) {
  const wakeOptions = normalizeDeliveryWakeOptions({
    wake: wakeConfig,
    targetSessionKey: wakeConfig?.targetSessionKey ?? null,
  });
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
    deliveryTicketId: wakeOptions.deliveryTicketId || contract?.systemActionDeliveryTicket?.id || null,
    sourceAgentId: wakeOptions.sourceAgentId || null,
    actionType: wakeOptions.actionType || null,
    sourceContractId: wakeOptions.sourceContractId || null,
    missingWakeReason: wakeOptions.missingReason,
    missingWakeError: wakeOptions.missingError,
  });
  const targetInbox = join(agentWorkspace(targetAgent), "inbox");
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
      deliveryTicketId: wakeOptions.deliveryTicketId || contract?.systemActionDeliveryTicket?.id || null,
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
