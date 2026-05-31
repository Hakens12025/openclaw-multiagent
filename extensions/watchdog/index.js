// index.js — Plugin entry point: register() + wire hooks/routes + gateway_start
// All logic lives in lib/, hooks/, and routes/. This file only does wiring.

import { readdir, readFile, stat, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  OC, CONTRACTS_DIR, HOME,
  cfg, setApiRef, agentWorkspace,
  intervalHandles,
  loadState,
} from "./lib/state.js";
import { clearAgentCards, setAgentCard } from "./lib/store/agent-card-store.js";
import { getIgnoredHeartbeatSessionCount, clearIgnoredHeartbeatSessions } from "./lib/store/heartbeat-session-store.js";
import { deleteTrackingSession, listTrackingEntries } from "./lib/store/tracker-store.js";
import { pruneDispatchChainOrigins } from "./lib/store/contract-flow-store.js";
import { broadcast } from "./lib/transport/sse.js";
import { runtimeWakeAgent } from "./lib/transport/runtime-wake-transport.js";
import { listQQTypingContracts, qqTypingStop } from "./lib/channel-notify.js";
import { mutateContractSnapshot } from "./lib/contracts.js";
import { getContractCacheSize, clearContractStore } from "./lib/store/contract-store.js";
import { finalizeAgentSession } from "./lib/lifecycle/runtime-lifecycle.js";
import {
  buildDispatchRuntimeSnapshot,
  hasDispatchTarget,
  listDispatchTargetIds,
  loadDispatchRuntimeState,
  persistDispatchRuntimeState,
  releaseDispatchTargetContract,
  syncDispatchTargetsFromRuntime,
} from "./lib/routing/dispatch-runtime-state.js";
import { reconcileDispatchRuntimeTruth } from "./lib/routing/dispatch-runtime-reconcile.js";
// plan-dispatch-service eliminated: DRAFT lifecycle removed, graph handles dispatch.
// wakePlanner kept as no-op to satisfy function signatures across the system.
import { ensureRouterDirs } from "./lib/routing/runtime-mailbox-transport.js";
import {
  getRuntimeAgentConfig,
  listGatewayAgentIds,
  listRuntimeAgentIds,
  registerRuntimeAgents,
} from "./lib/agent/agent-identity.js";
import { syncAllRuntimeWorkspaceGuidance } from "./lib/workspace-guidance-writer.js";
import { scanAndRecordWorkspaceGuidanceDrift } from "./lib/agent/agent-guidance-drift.js";
import { pruneAllWorkspaceGuidanceBackups } from "./lib/agent/agent-guidance-backup.js";
import { prunePendingSignals } from "./lib/runtime/pending-signal-registry.js";
import { CONTROL_PLANE_PATHS } from "./lib/control-plane/control-plane-paths.js";
import { migrateControllerRootedStores } from "./lib/control-plane/control-plane-migrate.js";
import { migrateOperatorWorkspace } from "./lib/agent/operator-workspace-migrate.js";
import { rehydrateRuntimeDirectEnvelopePendingSignals } from "./lib/runtime-direct-envelope-queue.js";
import { rehydrateSystemActionDeliveryPendingSignals } from "./lib/routing/delivery-system-action-ticket.js";
import { getActiveLoopState } from "./lib/loop/loop-session-store.js";
import {
  armLateCompletionLease,
  getLateCompletionLeaseMs,
} from "./lib/late-completion-lease.js";
import {
  pollDueAutomations,
  reconcileAutomationRuntimeStates,
} from "./lib/automation/automation-executor.js";
import { recoverOrphanedContracts, pruneTerminalContracts } from "./lib/lifecycle/crash-recovery.js";
import { drainIdleDispatchTargets } from "./lib/routing/dispatch-graph-policy.js";

