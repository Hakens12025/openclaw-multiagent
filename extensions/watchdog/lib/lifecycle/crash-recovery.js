import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace, atomicWriteFile, CONTRACTS_DIR, isWorker } from "../state.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { readContractSnapshotByPath, updateContractStatus, mutateContractSnapshot } from "../contracts.js";
import { qqNotify, qqTypingStop, getQQTarget } from "../qq.js";
import { recordErrorPattern } from "../error-ledger.js";
import { runtimeWakeAgentDetailed } from "../transport/runtime-wake-transport.js";
import {
  CONTRACT_STATUS,
  TRACKING_STATUS,
  isActiveContractStatus,
} from "../core/runtime-status.js";
import { normalizeTerminalOutcome } from "../terminal-outcome.js";
import { mergeRuntimeDiagnostics } from "./agent-end-contract-refresh.js";

async function loadContractSnapshot(contractPath) {
  return readContractSnapshotByPath(contractPath, { preferCache: true });
}

function buildRecoveryTerminalOutcome(status, reason, {
  source = "runtime_crash",
} = {}) {
  return normalizeTerminalOutcome({
    status,
    reason,
    source,
  }, {
    terminalStatus: status,
  });
}

function resolveRetryActiveStatus(contractSnapshot, trackingState) {
  const contractStatus = contractSnapshot?.status;
  if (isActiveContractStatus(contractStatus)) {
    return contractStatus;
  }
  const trackingStatus = trackingState?.contract?.status;
  if (isActiveContractStatus(trackingStatus)) {
    return trackingStatus;
  }
  return CONTRACT_STATUS.RUNNING;
}

function buildRecoveryRuntimeDiagnostics(contractSnapshot, trackingState, contractReadDiagnostic) {
  if (!contractReadDiagnostic) return null;
  return mergeRuntimeDiagnostics(
    contractSnapshot?.runtimeDiagnostics || trackingState?.contract?.runtimeDiagnostics,
    {
      contractRead: contractReadDiagnostic,
    },
  );
}

// ── Error classification → specific retry guidance ──────────────────────────

const ERROR_HINTS = [
  {
    test: /context.*(length|limit|exceeded|overflow)|token.*(limit|exceeded)/i,
    hint: "上次因上下文窗口溢出中断。请简化方法：用 grep/glob 精确搜索代替全文阅读，减少单次操作范围，分步完成最关键的输出。",
  },
  {
    test: /timeout|timed?\s*out/i,
    hint: "上次因执行超时中断。请先完成最关键的输出，避免长时间搜索或复杂的多步操作。",
  },
  {
    test: /rate.*(limit|exceeded)|429|too many requests/i,
    hint: "上次因 API 限流中断。请减少 web_search/web_fetch 调用频率，合并查询，优先使用本地工具。",
  },
  {
    test: /permission|denied|forbidden|403/i,
    hint: "上次因权限错误中断。请检查文件路径是否在允许的工作目录内，避免访问受限资源。",
  },
  {
    test: /ENOENT|not found|no such file/i,
    hint: "上次因文件不存在中断。请先用 glob 确认目标路径，再进行读写操作。",
  },
  {
    test: /ENOSPC|disk.*full|no space/i,
    hint: "上次因磁盘空间不足中断。请清理不必要的临时文件后重试。",
  },
];

function classifyError(reason) {
  const text = String(reason);
  for (const { test, hint } of ERROR_HINTS) {
    if (test.test(text)) return hint;
  }
  return "上次执行中断，原因不明确。请检查上次的方法是否可行，考虑简化或换一种方式完成任务。";
}

function buildRetryHint({ error, trackingState, retryCount, maxRetryCount }) {
  const reason = String(error || "unknown");
  const guidance = classifyError(reason);
  const toolCalls = trackingState?.toolCalls || [];
  const task = trackingState?.contract?.task?.slice(0, 100) || "";

  const lines = [
    `## 重试提示 (${retryCount}/${maxRetryCount})`,
    "",
    `**错误**: ${reason.slice(0, 200)}`,
    "",
    guidance,
  ];

  if (task) {
    lines.push("", `**任务**: ${task}`);
  }

  if (toolCalls.length > 0) {
    const recent = toolCalls.slice(-8);
    lines.push("", "**上次执行的工具调用**:");
    for (const tc of recent) {
      lines.push(`- ${tc.label || tc.tool}`);
    }
  }

  return lines.join("\n");
}

function buildHeartbeatReason({ error, retryCount, maxRetryCount, guidance }) {
  const reason = String(error || "unknown").slice(0, 150);
  return `重试 (${retryCount}/${maxRetryCount}): ${reason}\n${guidance}`;
}

