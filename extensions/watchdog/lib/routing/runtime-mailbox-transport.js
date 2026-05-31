// lib/runtime-mailbox-transport.js — shared transport utilities for runtime mailbox

import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { agentWorkspace } from "../state.js";
import { evictContractSnapshotByPath } from "../store/contract-store.js";
import { ensureRuntimeDirectEnvelopeInbox } from "../runtime-direct-envelope-queue.js";
import {
  isGatewayAgent,
  listRuntimeAgentIds,
} from "../agent/agent-identity.js";

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
      if (!entry.isFile()) continue;
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

export async function ensureMailboxDirs(logger, workerIds = []) {
  const agentIds = [...new Set([...listRuntimeAgentIds(), ...workerIds])];
  for (const agentId of agentIds) {
    const ws = getMailboxWorkspace(agentId);
    if (!ws) continue;
    await mkdir(join(ws, "inbox"), { recursive: true });
    await mkdir(join(ws, "outbox"), { recursive: true });
    logger.info(`[mailbox] ensured inbox/outbox for ${agentId}`);
  }
}