// Hooks
import * as beforeToolCallHook from "./hooks/before-tool-call.js";
import * as beforePromptBuildHook from "./hooks/before-prompt-build.js";
import * as beforeAgentStartHook from "./hooks/before-agent-start.js";
import * as afterToolCallHook from "./hooks/after-tool-call.js";
import * as agentEndHook from "./hooks/agent-end.js";

// Routes
import * as dashboardRoutes from "./routes/dashboard.js";
import * as apiRoutes from "./routes/api.js";
import * as a2aRoutes from "./routes/a2a.js";

// ── Agent Card loader ────────────────────────────────────────────────────────
import {
  NON_RUNNING_TRACKER_RETENTION_MS,
  RUNNING_TRACKER_ABSOLUTE_TIMEOUT_FLOOR_MS,
  RUNNING_TRACKER_STALE_SILENCE_MS,
} from "./lib/state-constants.js";
const AUTO_TRACKER_TIMEOUT_RECOVERY_ENABLED = false;

function getTrackerLastActivityTs(trackingState) {
  if (!trackingState) return Date.now();
  const lastToolCall = Array.isArray(trackingState.toolCalls) && trackingState.toolCalls.length > 0
    ? trackingState.toolCalls[trackingState.toolCalls.length - 1]
    : null;
  return lastToolCall?.ts || trackingState.startMs || Date.now();
}

function getRunningTrackerAbsoluteTimeoutMs() {
  return Math.max(cfg.agentTimeout * 2, RUNNING_TRACKER_ABSOLUTE_TIMEOUT_FLOOR_MS);
}

async function initExecutionLaneTargets(logger) {
  await syncDispatchTargetsFromRuntime(logger);
}

async function resolveTrackerTimeoutLoopStage(trackingState) {
  const trackedStage = trackingState?.contract?.pipelineStage;
  if (trackedStage && typeof trackedStage === "object" && trackedStage.stage) {
    return trackedStage;
  }

  const activeLoopRuntime = await getActiveLoopState();
  if (!activeLoopRuntime?.currentStage || activeLoopRuntime.currentStage === "concluded") {
    return null;
  }
  if (trackingState?.agentId && activeLoopRuntime.currentStage !== trackingState.agentId) {
    return null;
  }

  return {
    stage: activeLoopRuntime.currentStage,
    pipelineId: activeLoopRuntime.pipelineId || null,
    loopId: activeLoopRuntime.loopId || null,
    loopSessionId: activeLoopRuntime.loopSessionId || null,
    round: Number.isFinite(activeLoopRuntime.round) ? activeLoopRuntime.round : null,
  };
}

// ── Periodic memory cleanup ──────────────────────────────────────────────────
const IGNORED_SESSION_TTL_MS = 30 * 60_000;  // 30 min
const CONTRACT_CACHE_MAX = 200;

function pruneStaleCollections(logger, now) {
  let pruned = 0;

  // 1. ignoredHeartbeatSessions: clear if stale (no TTL metadata, just cap size)
  const heartbeatSessionCount = getIgnoredHeartbeatSessionCount();
  if (heartbeatSessionCount > 100) {
    clearIgnoredHeartbeatSessions();
    pruned += heartbeatSessionCount;
    logger.info(`[cleanup] cleared ${heartbeatSessionCount} stale ignoredHeartbeatSessions`);
  }

  // 2. QQ typing indicators: clear orphaned intervals against active dispatch targets
  const runtimeSnapshot = buildDispatchRuntimeSnapshot();
  for (const contractId of listQQTypingContracts()) {
    const active = Object.values(runtimeSnapshot.targets || {})
      .some((state) => state?.currentContract === contractId);
    if (!active) {
      qqTypingStop(contractId);
      pruned++;
    }
  }

  // 3. Contract snapshot cache: clear if over threshold
  const cacheSize = getContractCacheSize();
  if (cacheSize > CONTRACT_CACHE_MAX) {
    clearContractStore();
    logger.info(`[cleanup] cleared contract cache (was ${cacheSize} entries)`);
    pruned += cacheSize;
  }

  if (pruned > 0) {
    logger.info(`[cleanup] pruned ${pruned} stale entries`);
  }
}