async function writeRetryHintToInbox(agentId, hint, logger) {
  try {
    const inboxDir = join(agentWorkspace(agentId), "inbox");
    await mkdir(inboxDir, { recursive: true });
    await atomicWriteFile(join(inboxDir, "retry-hint.md"), hint);
  } catch (e) {
    logger.warn(`[watchdog] failed to write retry hint for ${agentId}: ${e.message}`);
  }
}

// ── Main recovery handler ───────────────────────────────────────────────────

export async function handleCrashRecovery({
  agentId,
  sessionKey,
  trackingState,
  error,
  contractReadDiagnostic = null,
  api,
  logger,
  maxRetryCount,
  retryDelays,
}) {
  const reason = error ?? "unknown";
  const contractPath = trackingState?.contract?.path || null;
  const contractSnapshot = await loadContractSnapshot(contractPath);
  const retryCount = Number(contractSnapshot?.retryCount) || 0;
  const runtimeDiagnostics = buildRecoveryRuntimeDiagnostics(
    contractSnapshot,
    trackingState,
    contractReadDiagnostic,
  );
  const qqTarget = getQQTarget(contractSnapshot || {});
  const taskLabel = trackingState?.contract?.task?.slice(0, 50) || agentId;

  logger.warn(`[watchdog] FAILURE detected: ${sessionKey} — ${reason}`);
  broadcast("alert", { type: EVENT_TYPE.ERROR, agentId, sessionKey, reason, ts: Date.now() });

  if (retryCount >= maxRetryCount) {
    logger.warn(`[watchdog] MAX RETRIES REACHED (${retryCount}/${maxRetryCount})`);
    const terminalOutcome = buildRecoveryTerminalOutcome(CONTRACT_STATUS.ABANDONED, reason, {
      source: "runtime_crash",
    });
    if (contractPath) {
      await updateContractStatus(contractPath, CONTRACT_STATUS.ABANDONED, logger, {
        retryCount,
        terminalOutcome,
        ...(runtimeDiagnostics ? { runtimeDiagnostics } : {}),
      });
    }
    if (trackingState?.contract) {
      trackingState.status = CONTRACT_STATUS.ABANDONED;
      trackingState.contract.status = CONTRACT_STATUS.ABANDONED;
      trackingState.contract.terminalOutcome = terminalOutcome;
      if (runtimeDiagnostics) {
        trackingState.contract.runtimeDiagnostics = runtimeDiagnostics;
      }
    }
    qqTypingStop(trackingState?.contract?.id);
    qqNotify(qqTarget, `❌ 任务处理失败（重试 ${retryCount} 次）\n${taskLabel}\n请重试或简化你的问题`);
    return {
      status: CONTRACT_STATUS.ABANDONED,
      retryCount,
      reason,
    };
  }

  const nextRetryCount = retryCount + 1;
  const retryActiveStatus = resolveRetryActiveStatus(contractSnapshot, trackingState);
  if (contractPath) {
    await updateContractStatus(contractPath, retryActiveStatus, logger, {
      retryCount: nextRetryCount,
      terminalOutcome: null,
      ...(runtimeDiagnostics ? { runtimeDiagnostics } : {}),
    });
  }
  if (trackingState) {
    trackingState.status = TRACKING_STATUS.WAITING_RETRY;
    trackingState.lastLabel = `等待重试 (${nextRetryCount}/${maxRetryCount})`;
    trackingState.estimatedPhase = "等待重试";
    if (trackingState.contract) {
      trackingState.contract.status = retryActiveStatus;
      trackingState.contract.retryCount = nextRetryCount;
      trackingState.contract.terminalOutcome = null;
      if (runtimeDiagnostics) {
        trackingState.contract.runtimeDiagnostics = runtimeDiagnostics;
      }
    }
  }
  qqNotify(qqTarget, `⚠️ 任务处理中断，正在重试 (${nextRetryCount}/${maxRetryCount})\n${taskLabel}`);

  // Build hindsight hint from error context + tool call history
  const guidance = classifyError(reason);
  const hint = buildRetryHint({
    error: reason,
    trackingState,
    retryCount: nextRetryCount,
    maxRetryCount,
  });
  const heartbeatReason = buildHeartbeatReason({
    error: reason,
    retryCount: nextRetryCount,
    maxRetryCount,
    guidance,
  });

  // Record to global error ledger → regenerate shared skill for all agents
  try {
    await recordErrorPattern({ error: reason, agentId, trackingState, logger });
  } catch (e) {
    logger.warn(`[watchdog] error ledger record failed: ${e.message}`);
  }

  // Retry-scheduled sessions must keep the agent reservation. Stop QQ typing only.
  if (isWorker(agentId)) {
    qqTypingStop(trackingState?.contract?.id);
  }

  const delay = retryDelays[Math.min(retryCount, retryDelays.length - 1)];
  setTimeout(async () => {
    try {
      // Write hint file to inbox AFTER agent_end cleanup has finished
      await writeRetryHintToInbox(agentId, hint, logger);
      await runtimeWakeAgentDetailed(agentId, heartbeatReason, api, logger, { sessionKey });
    } catch (heartbeatError) {
      logger.error(`[watchdog] requestHeartbeatNow failed: ${heartbeatError.message}`);
    }
  }, delay);

  return {
    status: "retry_scheduled",
    retryCount: nextRetryCount,
    delay,
    reason,
    hint: guidance,
  };
}

