import { TRACKING_STATUS } from "./core/runtime-status.js";
import {
  consumeLease,
} from "./lease-manager.js";

const TYPE = "followUpLease";

export function resumeRuntimeFollowUpLease(trackingState, now = Date.now()) {
  return consumeLease(trackingState, TYPE, {
    now,
    applyTrackingSideEffects(ts, consumed) {
      ts.status = TRACKING_STATUS.RUNNING;
      ts.lastLabel = `恢复 ${consumed.workflow || "system_action delivery"}`;
      ts.startMs = now;
      ts.toolCalls = [];
      ts.toolCallTotal = 0;
      ts.stageProjection = null;
      ts.cursor = null;
      ts.pct = null;
      ts.estimatedPhase = "";
    },
  });
}
