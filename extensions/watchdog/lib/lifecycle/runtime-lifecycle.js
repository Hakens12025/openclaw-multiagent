import {
  persistState,
} from "../state.js";
import { broadcast, buildProgressPayload } from "../transport/sse.js";
import {
  hasDispatchTarget,
  isDispatchTargetBusy,
  releaseDispatchTargetContract,
} from "../routing/dispatch/dispatch-runtime-state.js";
import {
  deleteTrackingSession,
} from "../store/tracker-store.js";
import { clearSession as clearLoopDetectionSession } from "../runtime/execution-hard-stop-registry.js";
import { resolveSessionEpochKey } from "../runtime/session-epoch-key.js";
import { refreshTrackingProjection } from "../stage/stage-projection.js";
import { recordTaskHistory } from "../store/task-history-store.js";
import { onAgentDone as dispatchGraphPolicyOnAgentDone } from "../routing/dispatch/dispatch-graph-policy.js";
import { syncTrackingRuntimeStageProgress } from "../stage/runtime-stage-progress.js";
import { qqTypingStop } from "../transport/channel-notify.js";

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

  // 停 QQ typing：按合约状态判据，不按角色（qqTypingStop 对无 typing 的合约是安全 no-op）。
  if (trackingState && trackingState.contract?.id && emitTerminalTracking) {
    qqTypingStop(trackingState.contract.id);
  }
  if (!retainAgentReservation && trackingState && hasDispatchTarget(agentId)) {
    if (isDispatchTargetBusy(agentId)) {
      await releaseDispatchTargetContract({ agentId, logger });
      workerReleased = true;
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
      clearLoopDetectionSession(resolveSessionEpochKey(trackingState) || sessionKey);
      trackerRemoved = true;
    }

    await persistState(logger);
  }

  // Queue drain must observe the finalized tracker state. If the next queued
  // contract is staged while the ending session still exists, exact staging is
  // blocked by the old bound tracker and the queue enters claim-timeout retry.
  if (mode !== SESSION_FINALIZE_MODE.SYNTHETIC_COMPLETION) {
    try {
      await dispatchGraphPolicyOnAgentDone(agentId, api, logger, {
        retainBusy: retainAgentReservation,
      });
    } catch (e) {
      logger?.warn?.(`[lifecycle] dispatch-graph-policy cleanup failed for ${agentId}: ${e?.message}`);
    }
  }

  return {
    trackPayload,
    workerReleased,
    trackerRemoved,
    mode,
  };
}