// ── Startup orphan recovery ─────────────────────────────────────────────────

export async function recoverOrphanedContracts({ api, logger }) {
  try {
    const contractFiles = await readdir(CONTRACTS_DIR);
    for (const f of contractFiles.filter(f => f.endsWith(".json"))) {
      try {
        const contractPath = join(CONTRACTS_DIR, f);
        const raw = await readFile(contractPath, "utf8");
        const c = JSON.parse(raw);

        // Orphan running → failed (stale from previous gateway run)
        if (c.status === "running") {
          const mutation = await mutateContractSnapshot(contractPath, logger, (contract) => {
            if (contract.status !== "running") return false;
            contract.status = CONTRACT_STATUS.FAILED;
            contract.failReason = "gateway_restart";
            contract.terminalOutcome = buildRecoveryTerminalOutcome(CONTRACT_STATUS.FAILED, "gateway_restart", {
              source: "runtime_recovery",
            });
            return { cleaned: true };
          }, { touchUpdatedAt: true });
          if (!mutation?.result?.cleaned) continue;
          logger.warn(`[crash-recovery] orphan running contract cleaned: ${c.id} → failed`);
          try {
            const target = getQQTarget(c);
            if (target) qqNotify(target, `❌ 任务因系统重启中断\n${(c.task || '').slice(0, 50)}\n请重新发送`);
          } catch (e) { logger?.warn?.(`[crash-recovery] orphan QQ notify error for ${f}: ${e?.message}`); }
        }
      } catch (e) { logger?.warn?.(`[crash-recovery] orphan recovery error for ${f}: ${e?.message}`); }
    }
  } catch (e) { logger?.warn?.(`[crash-recovery] orphan recovery scan failed: ${e?.message}`); }
}

// ── Contract history retention ──────────────────────────────────────────────
// Keep only the N most recent terminal contracts. Delete older ones + their session files.

const MAX_TERMINAL_CONTRACTS = 50;
const TERMINAL_STATUSES = new Set(["completed", "failed", "abandoned", "cancelled", "awaiting_input"]);

export async function pruneTerminalContracts({ logger } = {}) {
  try {
    const files = (await readdir(CONTRACTS_DIR)).filter(f => f.endsWith(".json"));
    const entries = [];
    for (const f of files) {
      const contractPath = join(CONTRACTS_DIR, f);
      try {
        const raw = await readFile(contractPath, "utf8");
        const c = JSON.parse(raw);
        if (!TERMINAL_STATUSES.has(c.status)) continue;
        const fileStat = await stat(contractPath);
        entries.push({ path: contractPath, id: c.id, mtime: fileStat.mtimeMs });
      } catch (e) { logger?.warn?.(`[cleanup] failed to read contract ${f}: ${e?.message}`); }
    }

    if (entries.length <= MAX_TERMINAL_CONTRACTS) return { pruned: 0 };

    // Sort newest first, keep the first 50
    entries.sort((a, b) => b.mtime - a.mtime);
    const toDelete = entries.slice(MAX_TERMINAL_CONTRACTS);

    let pruned = 0;
    for (const entry of toDelete) {
      try {
        await unlink(entry.path);
        pruned++;
        logger?.info?.(`[cleanup] pruned terminal contract: ${entry.id}`);
      } catch (e) { logger?.warn?.(`[cleanup] failed to delete contract ${entry.id}: ${e?.message}`); }
    }

    logger?.info?.(`[cleanup] pruned ${pruned} terminal contracts (kept ${MAX_TERMINAL_CONTRACTS})`);
    return { pruned };
  } catch (e) {
    logger?.warn?.(`[cleanup] pruneTerminalContracts failed: ${e?.message}`);
    return { pruned: 0, error: e?.message };
  }
}
