// hooks/before-agent-start.js — Contract binding, research routing, auto-exec

import {
  isWorker,
  loadState,
  persistState,
} from "../lib/state.js";
import {
  ignoreHeartbeatSession,
  unignoreHeartbeatSession,
} from "../lib/store/heartbeat-session-store.js";
import { broadcast, buildProgressPayload } from "../lib/transport/sse.js";
import { refreshTrackingProjection } from "../lib/stage-projection.js";
import { routeInbox } from "../runtime-mailbox.js";
import { handleBeforeStartIngress } from "../lib/ingress/before-start-ingress.js";
import { hasActionableHeartbeatWork } from "../lib/heartbeat-gate.js";
import { getContractPath } from "../lib/contracts.js";
import {
  createTrackingState,
  bindPendingWorkerContract,
  bindInboxContractEnvelope,
  bindInboxArtifactContext,
} from "../lib/session-bootstrap.js";
import { runWorkerHardPathAutoExec } from "../lib/hard-path-autoexec.js";
import {
  hasTrackingSession,
  hasConcurrentTrackingSessionForAgent,
  getTerminalTrackingSessionReason,
  markTrackingSessionRunning,
  rememberTrackingState,
} from "../lib/store/tracker-store.js";
import { resumeRuntimeFollowUpLease } from "../lib/runtime-follow-up-lease.js";
import { initTrace } from "../lib/store/execution-trace-store.js";
import { syncTrackingRuntimeStageProgress } from "../lib/runtime-stage-progress.js";
import { parseAgentContractSessionKey } from "../lib/session-keys.js";

function ignorePassiveHeartbeatSession({
  agentId,
  sessionKey,
  detail,
  logger,
}) {
  ignoreHeartbeatSession(sessionKey);
  broadcast("heartbeat", {
    kind: "survival_check",
    agentId,
    sessionKey,
    availability: "available",
    actionable: false,
    detail,
    ts: Date.now(),
  });
  logger.info(`[watchdog] idle heartbeat session ignored: ${sessionKey}`);
}

function ignoreTerminalSessionReentry(sessionKey, logger, reason = null) {
  ignoreHeartbeatSession(sessionKey);
  logger.info(
    `[watchdog] ignoring terminal session re-entry for ${sessionKey}`
    + (reason ? ` reason=${reason}` : ""),
  );
}

export function register(api, logger, { enqueue, wakePlanner }) {
  api.on("before_agent_start", async (_event, ctx) => {
    const sessionKey = ctx.sessionKey;
    const agentId = ctx.agentId ?? "unknown";
    const contractSession = parseAgentContractSessionKey(sessionKey);
    const exactContractId = contractSession?.agentId === agentId
      ? contractSession.contractId
      : null;
    const routeInboxOptions = {
      sessionKey,
      ...(exactContractId
        ? {
            contractIdHint: exactContractId,
            contractPathHint: getContractPath(exactContractId),
          }
        : {}),
    };

    if (agentId.startsWith("watchdog")) return;

    logger.info(`[watchdog] >> before_agent_start: ${sessionKey} (agent: ${agentId})`);

    const ingressResult = await handleBeforeStartIngress({
      event: _event,
      agentId,
      sessionKey,
      api,
      enqueue,
      wakePlanner,
      logger,
    });

    const isSubagent = sessionKey.includes("subagent");
    const parentSession = isSubagent
      ? sessionKey.replace(/:subagent:.*$/, ":main")
      : null;
    const isPassiveMainSession = !sessionKey.includes(":hook:") && !isSubagent;

    if ((sessionKey.includes(":hook:") || isSubagent) && !hasTrackingSession(sessionKey)) {
      await loadState(logger);
    }

    // Worker main heartbeats should not touch a contract while a hook session for the
    // same worker is already running. Otherwise one contract gets rebound twice.
    if (isWorker(agentId) && isPassiveMainSession && hasConcurrentTrackingSessionForAgent(agentId, sessionKey)) {
      ignorePassiveHeartbeatSession({
        agentId,
        sessionKey,
        detail: "idle heartbeat, worker already has a live tracked session",
        logger,
      });
      return;
    }

    // Resume existing tracker
    if (hasTrackingSession(sessionKey)) {
      unignoreHeartbeatSession(sessionKey);
      const terminalReason = getTerminalTrackingSessionReason(sessionKey);
      if (terminalReason) {
        ignoreTerminalSessionReentry(sessionKey, logger, terminalReason);
        return;
      }

      const existing = markTrackingSessionRunning(sessionKey);
      const resumedFollowUpLease = resumeRuntimeFollowUpLease(existing);
      logger.info(`[watchdog] resuming existing tracking for ${sessionKey}`);
      if (resumedFollowUpLease) {
        await persistState(logger);
        logger.info(
          `[watchdog] resumed follow-up lease for ${sessionKey} `
          + `(${resumedFollowUpLease.workflow || "system_action delivery"})`,
        );
      }

      if (isWorker(agentId) && !existing.contract) {
        const bound = await bindPendingWorkerContract({
          agentId,
          sessionKey,
          trackingState: existing,
          logger,
          logContext: "resumed session",
          requiredContractId: exactContractId,
        });
        if (bound) {
          await routeInbox(agentId, logger, routeInboxOptions);
        }
      }

      if (!existing.contract) {
        await bindInboxContractEnvelope({
          agentId,
          trackingState: existing,
          logger,
          allowNonDirectRequest: true,
          requiredContractId: exactContractId,
        });
        await bindInboxArtifactContext({
          agentId,
          trackingState: existing,
          logger,
        });
      }

      await syncTrackingRuntimeStageProgress(existing);
      await refreshTrackingProjection(existing);
      broadcast("track_start", buildProgressPayload(existing));
      return;
    }

    if (sessionKey.includes(":hook:") || isSubagent) {
      const terminalReason = getTerminalTrackingSessionReason(sessionKey);
      if (terminalReason) {
        ignoreTerminalSessionReentry(sessionKey, logger, terminalReason);
        return;
      }
    }

    // Create new tracker
    const trackingState = createTrackingState({ sessionKey, agentId, parentSession });
    unignoreHeartbeatSession(sessionKey);

    // Bind any pending executor contract before the session starts running
    if (isWorker(agentId)) {
      await bindPendingWorkerContract({
        agentId,
        sessionKey,
        trackingState,
        logger,
        logContext: "session",
        requiredContractId: exactContractId,
      });
    }

    await routeInbox(agentId, logger, routeInboxOptions);

    if (!trackingState.contract) {
      await bindInboxContractEnvelope({
        agentId,
        trackingState,
        logger,
        allowNonDirectRequest: true,
        requiredContractId: exactContractId,
      });
      await bindInboxArtifactContext({
        agentId,
        trackingState,
        logger,
      });
    }

    if (isPassiveMainSession && await hasActionableHeartbeatWork(agentId, trackingState, sessionKey) === false) {
      ignorePassiveHeartbeatSession({
        agentId,
        sessionKey,
        detail: "idle heartbeat, no actionable inbox work",
        logger,
      });
      return;
    }

    rememberTrackingState(sessionKey, trackingState);
    initTrace(sessionKey, trackingState.contract);

    await runWorkerHardPathAutoExec({ agentId, trackingState, logger });

    await syncTrackingRuntimeStageProgress(trackingState);
    await refreshTrackingProjection(trackingState);
    broadcast("track_start", buildProgressPayload(trackingState));
    logger.info(`[watchdog] tracking started: ${sessionKey}`);
  });
}
