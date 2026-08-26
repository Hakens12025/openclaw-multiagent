// index.js — Plugin entry point: register() + wire hooks/routes + gateway_start
// All logic lives in lib/, hooks/, and routes/. This file only does wiring.

import { readdir, readFile, stat, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  OC, HOME,
  cfg, setApiRef, agentWorkspace,
  loadState,
} from "./lib/state.js";
import { kernelLease } from "./lib/core/kernel-lease.js";
import { validateCfgAssignment } from "./lib/core/config-check.js";
import { bootLedger } from "./lib/core/boot-ledger.js";
import { clearAgentCards, setAgentCard, sweepAgentCards } from "./lib/store/agent-card-store.js";
import { getIgnoredHeartbeatSessionCount, clearIgnoredHeartbeatSessions } from "./lib/store/heartbeat-session-store.js";
import { deleteTrackingSession, listTrackingEntries } from "./lib/store/tracker-store.js";
import { pruneDispatchChainOrigins } from "./lib/store/contract-flow-store.js";
import { broadcast } from "./lib/transport/sse.js";
import { sweepRunningTrackers } from "./lib/lifecycle/agent-timeout-sweep.js";
import { listQQTypingContracts, qqTypingStop } from "./lib/transport/channel-notify.js";
import { getContractCacheSize, clearContractStore } from "./lib/store/contract-store.js";
import {
  buildDispatchRuntimeSnapshot,
  listDispatchTargetIds,
  loadDispatchRuntimeState,
  persistDispatchRuntimeState,
  syncDispatchTargetsFromRuntime,
} from "./lib/routing/dispatch/dispatch-runtime-state.js";
import { reconcileDispatchRuntimeTruth } from "./lib/routing/dispatch/dispatch-runtime-reconcile.js";
// plan-dispatch-service eliminated: DRAFT lifecycle removed, graph handles dispatch.
import { ensureMailboxDirs } from "./lib/routing/mailbox/runtime-mailbox-transport.js";
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
import {
  buildCollaborationTools,
  listCollaborationToolNames,
} from "./lib/system-action/collaboration-toolface.js";
import {
  buildKnowledgeTools,
  listKnowledgeToolNames,
} from "./lib/knowledge/knowledge-toolface.js";
import { buildPlatformServiceTools } from "./lib/system-action/platform-service-toolface.js";
import { listExposedPlatformServiceTools } from "./lib/system-action/platform-service-tools.js";
import {
  buildDiscoveryTools,
  listDiscoveryToolNames,
} from "./lib/system-action/discovery-toolface.js";
import { migrateControllerRootedStores } from "./lib/control-plane/control-plane-migrate.js";
import { migrateOperatorWorkspace } from "./lib/agent/operator-workspace-migrate.js";
import { buildWikiRagIndex } from "./lib/knowledge/wiki-rag-store.js";
import { rehydrateRuntimeDirectEnvelopePendingSignals } from "./lib/routing/runtime-direct-envelope-queue.js";
import { rehydrateSystemActionDeliveryPendingSignals } from "./lib/routing/delivery/delivery-system-action-ticket.js";
import {
  pollDueAutomations,
  reconcileAutomationRuntimeStates,
} from "./lib/automation/automation-executor.js";
import { recoverOrphanedContracts, pruneTerminalContracts } from "./lib/lifecycle/crash-recovery.js";
import { rebuildContractIndex } from "./lib/archive/thread-tree-store.js";
import { rebuildSessionIndex } from "./lib/archive/session-home-index.js";
import { purgeLegacyArchiveStores } from "./lib/lifecycle/legacy-archive-purge.js";
import { drainIdleDispatchTargets } from "./lib/routing/dispatch/dispatch-graph-policy.js";
import { pokeDeliveryPump, startDeliveryPumpBackstop } from "./lib/routing/delivery/delivery-pump.js";

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
} from "./lib/state/state-constants.js";

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

  // agentCards 幽灵兜底(RX-01 试点):60s 宽限盖住 create/delete 在途窗口;
  // dryRun soak 期只告警不删,确认无合法 card-only agent 误报后经用户点头改 false。
  sweepAgentCards((agentId) => Boolean(getRuntimeAgentConfig(agentId)), { logger, graceMs: 60_000, dryRun: true });

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
        setAgentCard(agentId, JSON.parse(raw), "gateway_start/loadAgentCards");
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
    Object.assign(cfg, validateCfgAssignment({
      qqAppId: config?.channels?.qqbot?.appId || "",
      qqClientSecret: config?.channels?.qqbot?.clientSecret || "",
      hooksToken: config?.hooks?.token || "",
      gatewayPort: config?.gateway?.port || 18789,
      gatewayToken: config?.gateway?.auth?.token ?? "",
      agentTimeout: (config?.agents?.defaults?.timeoutSeconds || 1800) * 1000,
    }));

    if (cfg.qqAppId) logger.info(`[watchdog] QQ credentials loaded (appId: ${cfg.qqAppId.slice(0, 4)}...)`);
    logger.info(`[watchdog] runtime wake: hooks-first + heartbeat-fallback (port: ${cfg.gatewayPort})`);
    registerRuntimeAgents(config);

    // ── Dependency injection container ──
    // Hook/route modules receive shared runtime handles through this object.
    const deps = {};

    // ── Collaboration FC tool face (spec §5 v1) ──
    // optional:true → 只对 tools.allow/alsoAllow 点名的 agent 物化;
    // 授权真源在 collaboration-intent-policy,工厂按角色裁剪。
    if (typeof api.registerTool === "function") {
      api.registerTool(
        (toolContext) => buildCollaborationTools({
          agentId: toolContext.agentId,
          sessionKey: toolContext.sessionKey,
          api,
          logger,
        }),
        { optional: true, names: listCollaborationToolNames() },
      );

      // ── Knowledge FC tool face v1 ──
      // 同样 optional:true → 只对 tools.allow 点名的 agent 物化。可见范围不在这里裁,
      // 由 selectAgentKnowledgeBases「绑定库 ∪ global」决定(传送带原则:无 agent 分支)。
      api.registerTool(
        (toolContext) => buildKnowledgeTools({ agentId: toolContext.agentId, logger }),
        { optional: true, names: listKnowledgeToolNames() },
      );

      // ── Platform service FC tool face v1 ──
      // 与协作族平级的第二族:agent 向平台交付,不跨 agent、不开票据、不查图边。
      // 本族无角色维度(声明自己这轮的结果谁都该能做),所以工厂里没有裁剪。
      api.registerTool(
        (toolContext) => buildPlatformServiceTools({ sessionKey: toolContext.sessionKey, logger }),
        { optional: true, names: listExposedPlatformServiceTools() },
      );

      // ── Discovery FC tool face (D-G:ls/grep 实装为一等工具) ──
      // 能力预设与 7 个 agent 的 tools.allow 早点名了 ls/grep(此前是静默无效
      // 的幽灵声明),optional:true 物化后自动生效,配置零改动。
      api.registerTool(
        (toolContext) => buildDiscoveryTools({ agentId: toolContext.agentId }),
        { optional: true, names: listDiscoveryToolNames() },
      );
    }

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

    // ── Gateway stop: kernel 租约清扫(副作用有主,RX-01)──
    api.on("gateway_stop", () => {
      const n = kernelLease.disposeAll((e, label) => logger?.warn?.(`[lease] dispose ${label}: ${e?.message || e}`));
      logger?.info?.(`[watchdog] gateway_stop: kernelLease disposed ${n} effect(s)`);
    });

    // ── Gateway start ──
    api.on("gateway_start", async (event) => {
      logger.info(`[watchdog] ===== GATEWAY STARTED on port ${event.port} =====`);
      logger.info(`[watchdog] dashboard → http://localhost:${event.port}/watchdog/`);

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
      // 索引 boot 自愈(审查⑥):无条件全树重建——树被 GC 有界,扫描便宜;
      // 缺失/撕裂/漏行一并修复,getContractPath 同步解析的底座每次启动归真。
      try {
        await rebuildContractIndex({ logger });
      } catch (e) {
        logger?.warn?.(`[watchdog] contract index rebuild failed at boot: ${e?.message}`);
      }
      // 会话 id→home 索引同规:boot 无条件全树重建归真(索引非真值,可再生)。
      try {
        await rebuildSessionIndex({ logger });
      } catch (e) {
        logger?.warn?.(`[watchdog] session index rebuild failed at boot: ${e?.message}`);
      }
      // 断代清扫:旧平铺档案店(session-archive/ + workflow-trace/)整目录退场。
      try {
        await purgeLegacyArchiveStores({ logger });
      } catch (e) {
        logger?.warn?.(`[watchdog] legacy archive purge failed at boot: ${e?.message}`);
      }
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

      // 投递泵后两层触发(备忘录141 §八):启动全量扫描(崩溃恢复,await 到排空
      // 完成——积压票据先消费,合约别在票据前被剪,审查⑨)+ 30s 慢背压兜底。
      // commit 后 poke(第一层)在 agent-end/terminal.js 出栈段;泵自建 interval,
      // 与本文件其余 interval 同为进程级寿命,stop 不另行登记。
      const startupDrain = pokeDeliveryPump({ api, logger });
      if (startupDrain.done) await startupDrain.done;
      startDeliveryPumpBackstop({ api, logger });

      // Run retention GC (GAP-04): keep the newest 20 runs per thread; expired
      // extra runs are deleted whole (dir) + contract index compacted.
      await pruneTerminalContracts({ logger });

      // wiki-RAG incremental reindex (fire-and-forget): only changed/new chunks
      // re-embed; ollama down → degrades to ok:true, no boot impact.
      buildWikiRagIndex({ logger }).catch((e) => logger?.warn?.(`[watchdog] wiki-rag reindex skipped: ${e.message}`));

      await cleanStaleLocks(logger);

      // Periodic maintenance
      const maintenanceHandles = [
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
      ];
      for (const handle of maintenanceHandles) {
        kernelLease.effect(() => clearInterval(handle), "maintenance-interval");
      }

      // RX-02 首批声明种子:先集中在装配点,推广批再下放到各属主模块。
      bootLedger.provide("store.tracker", "state-collections");
      bootLedger.provide("store.agent-cards", "agent-card-store");
      bootLedger.provide("store.contracts", "contract-store");
      bootLedger.provide("agent.identity", "agent-identity");
      bootLedger.requires("store.tracker", "lifecycle/agent-timeout-sweep");
      bootLedger.requires("store.contracts", "routing/dispatch");
      bootLedger.requires("agent.identity", "routing/dispatch");
      try {
        const bootSummary = bootLedger.assertComplete();
        logger.info(`[watchdog] boot deps ok: provided=${bootSummary.providedCount} required=${bootSummary.requiredCount}`);
      } catch (error) {
        // 宿主 hook-runner 以 catchErrors:true 吞 handler 异常(runVoidHook→handleHookError 只剩一行日志),
        // 裸 throw 是哑炮——fail-loud 必须自己造响:error 级日志 + SSE alert(broadcast 已在 index.js 导入)。
        logger.error(String(error?.message || error));
        broadcast("alert", { type: "boot_deps_missing", message: String(error?.message || error) });
      }

      // 不变量守卫:loadAgentCards 刚重建过,此处清出必须为 0;非 0 即装配 bug,warn 会记名。
      sweepAgentCards((agentId) => Boolean(getRuntimeAgentConfig(agentId)), { logger, graceMs: 0 });

      logger.info("[watchdog] ===== WATCHDOG V3 MODULAR FULLY INITIALIZED =====");
    });
  },
};

export default plugin;
