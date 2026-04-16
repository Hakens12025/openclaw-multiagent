// hooks/agent-end.js — thin hook shell; stage pipeline lives in lib/agent-end-pipeline.js

import {
  runAgentEndPipeline,
} from "../lib/lifecycle/agent-end-pipeline.js";
import {
  clearProtocolCommitReconcile,
  flushProtocolCommitDeferredRelease,
} from "../lib/protocol-commit-reconcile.js";
import { getTrackingState } from "../lib/store/tracker-store.js";
import {
  isHeartbeatSessionIgnored,
  unignoreHeartbeatSession,
} from "../lib/store/heartbeat-session-store.js";

export function register(api, logger, { enqueueFn, wakePlanner }) {
  api.on("agent_end", async (event, ctx) => {
    const sessionKey = ctx.sessionKey;
    const trackingState = getTrackingState(sessionKey);

    logger.info(`[watchdog] >> agent_end: ${sessionKey} (success: ${event.success})`);

    if (isHeartbeatSessionIgnored(sessionKey) && !trackingState) {
      unignoreHeartbeatSession(sessionKey);
      logger.info(`[watchdog] skipping agent_end for ignored heartbeat session: ${sessionKey}`);
      return;
    }
    unignoreHeartbeatSession(sessionKey);
    clearProtocolCommitReconcile(sessionKey);

    await runAgentEndPipeline({
      event,
      ctx,
      api,
      logger,
      enqueueFn,
      wakePlanner,
      trackingState,
    });

    if (!trackingState) {
      await flushProtocolCommitDeferredRelease(sessionKey);
    }
  });
}