export async function maintainDispatchQueue({
  api,
  logger,
} = {}) {
  await reconcileDispatchRuntimeTruth(logger);
  await syncDispatchTargetsFromRuntime(logger);
  await drainIdleDispatchTargets(api, logger);
  await persistDispatchRuntimeState(logger);
}

export async function cleanupStaleRunningTracker({
  sessionKey,
  trackingState,
  api,
  logger,
}) {
  if (!trackingState) return;

  const now = Date.now();
  const timeoutMs = getRunningTrackerAbsoluteTimeoutMs();
  const lastActivityTs = getTrackerLastActivityTs(trackingState);
  const elapsedMs = Math.max(0, now - (trackingState.startMs || now));
  const silenceMs = Math.max(0, now - lastActivityTs);
  const timeoutDiagnostic = {
    lane: "tracker_timeout",
    timeoutMs,
    elapsedMs,
    silenceMs,
    ts: now,
  };

  logger.warn(
    `[watchdog] stale running tracker cleanup: ${sessionKey} `
    + `(agent=${trackingState.agentId}, elapsed=${Math.round(elapsedMs / 1000)}s, silence=${Math.round(silenceMs / 1000)}s)`,
  );

  const loopStage = await resolveTrackerTimeoutLoopStage(trackingState);
  const lateCompletionLease = armLateCompletionLease(trackingState, {
    reason: "tracker_timeout",
    diagnostic: timeoutDiagnostic,
    leaseMs: getLateCompletionLeaseMs(),
    loopStage,
  });

  broadcast("alert", {
    type: "runtime_tracker_timed_out",
    agentId: trackingState.agentId,
    sessionKey,
    contractId: trackingState.contract?.id || null,
    timeoutMs,
    elapsedMs,
    silenceMs,
    ts: now,
  });

  if (trackingState.contract) {
    if (!trackingState.contract.pipelineStage && loopStage) {
      trackingState.contract.pipelineStage = { ...loopStage };
    }
    trackingState.contract.runtimeDiagnostics = {
      ...(trackingState.contract.runtimeDiagnostics && typeof trackingState.contract.runtimeDiagnostics === "object"
        ? trackingState.contract.runtimeDiagnostics
        : {}),
      trackerTimeout: timeoutDiagnostic,
      ...(lateCompletionLease ? { lateCompletionLease } : {}),
    };
    if (!lateCompletionLease && trackingState.contract.status === "running") {
      trackingState.contract.status = "failed";
      trackingState.contract.failReason = "tracker_timeout";
    }
  }

  if (trackingState.contract?.path) {
    try {
      await mutateContractSnapshot(trackingState.contract.path, logger, (contract) => {
        const runtimeDiagnostics = contract.runtimeDiagnostics && typeof contract.runtimeDiagnostics === "object"
          ? contract.runtimeDiagnostics
          : {};
        if (!contract.pipelineStage && loopStage) {
          contract.pipelineStage = { ...loopStage };
        }
        contract.runtimeDiagnostics = {
          ...runtimeDiagnostics,
          trackerTimeout: timeoutDiagnostic,
          ...(lateCompletionLease ? { lateCompletionLease } : {}),
        };
        if (!lateCompletionLease && contract.status === "running") {
          contract.status = "failed";
          contract.failReason = "tracker_timeout";
          return { cleaned: true };
        }
        return { cleaned: false };
      }, {
        touchUpdatedAt: true,
      });
    } catch (error) {
      logger.warn(`[watchdog] stale tracker contract cleanup failed for ${sessionKey}: ${error.message}`);
    }
  }

  if (lateCompletionLease) {
    if (hasDispatchTarget(trackingState.agentId)) {
      await releaseDispatchTargetContract({ agentId: trackingState.agentId, logger });
    }
    broadcast("alert", {
      type: "runtime_tracker_timeout_grace",
      agentId: trackingState.agentId,
      sessionKey,
      contractId: trackingState.contract?.id || null,
      pipelineId: lateCompletionLease.pipelineId || null,
      loopId: lateCompletionLease.loopId || null,
      loopSessionId: lateCompletionLease.loopSessionId || null,
      stage: lateCompletionLease.stage || null,
      expiresAt: lateCompletionLease.expiresAt || null,
      timeoutMs,
      elapsedMs,
      silenceMs,
      ts: now,
    });
    await persistDispatchRuntimeState(logger);
    return;
  }

  trackingState.status = "failed";
  trackingState.lastLabel = "运行态收口：stale tracker timeout";
  await finalizeAgentSession({
    agentId: trackingState.agentId,
    sessionKey,
    trackingState,
    api,
    logger,
  });
}

