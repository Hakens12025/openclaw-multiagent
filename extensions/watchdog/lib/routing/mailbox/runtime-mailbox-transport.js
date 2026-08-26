// lib/runtime-mailbox-transport.js — shared transport utilities for runtime mailbox

import { lstat, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace } from "../../state.js";
import { evictContractSnapshotByPath } from "../../store/contract-store.js";
import { ensureRuntimeDirectEnvelopeInbox } from "../runtime-direct-envelope-queue.js";
import {
  isGatewayAgent,
  listRuntimeAgentIds,
} from "../../agent/agent-identity.js";

export function getMailboxWorkspace(agentId) {
  if (!isGatewayAgent(agentId)) {
    return agentWorkspace(agentId);
  }
  return null;
}

function normalizeContractId(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

async function readInboxContractId(inboxDir) {
  try {
    const raw = await readFile(join(inboxDir, "contract.json"), "utf8");
    const payload = JSON.parse(raw);
    return typeof payload?.id === "string" && payload.id.trim() ? payload.id.trim() : null;
  } catch {
    return null;
  }
}

export async function cleanInbox(agentId, logger, { ownerContractId = null } = {}) {
  const ws = getMailboxWorkspace(agentId);
  if (!ws) {
    return {
      cleaned: false,
      removedFiles: 0,
      promotedDirectEnvelope: null,
    };
  }

  const inboxDir = join(ws, "inbox");
  // 本体链守卫(审查 2026-08-16):inbox 本体为链时 readdir 会跟链进树逐文件删穿正本,
  // 先摘链恢复真目录再清。
  await ensureRealMailboxDir(inboxDir, logger, agentId);
  try {
    const normalizedOwnerContractId = normalizeContractId(ownerContractId);
    if (normalizedOwnerContractId) {
      const activeInboxContractId = await readInboxContractId(inboxDir);
      if (
        activeInboxContractId
        && normalizeContractId(activeInboxContractId) !== normalizedOwnerContractId
      ) {
        logger.info(
          `[mailbox] cleanInbox(${agentId}): preserved inbox for ${activeInboxContractId} `
          + `(cleanup owner=${ownerContractId})`,
        );
        return {
          cleaned: false,
          removedFiles: 0,
          preserved: true,
          preserveReason: "different_contract",
          promotedDirectEnvelope: null,
        };
      }
    }

    const entries = await readdir(inboxDir, { withFileTypes: true });
    let removedFiles = 0;
    for (const entry of entries) {
      // symlink 条目 isFile/isDirectory 双 false:只摘链本体(内容的家在树),
      // 不 unlink 会静默漏链(批④刀2)。
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const entryPath = join(inboxDir, entry.name);
      await unlink(entryPath).catch(() => {});
      evictContractSnapshotByPath(entryPath);
      removedFiles += 1;
    }
    if (removedFiles > 0) {
      logger.info(`[mailbox] cleanInbox(${agentId}): removed ${removedFiles} file(s)`);
    }
    const readyState = await ensureRuntimeDirectEnvelopeInbox({ inboxDir, agentId, logger });
    return {
      cleaned: true,
      removedFiles,
      promotedDirectEnvelope: readyState?.promoted === true ? (readyState.contract || null) : null,
    };
  } catch {
    // inbox dir doesn't exist yet — fine
    return {
      cleaned: false,
      removedFiles: 0,
      promotedDirectEnvelope: null,
    };
  }
}

// 悬链自愈(批④刀2,备忘录143 §六,GC 崩溃窗兜底):mailbox 本体若是 symlink 且
// 目标失踪(树内目标已删、链本体未摘),recursive mkdir 会拒建 —— lstat 判悬链后
// 摘链本体并恢复真目录。目标健在的链不动;真目录期无链,恒 no-op。
export async function healDanglingMailboxDir(dirPath, logger, agentId = null) {
  try {
    const linkStat = await lstat(dirPath);
    if (!linkStat.isSymbolicLink()) return false;
    try {
      await stat(dirPath); // 经链 stat:目标健在 → 链不动
      return false;
    } catch { /* 目标失踪 → 悬链 */ }
    await unlink(dirPath);
    await mkdir(dirPath, { recursive: true });
    logger?.warn?.(`[mailbox] dangling symlink healed (real dir restored): ${dirPath}${agentId ? ` (${agentId})` : ""}`);
    return true;
  } catch {
    return false; // 路径不存在 → 交给调用方 mkdir 主流程
  }
}

// inbox 本体的设计态恒为真目录(批④只把 outbox 本体与 inbox/upstream/* 条目做成链;
// inbox/contract.json 是 atomicWriteFile/rename 目标,必须真文件真目录)。本体出现
// dir-level 链 = 非设计态:readdir 会跟链进树、unlink 会经链删正本(审查 2026-08-16
// 实跑确认 cleanInbox 删穿树内 inbox-{cid} 快照)——一律摘链本体恢复真目录。
export async function ensureRealMailboxDir(dirPath, logger, agentId = null) {
  try {
    const linkStat = await lstat(dirPath);
    if (linkStat.isSymbolicLink()) {
      await unlink(dirPath);
      logger?.warn?.(`[mailbox] unexpected dir-level symlink detached (real dir restored): ${dirPath}${agentId ? ` (${agentId})` : ""}`);
    }
  } catch { /* 不存在 → 直接建 */ }
  await mkdir(dirPath, { recursive: true });
}

export async function ensureMailboxDirs(logger, workerIds = []) {
  const agentIds = [...new Set([...listRuntimeAgentIds(), ...workerIds])];
  for (const agentId of agentIds) {
    const ws = getMailboxWorkspace(agentId);
    if (!ws) continue;
    await ensureRealMailboxDir(join(ws, "inbox"), logger, agentId);
    await healDanglingMailboxDir(join(ws, "outbox"), logger, agentId);
    await mkdir(join(ws, "inbox"), { recursive: true });
    await mkdir(join(ws, "outbox"), { recursive: true });
    logger.info(`[mailbox] ensured inbox/outbox for ${agentId}`);
  }
}
