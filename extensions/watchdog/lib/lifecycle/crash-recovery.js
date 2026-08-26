import { lstat, mkdir, readdir, readFile, readlink, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { agentWorkspace, atomicWriteFile } from "../state.js";
import { listRuntimeAgentIds } from "../agent/agent-identity.js";
import { clearContractStore, listTreeContractPaths } from "../store/contract-store.js";
import { rebuildContractIndex, resolveThreadsRoot } from "../archive/thread-tree-store.js";
import { deriveRunOpenContracts, runHasEventForContract } from "../archive/run-event-recorder.js";
import { listPendingDeliveryTickets } from "../routing/delivery/delivery-ticket-store.js";
import { wireClosed } from "../archive/run-event-wiring.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { readContractSnapshotByPath, updateContractStatus, mutateContractSnapshot } from "../contract/contracts.js";
import { qqNotify, qqTypingStop, getQQTarget } from "../transport/channel-notify.js";
import { recordErrorPattern } from "../error-ledger.js";
import { runtimeWakeAgentDetailed } from "../transport/runtime-wake-transport.js";
import {
  CONTRACT_STATUS,
  TRACKING_STATUS,
  isActiveContractStatus,
} from "../core/runtime-status.js";
import { normalizeTerminalOutcome } from "../contract/terminal-outcome.js";
import { mergeRuntimeDiagnostics } from "./agent-end/contract-refresh.js";

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
    hint: "Use targeted grep/glob searches, keep each operation small, and complete the key output first.",
  },
  {
    test: /timeout|timed?\s*out/i,
    hint: "Complete the key output first, then add supporting detail if time remains.",
  },
  {
    test: /rate.*(limit|exceeded)|429|too many requests/i,
    hint: "Batch external queries and prefer local files or tools for the next step.",
  },
  {
    test: /permission|denied|forbidden|403/i,
    hint: "Use paths inside the allowed workspace and continue with accessible resources.",
  },
  {
    test: /ENOENT|not found|no such file/i,
    hint: "Confirm the target path with glob before the next read or write.",
  },
  {
    test: /ENOSPC|disk.*full|no space/i,
    hint: "Free temporary space, then continue with the current contract.",
  },
];

function classifyError(reason) {
  const text = String(reason);
  for (const { test, hint } of ERROR_HINTS) {
    if (test.test(text)) return hint;
  }
  return "Continue with the current contract using the smallest reliable next step.";
}

function buildRetryHint({ error, trackingState, retryCount, maxRetryCount }) {
  const reason = String(error || "unknown");
  const guidance = classifyError(reason);
  const toolCalls = trackingState?.toolCalls || [];
  const task = trackingState?.contract?.task?.slice(0, 100) || "";

  const lines = [
    `## Next retry (${retryCount}/${maxRetryCount})`,
    "",
    `**Last error**: ${reason.slice(0, 200)}`,
    "",
    guidance,
  ];

  if (task) {
    lines.push("", `**Task**: ${task}`);
  }

  if (toolCalls.length > 0) {
    const recent = toolCalls.slice(-8);
    lines.push("", "**Recent tool calls**:");
    for (const tc of recent) {
      lines.push(`- ${tc.label || tc.tool}`);
    }
  }

  return lines.join("\n");
}

function buildHeartbeatReason({ error, retryCount, maxRetryCount, guidance }) {
  void error;
  void guidance;
  return `Retry scheduled (${retryCount}/${maxRetryCount}). Read inbox/retry-hint.md and continue the current contract.`;
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

// Pending retry timers keyed by sessionKey — so a re-scheduled retry clears its predecessor (no timer
// accumulation) and the fire-time body can be guarded. unref'd so they never hold the process at shutdown.
const pendingRetryTimers = new Map();

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
    // 审查③:ABANDONED 也是终态——事件账(真值)必须同步落 closed,否则 run 永不关账。
    void wireClosed({
      contract: contractSnapshot || trackingState?.contract,
      terminalStatus: CONTRACT_STATUS.ABANDONED,
      reason: String(reason).slice(0, 200),
      logger,
    });
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
  // 按合约状态判据，不按角色（qqTypingStop 对无 typing 的合约是安全 no-op）。
  if (trackingState?.contract?.id) {
    qqTypingStop(trackingState?.contract?.id);
  }

  const delay = retryDelays[Math.min(retryCount, retryDelays.length - 1)];
  // Clear any prior pending retry for this session (avoid timer accumulation on repeated recovery).
  const priorTimer = pendingRetryTimers.get(sessionKey);
  if (priorTimer) clearTimeout(priorTimer);
  const retryTimer = setTimeout(async () => {
    pendingRetryTimers.delete(sessionKey);
    try {
      // Re-validate the contract is STILL active before firing — a cancelled/superseded/terminal
      // contract must NOT get a phantom retry wake (single source of truth = contract status).
      const snapshot = await loadContractSnapshot(contractPath);
      if (!snapshot || !isActiveContractStatus(snapshot.status)) {
        logger.info(`[watchdog] retry skipped: contract no longer active (${snapshot?.status ?? "missing"}) for ${sessionKey}`);
        return;
      }
      // Write hint file to inbox AFTER agent_end cleanup has finished
      await writeRetryHintToInbox(agentId, hint, logger);
      await runtimeWakeAgentDetailed(agentId, heartbeatReason, api, logger, { sessionKey });
    } catch (heartbeatError) {
      logger.error(`[watchdog] requestHeartbeatNow failed: ${heartbeatError.message}`);
    }
  }, delay);
  retryTimer.unref?.();
  pendingRetryTimers.set(sessionKey, retryTimer);

  return {
    status: "retry_scheduled",
    retryCount: nextRetryCount,
    delay,
    reason,
    hint: guidance,
  };
}

