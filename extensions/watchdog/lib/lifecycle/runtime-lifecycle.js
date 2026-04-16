import {
  persistState,
} from "../state.js";
import { broadcast, buildProgressPayload } from "../transport/sse.js";
import {
  hasDispatchTarget,
  isDispatchTargetBusy,
  releaseDispatchTargetContract,
} from "../routing/dispatch-runtime-state.js";
import {
  deleteTrackingSession,
} from "../store/tracker-store.js";
import { refreshTrackingProjection } from "../stage-projection.js";
import { recordTaskHistory } from "../store/task-history-store.js";
import { onAgentDone as dispatchGraphPolicyOnAgentDone } from "../routing/dispatch-graph-policy.js";
import { syncTrackingRuntimeStageProgress } from "../runtime-stage-progress.js";
import { AGENT_ROLE, getAgentRole } from "../agent/agent-identity.js";
import { qqTypingStop } from "../qq.js";

export const SESSION_FINALIZE_MODE = Object.freeze({
  TERMINAL: "terminal",
  RETRY_SUSPEND: "retry_suspend",
  SYNTHETIC_COMPLETION: "synthetic_completion",
});

export async function finalizeAgentSession({
  agentId,
  sessionKey,
  trackingState,
  api,
  logger,
  mode = SESSION_FINALIZE_MODE.TERMINAL,
}) {
  let trackPayload = null;
  let workerReleased = false;
  let trackerRemoved = false;
  const retainAgentReservation = (
    mode === SESSION_FINALIZE_MODE.RETRY_SUSPEND
    || mode === SESSION_FINALIZE_MODE.SYNTHETIC_COMPLETION
  );
  const emitTerminalTracking = mode !== SESSION_FINALIZE_MODE.RETRY_SUSPEND;

  // Dispatch runtime release (no dispatch — dispatch-graph-policy is sole dispatch authority)
  if (trackingState && getAgentRole(agentId) === AGENT_ROLE.EXECUTOR && trackingState.contract?.id && emitTerminalTracking) {
    qqTypingStop(trackingState.contract.id);
  }
  if (!retainAgentReservation && trackingState && hasDispatchTarget(agentId)) {
    if (isDispatchTargetBusy(agentId)) {
      await releaseDispatchTargetContract({ agentId, logger });
      workerReleased = true;
    }
  }

  // Dispatch graph policy: unified queue drain for all agents (sole dispatch authority)
  if (mode !== SESSION_FINALIZE_MODE.SYNTHETIC_COMPLETION) {
    try {
      await dispatchGraphPolicyOnAgentDone(agentId, api, logger, {
        retainBusy: retainAgentReservation,
      });
    } catch (e) {
      logger?.warn?.(`[lifecycle] dispatch-graph-policy cleanup failed for ${agentId}: ${e?.message}`);
    }
  }

  if (trackingState) {
    await syncTrackingRuntimeStageProgress(trackingState, {
      currentSessionBoundary: true,
    });
    await refreshTrackingProjection(trackingState);
    trackPayload = buildProgressPayload(trackingState);
    if (!emitTerminalTracking) {
      broadcast("track_progress", trackPayload);
    } else {
      broadcast("track_end", trackPayload);
      recordTaskHistory(trackPayload);

      // Immediate cleanup — session 设计用确定性 sessionKey，不需要延迟保活
      deleteTrackingSession(sessionKey);
      trackerRemoved = true;
    }

    await persistState(logger);
  }

  return {
    trackPayload,
    workerReleased,
    trackerRemoved,
    mode,
  };
}