async function loadAgentCards(logger) {
  clearAgentCards();
  for (const agentId of listRuntimeAgentIds()) {
    const runtimeAgent = getRuntimeAgentConfig(agentId);
    const ws = runtimeAgent?.workspace
      ? runtimeAgent.workspace.replace(/^~(?=\/|$)/, HOME)
      : join(OC, `workspaces/${agentId}`);
    const paths = [
      join(ws, "agent-card.json"),
      join(OC, "workspaces", "_configs", `${agentId}-agent-card.json`),
    ];
    let loaded = false;
    for (const p of paths) {
      try {
        const raw = await readFile(p, "utf8");
        setAgentCard(agentId, JSON.parse(raw));
        logger.info(`[a2a] loaded agent card: ${agentId}`);
        loaded = true;
        break;
      } catch {}
    }
    if (!loaded) logger.info(`[a2a] no agent card for ${agentId}`);
  }
}

// ── Lock file cleanup ────────────────────────────────────────────────────────
async function cleanStaleLocks(logger) {
  const base = join(OC, "agents");
  let cleaned = 0;
  try {
    const agents = await readdir(base);
    for (const agent of agents) {
      const sessDir = join(base, agent, "sessions");
      let files; try { files = await readdir(sessDir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".lock")) continue;
        try {
          const s = await stat(join(sessDir, f));
          if ((Date.now() - s.mtimeMs) / 60000 > 30) {
            await unlink(join(sessDir, f));
            cleaned++;
          }
        } catch {}
      }
    }
  } catch {}
  if (cleaned > 0) logger.info(`[watchdog] cleaned ${cleaned} lock(s)`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Plugin
// ══════════════════════════════════════════════════════════════════════════════

const plugin = {
  id: "watchdog",
  name: "Watchdog",
  description: "Industrial-grade progress tracker: hardcoded hooks + SSE dashboard + QQ alerts",

  register(api) {
    const { logger, config } = api;
    logger.info("[watchdog] ===== WATCHDOG PLUGIN LOADING (V3 modular) =====");

    // ── Config ──
    cfg.qqAppId = config?.channels?.qqbot?.appId || "";
    cfg.qqClientSecret = config?.channels?.qqbot?.clientSecret || "";
    cfg.hooksToken = config?.hooks?.token || "";
    cfg.gatewayPort = config?.gateway?.port || 18789;
    cfg.gatewayToken = config?.gateway?.auth?.token ?? "";
    cfg.agentTimeout = (config?.agents?.defaults?.timeoutSeconds || 1800) * 1000;

    if (cfg.qqAppId) logger.info(`[watchdog] QQ credentials loaded (appId: ${cfg.qqAppId.slice(0, 4)}...)`);
    logger.info(`[watchdog] runtime wake: hooks-first + heartbeat-fallback (port: ${cfg.gatewayPort})`);
    registerRuntimeAgents(config);

    // ── Dependency injection helpers ──
    // These create closures that hook/route modules can use
    const enqueueFn = () => true;
    const wakePlanner = () => {}; // No-op: DRAFT lifecycle eliminated, graph handles dispatch
    const deps = { enqueue: enqueueFn, enqueueFn, wakePlanner };

    // ── Register hooks ──
    beforeToolCallHook.register(api, logger);
    beforePromptBuildHook.register(api, logger);
    beforeAgentStartHook.register(api, logger, deps);
    afterToolCallHook.register(api, logger, deps);
    agentEndHook.register(api, logger, deps);

    // ── Register routes ──
    dashboardRoutes.register(api);
    apiRoutes.register(api, logger, deps);
    a2aRoutes.register(api, logger, deps);

    // ── Gateway start ──
    api.on("gateway_start", async (event) => {
      logger.info(`[watchdog] ===== GATEWAY STARTED on port ${event.port} =====`);
      logger.info(`[watchdog] dashboard → http://localhost:${event.port}/watchdog/progress`);

      await initExecutionLaneTargets(logger);
      setApiRef(api);
      const wIds = listDispatchTargetIds();

      try {
        await migrateControllerRootedStores({ logger });
      } catch (error) {
        logger?.warn?.(`[watchdog] control-plane migration check failed: ${error?.message || error}`);
      }
      try {
        await migrateOperatorWorkspace({ logger });
      } catch (error) {
        logger?.warn?.(`[watchdog] operator workspace migration check failed: ${error?.message || error}`);
      }
      await mkdir(CONTRACTS_DIR, { recursive: true });
      await mkdir(CONTROL_PLANE_PATHS.outputDir, { recursive: true });
      for (const gatewayAgentId of listGatewayAgentIds()) {
        await mkdir(join(agentWorkspace(gatewayAgentId), "deliveries"), { recursive: true });
      }
      await ensureRouterDirs(logger, wIds);

      try {
        const preScan = await scanAndRecordWorkspaceGuidanceDrift({ label: "pre-sync", scanSource: "startup" });
        logger?.info?.(`[watchdog] GUIDANCE_DRIFT/pre-sync: ${preScan.scan.driftCount}`);
      } catch (error) {
        logger?.warn?.(`[watchdog] guidance drift pre-sync scan failed: ${error?.message || error}`);
      }
      await syncAllRuntimeWorkspaceGuidance(config, logger);
      try {
        const postScan = await scanAndRecordWorkspaceGuidanceDrift({ label: "post-sync", scanSource: "startup" });
        logger?.info?.(`[watchdog] GUIDANCE_DRIFT/post-sync: ${postScan.scan.driftCount}`);
      } catch (error) {
        logger?.warn?.(`[watchdog] guidance drift post-sync scan failed: ${error?.message || error}`);
      }
      try {
        await pruneAllWorkspaceGuidanceBackups({ logger });
      } catch (error) {
        logger?.warn?.(`[watchdog] guidance backup prune failed: ${error?.message || error}`);
      }

      // Pending-signal registry boot-time rehydrate. Reconstruct actionable
      // signals from durable sources so heartbeat gate decisions reflect
      // persistent truth immediately after restart. Sources are independent.
      try {
        const [direct, delivery] = await Promise.all([
          rehydrateRuntimeDirectEnvelopePendingSignals({ logger }),
          rehydrateSystemActionDeliveryPendingSignals({ logger }),
        ]);
        logger?.info?.(`[watchdog] pending-signal rehydrate: direct=${direct.registered} delivery=${delivery.registered}`);
      } catch (error) {
        logger?.warn?.(`[watchdog] pending-signal rehydrate failed: ${error?.message || error}`);
      }

      await loadAgentCards(logger);
      await loadState(logger);
      await loadDispatchRuntimeState(logger);
      await syncDispatchTargetsFromRuntime(logger);
      await recoverOrphanedContracts({ api, logger });
      await reconcileDispatchRuntimeTruth(logger);
      await syncDispatchTargetsFromRuntime(logger);
      await persistDispatchRuntimeState(logger);
      await drainIdleDispatchTargets(api, logger);
      const emitAlert = (payload) => {
        if (payload?.type) broadcast("alert", payload);
      };
      await reconcileAutomationRuntimeStates({ logger, onAlert: emitAlert });
      await pollDueAutomations({
        api,
        enqueue: enqueueFn,
        wakePlanner,
        logger,
        onAlert: emitAlert,
      });

      const runtimeSnapshot = buildDispatchRuntimeSnapshot();
      if (runtimeSnapshot.queue.length > 0) {
        logger.info(`[queue] recovered ${runtimeSnapshot.queue.length} pending task(s) after startup reconciliation`);
      }

      // Prune old terminal contracts (keep 50 most recent)
      await pruneTerminalContracts({ logger });

      await cleanStaleLocks(logger);

      // Periodic maintenance
      intervalHandles.push(
        setInterval(() => cleanStaleLocks(logger), 15 * 60_000),
        setInterval(() => prunePendingSignals(), 5 * 60_000),
        setInterval(() => {
          scanAndRecordWorkspaceGuidanceDrift({ label: "maintenance", scanSource: "interval" })
            .catch((error) => logger?.warn?.(`[watchdog] periodic drift scan failed: ${error?.message || error}`));
        }, 15 * 60_000),

        setInterval(() => {
          const now = Date.now();
          const staleRunningTrackers = [];
          for (const [key, t] of listTrackingEntries()) {
            if (t.status !== "running") {
              if ((now - t.startMs) > NON_RUNNING_TRACKER_RETENTION_MS) {
                deleteTrackingSession(key);
              }
              continue;
            }

            if (!AUTO_TRACKER_TIMEOUT_RECOVERY_ENABLED) {
              continue;
            }

            const lastActivityTs = getTrackerLastActivityTs(t);
            const elapsedMs = now - t.startMs;
            const silenceMs = now - lastActivityTs;
            if (elapsedMs > getRunningTrackerAbsoluteTimeoutMs() && silenceMs > RUNNING_TRACKER_STALE_SILENCE_MS) {
              staleRunningTrackers.push({ sessionKey: key, trackingState: t });
            }
          }
          for (const staleTracker of staleRunningTrackers) {
            void cleanupStaleRunningTracker({
              ...staleTracker,
              api,
              logger,
            });
          }
          void pruneDispatchChainOrigins(cfg.agentTimeout, {
            logger,
            now,
          });
          void maintainDispatchQueue({ api, logger });
          // Periodic memory cleanup: prune stale entries from unbounded collections
          pruneStaleCollections(logger, now);
        }, 5 * 60_000),

        setInterval(() => {
          const now = Date.now();
          for (const [key, t] of listTrackingEntries()) {
            if (t.status !== "running") continue;
            const lastActivity = getTrackerLastActivityTs(t);
            if ((now - lastActivity) > RUNNING_TRACKER_STALE_SILENCE_MS) {
              logger.warn(`[watchdog] inactivity detected: ${key}`);
              try { void runtimeWakeAgent(t.agentId, "inactivity", api, logger); } catch {}
            }
          }
        }, 3 * 60_000),

        setInterval(async () => {
          try {
            const emitAlert = (payload) => {
              if (payload?.type) broadcast("alert", payload);
            };
            await reconcileAutomationRuntimeStates({ logger, onAlert: emitAlert });
            await pollDueAutomations({
              api,
              enqueue: enqueueFn,
              wakePlanner,
              logger,
              onAlert: emitAlert,
            });
          } catch (error) {
            logger.warn(`[watchdog] automation poll error: ${error.message}`);
          }
        }, 60_000),
      );

      logger.info("[watchdog] ===== WATCHDOG V3 MODULAR FULLY INITIALIZED =====");
    });
  },
};

export default plugin;
