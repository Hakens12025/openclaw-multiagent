// lib/runtime-mailbox-transport.js — shared transport utilities for runtime mailbox

import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace } from "../state.js";
import { evictContractSnapshotByPath } from "../store/contract-store.js";
import { ensureRuntimeDirectEnvelopeInbox } from "../runtime-direct-envelope-queue.js";
import {
  isGatewayAgent,
  listRuntimeAgentIds,
} from "../agent/agent-identity.js";

export function getRouterWorkspace(agentId) {
  if (!isGatewayAgent(agentId)) {
    return agentWorkspace(agentId);
  }
  return null;
}

export async function cleanInbox(agentId, logger) {
  const ws = getRouterWorkspace(agentId);
  if (!ws) {
    return {
      cleaned: false,
      removedFiles: 0,
      promotedDirectEnvelope: null,
    };
  }

  const inboxDir = join(ws, "inbox");
  try {
    const entries = await readdir(inboxDir, { withFileTypes: true });
    let removedFiles = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const entryPath = join(inboxDir, entry.name);
      await unlink(entryPath).catch(() => {});
      evictContractSnapshotByPath(entryPath);
      removedFiles += 1;
    }
    if (removedFiles > 0) {
      logger.info(`[router] cleanInbox(${agentId}): removed ${removedFiles} file(s)`);
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

export async function ensureRouterDirs(logger, workerIds = []) {
  const agentIds = [...new Set([...listRuntimeAgentIds(), ...workerIds])];
  for (const agentId of agentIds) {
    const ws = getRouterWorkspace(agentId);
    if (!ws) continue;
    await mkdir(join(ws, "inbox"), { recursive: true });
    await mkdir(join(ws, "outbox"), { recursive: true });
    logger.info(`[router] ensured inbox/outbox for ${agentId}`);
  }
}
