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
import { sweepRunningTrackers } from "./lib/lifecycle/agent-timeout-sweep.js";
import { listQQTypingContracts, qqTypingStop } from "./lib/channel-notify.js";
import { getContractCacheSize, clearContractStore } from "./lib/store/contract-store.js";
import {
  buildDispatchRuntimeSnapshot,
  listDispatchTargetIds,
  loadDispatchRuntimeState,
  persistDispatchRuntimeState,
  syncDispatchTargetsFromRuntime,
} from "./lib/routing/dispatch-runtime-state.js";
import { reconcileDispatchRuntimeTruth } from "./lib/routing/dispatch-runtime-reconcile.js";
// plan-dispatch-service eliminated: DRAFT lifecycle removed, graph handles dispatch.
import { ensureMailboxDirs } from "./lib/routing/runtime-mailbox-transport.js";
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
import { buildWikiRagIndex } from "./lib/operator/wiki-rag-store.js";
import { rehydrateRuntimeDirectEnvelopePendingSignals } from "./lib/runtime-direct-envelope-queue.js";
import { rehydrateSystemActionDeliveryPendingSignals } from "./lib/routing/delivery-system-action-ticket.js";
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
} from "./lib/state-constants.js";

async function initExecutionLaneTargets(logger) {
  await syncDispatchTargetsFromRuntime(logger);
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

    // ── Dependency injection container ──
    // Hook/route modules receive shared runtime handles through this object.
    const deps = {};

    // ── Register hooks ──
    beforeToolCallHook.register(api, logger);
    beforePromptBuildHook.register(api, logger);
    beforeAgentStartHook.register(api, logger);
    afterToolCallHook.register(api, logger);
    agentEndHook.register(api, logger);

    // ── Register routes ──
    dashboardRoutes.register(api);
    apiRoutes.register(api, logger, deps);
    a2aRoutes.register(api, logger);

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
      await ensureMailboxDirs(logger, wIds);

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
        logger,
        onAlert: emitAlert,
      });

      const runtimeSnapshot = buildDispatchRuntimeSnapshot();
      if (runtimeSnapshot.queue.length > 0) {
        logger.info(`[queue] recovered ${runtimeSnapshot.queue.length} pending task(s) after startup reconciliation`);
      }

      // Prune old terminal contracts (keep 50 most recent)
      await pruneTerminalContracts({ logger });

      // wiki-RAG incremental reindex (fire-and-forget): only changed/new chunks
      // re-embed; ollama down → degrades to ok:true, no boot impact.
      buildWikiRagIndex({ logger }).catch((e) => logger?.warn?.(`[watchdog] wiki-rag reindex skipped: ${e.message}`));

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
          for (const [key, t] of listTrackingEntries()) {
            if (t.status !== "running") {
              if ((now - t.startMs) > NON_RUNNING_TRACKER_RETENTION_MS) {
                deleteTrackingSession(key);
              }
            }
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
          // per-agent 硬超时(显式 constraints.timeoutSeconds)+ 静默 inactivity wake，
          // 统一收进 agent-timeout-sweep（可测模块，复用 agent_end 崩溃路径做 fail+retry）。
          void sweepRunningTrackers({ now: Date.now(), api, logger });
        }, 3 * 60_000),

        setInterval(async () => {
          try {
            const emitAlert = (payload) => {
              if (payload?.type) broadcast("alert", payload);
            };
            await reconcileAutomationRuntimeStates({ logger, onAlert: emitAlert });
            await pollDueAutomations({
              api,
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
