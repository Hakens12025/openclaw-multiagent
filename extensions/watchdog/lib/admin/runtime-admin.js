import { readdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import { EVENT_TYPE } from "../core/event-types.js";
import {
  OC,
  QUEUE_STATE_FILE,
  STATE_FILE,
  agentWorkspace,
  atomicWriteFile,
  clearRecentOperationGuards,
  operationLocks,
} from "../state.js";
import { qqTypingStopAll } from "../qq.js";
import { clearContractStore, listSharedContractEntries } from "../store/contract-store.js";
import {
  clearDispatchChainStore, getDispatchChainSize,
} from "../store/contract-flow-store.js";
import { clearTrackingStore, getTrackingSessionCount } from "../store/tracker-store.js";
import { clearAllTraces } from "../store/execution-trace-store.js";
import { clearSystemActionDeliveryTicketStore } from "../routing/delivery-system-action-ticket.js";
// cancelAllPlanDispatches eliminated: DRAFT lifecycle removed.
import { clearLoopSessionState } from "../loop/loop-session-store.js";
import { clearTaskHistory, getTaskHistoryCount } from "../store/task-history-store.js";
import { clearIgnoredHeartbeatSessions } from "../store/heartbeat-session-store.js";
import {
  AGENT_IDS,
  AGENT_ROLE,
  listAgentIdsByRole,
  listRuntimeAgentIds,
} from "../agent/agent-identity.js";
import { concludeLoopRound, getActiveLoopRuntime } from "../loop/loop-round-runtime.js";
import {
  clearDispatchQueue,
  persistDispatchRuntimeState,
  resetAllDispatchStates,
} from "../routing/dispatch-runtime-state.js";

function getDefaultResetSessionAgents() {
  const runtimeAgentIds = listRuntimeAgentIds();
  if (runtimeAgentIds.length > 0) {
    return runtimeAgentIds;
  }

  const ids = [
    ...listAgentIdsByRole(AGENT_ROLE.PLANNER),
    ...listAgentIdsByRole(AGENT_ROLE.RESEARCHER),
    ...listAgentIdsByRole(AGENT_ROLE.REVIEWER),
    ...listAgentIdsByRole(AGENT_ROLE.EXECUTOR),
  ];
  return ids.length > 0
    ? ids
    : [
        AGENT_IDS.CONTROLLER,
        AGENT_IDS.QQ_BRIDGE,
        AGENT_IDS.PLANNER,
        "worker",
        "worker2",
      ];
}

export async function resetRuntimeState({
  logger = null,
  onAlert = null,
  resetSessionAgents = getDefaultResetSessionAgents(),
} = {}) {
  const sessionCount = getTrackingSessionCount();
  const historyCount = getTaskHistoryCount();
  const chainCount = getDispatchChainSize();
  const contractCacheCount = clearContractStore();
  const systemActionDeliveryTicketCount = await clearSystemActionDeliveryTicketStore();
  await clearLoopSessionState();

  clearTrackingStore();
  clearAllTraces();
  clearTaskHistory();
  await clearDispatchChainStore({ persist: false });
  const queueCount = clearDispatchQueue();
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

  try {
    await atomicWriteFile(QUEUE_STATE_FILE, JSON.stringify({
      targets: {},
      savedAt: Date.now(),
    }, null, 2));
  } catch (error) {
    logger?.warn?.(`[watchdog] RESET: failed to rewrite ${QUEUE_STATE_FILE}: ${error.message}`);
  }

  try {
    const prevLoopRuntime = await getActiveLoopRuntime();
    if (prevLoopRuntime && prevLoopRuntime.currentStage && prevLoopRuntime.currentStage !== "concluded") {
      await concludeLoopRound("watchdog_reset", logger);
      logger?.info?.("[watchdog] RESET: loop concluded");
    }
  } catch (error) {
    logger?.warn?.(`[watchdog] RESET: failed to reset loop runtime: ${error.message}`);
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
        const files = await readdir(mailboxDir);
        for (const file of files) {
          await rm(join(mailboxDir, file), { recursive: true, force: true }).catch(() => {});
          mailboxFilesCleared++;
        }
      } catch (e) { logger?.warn?.(`[reset] mailbox cleanup error for ${agentId}/${mailboxName}: ${e?.message}`); }
    }
  }

  let contractsRemoved = 0;
  try {
    const entries = await listSharedContractEntries();
    for (const entry of entries) {
      try {
        await unlink(entry.path).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        contractsRemoved++;
      } catch (e) { logger?.warn?.(`[reset] contract cleanup error: ${e?.message}`); }
    }
  } catch (e) { logger?.warn?.(`[reset] contract list/cleanup error: ${e?.message}`); }

  logger?.info?.(
    `[watchdog] RESET: cleared ${sessionCount} sessions, ${historyCount} history, `
    + `${chainCount} chains, ${queueCount} queued, `
    + `${contractsRemoved} contract files removed, ${contractCacheCount} cached contracts, ${systemActionDeliveryTicketCount} delivery tickets, ${sessionFilesCleared} session files, `
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
    systemActionDeliveryTickets: systemActionDeliveryTicketCount,
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