// ── Startup orphan recovery (树店扫描) ──────────────────────────────────────
// boot 补关(备忘录142 §十二.2):树内正本 running → failed,并落 closed 事件
// (wireClosed 内含 GAP-02 run 关账判定)。树店是唯一扫描面。

export async function recoverOrphanedContracts({ api, logger }) {
  try {
    const contractPaths = await listTreeContractPaths();
    for (const contractPath of contractPaths) {
      try {
        const raw = await readFile(contractPath, "utf8");
        const c = JSON.parse(raw);

        // Orphan running → failed (stale from previous gateway run)
        if (c.status === "running") {
          // 事件门(审查④):谱系在账 + 无 turn_started/claimed = 排队未开跑的信封
          // (DIRECT 生而 RUNNING+队列跨重启存活),不是孤儿——留给队列复活,不误杀、
          // 不落假 closed、不发假失败通知。查询失败按真孤儿处理(fail-safe 保旧行为)。
          if (c.lineage?.threadId && c.lineage?.runId) {
            let everStarted = true;
            try {
              everStarted = await runHasEventForContract(c.lineage, c.id, ["turn_started", "claimed"]);
            } catch { everStarted = true; }
            if (!everStarted) {
              logger?.info?.(`[crash-recovery] queued envelope left intact (never started): ${c.id}`);
              continue;
            }
          }
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
          void wireClosed({
            contract: mutation.contract || c,
            terminalStatus: CONTRACT_STATUS.FAILED,
            reason: "gateway_restart",
            logger,
          });
          try {
            const target = getQQTarget(c);
            if (target) qqNotify(target, `❌ 任务因系统重启中断\n${(c.task || '').slice(0, 50)}\n请重新发送`);
          } catch (e) { logger?.warn?.(`[crash-recovery] orphan QQ notify error for ${contractPath}: ${e?.message}`); }
        }
      } catch (e) { logger?.warn?.(`[crash-recovery] orphan recovery error for ${contractPath}: ${e?.message}`); }
    }
  } catch (e) { logger?.warn?.(`[crash-recovery] orphan recovery scan failed: ${e?.message}`); }
}

// ── Run retention GC (GAP-04,备忘录142 §十二.4) ────────────────────────────
// thread 生长上限:每 thread 保留最近 MAX_RUNS_PER_THREAD 个 run;超额且闲置超过
// RUN_RETENTION_MS 的 run 目录整删(正本终态后原地即档案,GC 边界=run 目录)。
// 删除后索引压实(rebuildContractIndex 全树重写)+ 合约内存缓存清空。

