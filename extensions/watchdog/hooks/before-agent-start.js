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
import { refreshTrackingProjection } from "../lib/stage/stage-projection.js";
import { routeInbox } from "../lib/routing/mailbox/runtime-mailbox.js";
import { handleBeforeStartIngress } from "../lib/ingress/before-start-ingress.js";
import { hasActionableHeartbeatWork } from "../lib/heartbeat-gate.js";
import { getContractPath } from "../lib/contract/contracts.js";
import { wireTurnStarted } from "../lib/archive/run-event-wiring.js";
import {
  createTrackingState,
  bindPendingWorkerContract,
  bindInboxContractEnvelope,
  refreshTrackingInputIoObservation,
} from "../lib/session/session-bootstrap.js";
import {
  hasTrackingSession,
  hasConcurrentTrackingSessionForAgent,
  getTerminalTrackingSessionReason,
  markTrackingSessionRunning,
  rememberTrackingState,
} from "../lib/store/tracker-store.js";
import { resumeRuntimeFollowUpLease } from "../lib/runtime-follow-up-lease.js";
import { isAgentEndInFlight, waitForAgentEndSettled } from "../lib/session/session-phase-store.js";
import { openSessionProgress } from "../lib/evidence/session-progress-projection.js";
import { openSessionTrace } from "../lib/evidence/session-trace-store.js";
import { syncTrackingRuntimeStageProgress } from "../lib/stage/runtime-stage-progress.js";
import { parseAgentContractSessionKey } from "../lib/session/session-keys.js";
import { composeEffectiveProfile } from "../lib/effective-profile-composer.js";
import { loadConfig } from "../lib/agent/admin/agent-admin-store.js";

async function resolveExecutionPolicySnapshot(agentId, logger) {
  try {
    const cfg = await loadConfig();
    const agentConfig = cfg?.agents?.list?.find((entry) => entry?.id === agentId) || null;
    if (!agentConfig) return null;
    const profile = composeEffectiveProfile({ config: cfg, agentConfig });
    return profile?.policies?.effectiveExecutionPolicy || null;
  } catch (err) {
    logger?.warn?.(`[watchdog] executionPolicy snapshot failed for ${agentId}: ${err?.message || err}`);
    return null;
  }
}

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

export function register(api, logger) {
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

    // 收尾让位：本 sessionKey 的 agent_end 流水线还在飞时，先等它落地再决定
    // resume/新建。唤醒撞进收尾窗口会复活一个即将被 finalize 拆除的 tracker，
    // 之后整个回合无 tracker 运行、收尾静默跳过（2026-08-10 幽灵回合竞态）。
    // 等完后若 tracker 已删，自然走下方全新建 tracking 的正路（绑回投 envelope）。
    if (isAgentEndInFlight(sessionKey)) {
      logger.info(`[watchdog] waiting for in-flight agent_end to settle before binding ${sessionKey}`);
      await waitForAgentEndSettled(sessionKey);
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

      const resumedWithoutContract = !existing.contract;
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
      }

      // 事件接线(批② §八):resume 且本次新绑上合约 = 新回合开始(纯 resume 不重复记)。
      if (resumedWithoutContract && existing.contract) {
        void wireTurnStarted({
          contract: existing.contract,
          agentId,
          sessionKey,
          logger,
        });
      }

      await syncTrackingRuntimeStageProgress(existing);
      refreshTrackingInputIoObservation(existing, agentId);
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

    const executionPolicy = await resolveExecutionPolicySnapshot(agentId, logger);
    const trackingState = createTrackingState({ sessionKey, agentId, parentSession, executionPolicy });
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
    // 事件接线(批② §八):新 tracking 会话携合约起跑 = turn_started。fire-and-forget。
    if (trackingState.contract) {
      void wireTurnStarted({
        contract: trackingState.contract,
        agentId,
        sessionKey,
        logger,
      });
    }
    openSessionProgress(sessionKey, trackingState.contract, { agentId });
    await openSessionTrace(sessionKey, {
      agentId, contractId: trackingState.contract?.id ?? null,
    }).catch((error) => logger.warn(`[watchdog] trace open failed (non-blocking): ${error.message}`));
    refreshTrackingInputIoObservation(trackingState, agentId);

    await syncTrackingRuntimeStageProgress(trackingState);
    await refreshTrackingProjection(trackingState);
    broadcast("track_start", buildProgressPayload(trackingState));
    logger.info(`[watchdog] tracking started: ${sessionKey}`);
  });
}
