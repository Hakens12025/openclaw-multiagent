import { lstat, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import { EVENT_TYPE } from "../core/event-types.js";
import {
  OC,
  STATE_FILE,
  agentWorkspace,
  atomicWriteFile,
  clearRecentOperationGuards,
  operationLocks,
} from "../state.js";
import { qqTypingStopAll } from "../transport/channel-notify.js";
import {
  clearContractStore,
  listSharedContractEntries,
  readContractSnapshotByPath,
} from "../store/contract-store.js";
import { isTerminalContractStatus } from "../core/runtime-status.js";
import {
  clearDispatchChainStore, getDispatchChainSize,
} from "../store/contract-flow-store.js";
import { clearTrackingStore, getTrackingSessionCount } from "../store/tracker-store.js";
import { clearAllTraces } from "../store/execution-trace-store.js";
import { clearAllExecutionIncidents } from "../runtime/execution-incident-store.js";
import { clearAllPendingSignals } from "../runtime/pending-signal-registry.js";
import { clearSystemActionDeliveryTicketStore } from "../routing/delivery/delivery-system-action-ticket.js";
// cancelAllPlanDispatches eliminated: DRAFT lifecycle removed.
import { clearTaskHistory, getTaskHistoryCount } from "../store/task-history-store.js";
import { clearIgnoredHeartbeatSessions } from "../store/heartbeat-session-store.js";
import {
  AGENT_IDS,
  AGENT_ROLE,
  listAgentIdsByRole,
  listRuntimeAgentIds,
} from "../agent/agent-identity.js";
import {
  clearDispatchQueue,
  persistDispatchRuntimeState,
  resetAllDispatchStates,
} from "../routing/dispatch/dispatch-runtime-state.js";
import { syncAllRuntimeWorkspaceGuidance } from "../workspace-guidance-writer.js";
import { clearProtocolCommitReconcileState } from "../protocol/protocol-commit-reconcile.js";
import { clearRuntimeDirectEnvelopeStores } from "../routing/runtime-direct-envelope-queue.js";

// 清理面 lstat 化(批④刀2,备忘录143 §七):mailbox 本体先判链。链 → 只摘链本体+
// 恢复真目录(经链 readdir 逐文件删=删穿树内正本);真目录 → 照旧逐文件清内容。
// 真目录期无链,链分支恒不进=行为零变化。目录不存在 → lstat 抛给调用方(沿旧
// readdir ENOENT 路径)。导出供行为锁测试直调。
export async function clearMailboxDirSurface(mailboxDir) {
  const mailboxStat = await lstat(mailboxDir);
  if (mailboxStat.isSymbolicLink()) {
    await unlink(mailboxDir);
    await mkdir(mailboxDir, { recursive: true });
    return { unlinkedSymlink: true, removedFiles: 0 };
  }
  let removedFiles = 0;
  for (const file of await readdir(mailboxDir)) {
    await rm(join(mailboxDir, file), { recursive: true, force: true }).catch(() => {});
    removedFiles++;
  }
  return { unlinkedSymlink: false, removedFiles };
}

function getDefaultResetSessionAgents() {
  const runtimeAgentIds = listRuntimeAgentIds();
  if (runtimeAgentIds.length > 0) {
    return runtimeAgentIds;
  }

  const ids = [
    ...listAgentIdsByRole(AGENT_ROLE.PLANNER),
    ...listAgentIdsByRole(AGENT_ROLE.RESEARCHER),
    ...listAgentIdsByRole(AGENT_ROLE.EXECUTOR),
  ];
  return ids.length > 0
    ? ids
    : [
        AGENT_IDS.CONTROLLER,
        AGENT_IDS.OPERATOR,
        AGENT_IDS.PLANNER,
        "worker",
        "worker2",
      ];
}

export async function resetRuntimeState({
  logger = null,
  onAlert = null,
  resetSessionAgents = getDefaultResetSessionAgents(),
  runtimeApi = null,
} = {}) {
  const sessionCount = getTrackingSessionCount();
  const historyCount = getTaskHistoryCount();
  const chainCount = getDispatchChainSize();
  const contractCacheCount = clearContractStore();
  const executionIncidentCount = clearAllExecutionIncidents();
  const pendingSignalAgentCount = clearAllPendingSignals();
  const systemActionDeliveryTicketCount = await clearSystemActionDeliveryTicketStore();
  clearProtocolCommitReconcileState();
  const runtimeDirectEnvelopeClear = await clearRuntimeDirectEnvelopeStores(resetSessionAgents, { logger });

  clearTrackingStore();
  clearAllTraces();
  clearTaskHistory();
  await clearDispatchChainStore({ persist: false });
  const queueCount = await clearDispatchQueue(logger);
  operationLocks.clear();
  clearRecentOperationGuards();
  // cancelAllPlanDispatches removed: DRAFT lifecycle eliminated.

  qqTypingStopAll();
  clearIgnoredHeartbeatSessions();

  resetAllDispatchStates();
  await persistDispatchRuntimeState(logger);

  try {
    await atomicWriteFile(STATE_FILE, JSON.stringify({
      dispatchChain: {},
      resumableTrackingSessions: {},
      savedAt: Date.now(),
    }, null, 2));
  } catch (error) {
    logger?.warn?.(`[watchdog] RESET: failed to rewrite ${STATE_FILE}: ${error.message}`);
  }

  let sessionFilesCleared = 0;
  let mailboxFilesCleared = 0;
  for (const agentId of resetSessionAgents) {
    const sessionsDir = join(OC, "agents", agentId, "sessions");
    try {
      const files = await readdir(sessionsDir);
      for (const file of files) {
        if (file.endsWith(".jsonl") || file.endsWith(".lock") || file === "sessions.json") {
          await unlink(join(sessionsDir, file)).catch(() => {});
          sessionFilesCleared++;
        }
      }
    } catch (e) { logger?.warn?.(`[reset] session cleanup error for ${agentId}: ${e?.message}`); }

    for (const mailboxName of ["inbox", "outbox"]) {
      const mailboxDir = join(agentWorkspace(agentId), mailboxName);
      try {
        const surface = await clearMailboxDirSurface(mailboxDir);
        if (surface.unlinkedSymlink) {
          logger?.info?.(`[reset] mailbox symlink unlinked (real dir restored): ${agentId}/${mailboxName}`);
        }
        mailboxFilesCleared += surface.removedFiles;
      } catch (e) { logger?.warn?.(`[reset] mailbox cleanup error for ${agentId}/${mailboxName}: ${e?.message}`); }
    }
  }

  // 重置的是**运行时**,不是账本。活跃合约(pending/running)是运行时状态,留着会让
  // 下次 boot 的 recoverOrphanedContracts 把它们当孤儿补关,必须清;
  // 终态合约是那个 run 的记录,该随 run 的 30 天 TTL 走。
  //
  // 2026-08-19 之前这里无条件删全部 —— 与 cleanTestArtifacts 的前缀盲删是同一个病的
  // 两处发作,合起来让 354 个 run 的 contracts/ 全空。修了那处没修这处的话,reset 先跑,
  // 合约照样没了(实测:清理日志显示 kept 0,因为扫描时 reset 已经清空)。
  let contractsRemoved = 0;
  let contractsKept = 0;
  try {
    const entries = await listSharedContractEntries();
    for (const entry of entries) {
      try {
        const snapshot = await readContractSnapshotByPath(entry.path, { preferCache: false }).catch(() => null);
        if (snapshot?.status && isTerminalContractStatus(snapshot.status)) {
          contractsKept++;
          continue;
        }
        await unlink(entry.path).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        contractsRemoved++;
      } catch (e) { logger?.warn?.(`[reset] contract cleanup error: ${e?.message}`); }
    }
  } catch (e) { logger?.warn?.(`[reset] contract list/cleanup error: ${e?.message}`); }

  if (runtimeApi?.config) {
    try {
      await syncAllRuntimeWorkspaceGuidance(runtimeApi.config, logger);
    } catch (error) {
      logger?.warn?.(`[reset] workspace guidance sync error: ${error?.message}`);
    }
  }

  logger?.info?.(
    `[watchdog] RESET: cleared ${sessionCount} sessions, ${historyCount} history, `
    + `${chainCount} chains, ${queueCount} queued, `
    + `${contractsRemoved} active contracts removed (${contractsKept} terminal kept as run records), ${contractCacheCount} cached contracts, ${executionIncidentCount} execution incidents, ${pendingSignalAgentCount} pending-signal agents, ${systemActionDeliveryTicketCount} delivery tickets, ${runtimeDirectEnvelopeClear.files} direct-envelope files, ${sessionFilesCleared} session files, `
    + `${mailboxFilesCleared} mailbox files`,
  );

  clearContractStore();

  const cleared = {
    sessions: sessionCount,
    history: historyCount,
    chains: chainCount,
    queue: queueCount,
    contracts: contractsRemoved,
    contractCache: contractCacheCount,
    executionIncidents: executionIncidentCount,
    pendingSignalAgents: pendingSignalAgentCount,
    systemActionDeliveryTickets: systemActionDeliveryTicketCount,
    runtimeDirectEnvelopeFiles: runtimeDirectEnvelopeClear.files,
    sessionFiles: sessionFilesCleared,
    mailboxes: mailboxFilesCleared,
  };
  onAlert?.({
    type: EVENT_TYPE.SYSTEM_RESET,
    cleared,
    ts: Date.now(),
  });

  return {
    ok: true,
    cleared,
  };
}