const MAX_RUNS_PER_THREAD = 20;
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function listDirectoryFiles(parent) {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listDirectoryNames(parent) {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

// GC 摘链(批④刀2,备忘录143 §六):run/thread 目录整删前,把各 agent workspace 的
// {outbox,inbox,inbox/upstream/* 一层} 中指向待删目录内部的 symlink 摘掉并恢复真目录。
// 树链规范:树链一律绝对路径目标;readlink 后仍按链所在目录 resolve 一次,防御相对目标。
// 真目录期无链,全程 no-op。
async function unlinkWorkspaceLinksInto(targetRoot, logger) {
  const rootExact = resolve(targetRoot);
  const rootPrefix = rootExact + sep;
  const removed = [];
  for (const agentId of listRuntimeAgentIds()) {
    const ws = agentWorkspace(agentId);
    const candidates = [join(ws, "outbox"), join(ws, "inbox")];
    try {
      const upstreamDir = join(ws, "inbox", "upstream");
      for (const name of await readdir(upstreamDir)) {
        candidates.push(join(upstreamDir, name));
      }
    } catch { /* 无 upstream/ 是常态 */ }
    for (const candidate of candidates) {
      try {
        const linkStat = await lstat(candidate);
        if (!linkStat.isSymbolicLink()) continue;
        const target = resolve(dirname(candidate), await readlink(candidate));
        if (target !== rootExact && !target.startsWith(rootPrefix)) continue; // 目标在待删目录外的链不动
        await unlink(candidate);
        await mkdir(candidate, { recursive: true });
        removed.push(candidate);
      } catch { /* 路径不存在/并发消失 → 无链可摘 */ }
    }
  }
  if (removed.length > 0) {
    logger?.info?.(`[cleanup] unlinked ${removed.length} workspace symlink(s) into ${rootExact} (real dirs restored): ${removed.join(", ")}`);
  }
  return removed.length;
}

export async function pruneTerminalContracts({ logger, now = Date.now() } = {}) {
  try {
    const threadsRoot = resolveThreadsRoot();
    let prunedRuns = 0;
    // GC 门原料(审查②):未决投递票据引用的合约所在 run 不可删。
    let pendingTicketContractIds = new Set();
    try {
      pendingTicketContractIds = new Set(
        (await listPendingDeliveryTickets()).map((t) => t?.contractId).filter(Boolean),
      );
    } catch { /* 票据店不可读 → 空集,由关账门兜底 */ }
    for (const threadId of await listDirectoryNames(threadsRoot)) {
      const runsDir = join(threadsRoot, threadId, "runs");
      const runEntries = [];
      for (const runId of await listDirectoryNames(runsDir)) {
        const runDir = join(runsDir, runId);
        try {
          const dirStat = await stat(runDir);
          runEntries.push({ runId, runDir, mtime: dirStat.mtimeMs });
        } catch (e) { logger?.warn?.(`[cleanup] run stat failed for ${runDir}: ${e?.message}`); }
      }
      if (runEntries.length <= MAX_RUNS_PER_THREAD) continue;

      // 活跃度排序(dir mtime 近似;§九:ts 只做展示/GC 近似,永不进事件排序)
      runEntries.sort((a, b) => b.mtime - a.mtime);
      for (const entry of runEntries.slice(MAX_RUNS_PER_THREAD)) {
        if (now - entry.mtime < RUN_RETENTION_MS) continue; // 保留窗内的超额 run 暂留
        // 关账门(审查②,旧版 TERMINAL_STATUSES 门的树店形态):事件账仍有 open 合约
        // 的 run 绝不整删——mtime 是近似活跃度,不是终态证明(APFS 父目录 mtime
        // 感知不到 contracts/ 子目录内的写)。查询失败按未关处理(fail-safe 不删)。
        try {
          const openContracts = await deriveRunOpenContracts({ threadId, runId: entry.runId });
          if (openContracts.length > 0) {
            logger?.info?.(`[cleanup] run kept (ledger open contracts: ${openContracts.length}): ${threadId}/${entry.runId}`);
            continue;
          }
        } catch { continue; }
        // 票据门:run 内任何合约仍被未决投递票据引用 → 留
        if (pendingTicketContractIds.size > 0) {
          const runContractIds = (await listDirectoryFiles(join(entry.runDir, "contracts")))
            .map((name) => name.replace(/\.json$/, ""));
          if (runContractIds.some((id) => pendingTicketContractIds.has(id))) {
            logger?.info?.(`[cleanup] run kept (pending delivery ticket): ${threadId}/${entry.runId}`);
            continue;
          }
        }
        try {
          await unlinkWorkspaceLinksInto(entry.runDir, logger); // rm 前摘链:经链可见面不得留悬链
          await rm(entry.runDir, { recursive: true, force: true });
          prunedRuns++;
          logger?.info?.(`[cleanup] pruned expired run: ${threadId}/${entry.runId}`);
        } catch (e) { logger?.warn?.(`[cleanup] failed to delete run ${threadId}/${entry.runId}: ${e?.message}`); }
      }

      // runs 清空的 thread 整目录退场
      if ((await listDirectoryNames(runsDir)).length === 0) {
        try {
          const threadDir = join(threadsRoot, threadId);
          await unlinkWorkspaceLinksInto(threadDir, logger); // thread 整删同理:先摘链
          await rm(threadDir, { recursive: true, force: true });
        } catch (e) { logger?.warn?.(`[cleanup] failed to delete empty thread ${threadId}: ${e?.message}`); }
      }
    }

    if (prunedRuns > 0) {
      // 索引压实:全树扫描原子重写,被删 run 的 id 行随之蒸发;内存缓存整清,
      // 首读经 hydrate 从树上重建。
      await rebuildContractIndex({ logger });
      clearContractStore();
      logger?.info?.(`[cleanup] pruned ${prunedRuns} expired run(s) (keep ${MAX_RUNS_PER_THREAD}/thread or ${Math.round(RUN_RETENTION_MS / 86400000)}d)`);
    }
    return { pruned: prunedRuns };
  } catch (e) {
    logger?.warn?.(`[cleanup] pruneTerminalContracts failed: ${e?.message}`);
    return { pruned: 0, error: e?.message };
  }
}
