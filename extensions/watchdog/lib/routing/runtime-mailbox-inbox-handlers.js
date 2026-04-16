// lib/runtime-mailbox-inbox-handlers.js — role-specific inbox routing handlers

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../state.js";
import {
  cacheContractSnapshot,
  evictContractSnapshotByPath,
  listSharedContractEntries,
  readCachedContractSnapshotById,
  readContractSnapshotByPath,
} from "../store/contract-store.js";
import {
  getTrackingState,
  hasOtherRunningTrackingSessionForAgent,
} from "../store/tracker-store.js";
import { isDirectRequestEnvelope } from "../protocol-primitives.js";
import { ensureRuntimeDirectEnvelopeInbox } from "../runtime-direct-envelope-queue.js";
import { normalizeContractIdentity, normalizeString } from "../core/normalize.js";
import { isActiveContractStatus } from "../core/runtime-status.js";

async function removeInboxContractIfExists(inboxDir, logger, agentId) {
  const contractPath = join(inboxDir, "contract.json");
  try {
    const contract = await readContractSnapshotByPath(contractPath, { preferCache: false });
    if (isDirectRequestEnvelope(contract)) {
      logger.info(`[router] routeInbox(${agentId}): preserved direct_request inbox/contract.json`);
      return { removed: false, preserved: "direct_request" };
    }
  } catch {}

  try {
    await unlink(contractPath);
    evictContractSnapshotByPath(contractPath);
    logger.info(`[router] routeInbox(${agentId}): removed stale inbox/contract.json`);
    await ensureRuntimeDirectEnvelopeInbox({ inboxDir, agentId, logger });
    return { removed: true, preserved: null };
  } catch {
    return { removed: false, preserved: null };
  }
}

function serializeContract(contract) {
  return JSON.stringify(contract, null, 2);
}

async function stageInboxContract(inboxDir, contract, logger, agentId) {
  const dest = join(inboxDir, "contract.json");
  await atomicWriteFile(dest, serializeContract(contract));
  cacheContractSnapshot(dest, contract);
  logger.info(`[router] routeInbox(${agentId}): ${contract.id}.json → inbox/contract.json`);
}

export async function routeWorkerInbox({
  agentId,
  inboxDir,
  logger,
  sessionKey = null,
  contractIdHint = null,
  contractPathHint = null,
}) {
  const directInboxState = await ensureRuntimeDirectEnvelopeInbox({
    inboxDir,
    agentId,
    logger,
  });
  if (directInboxState.active) {
    logger.info(`[router] routeInbox(${agentId}): preserved direct_request inbox/contract.json`);
    return;
  }

  if (hasOtherRunningTrackingSessionForAgent(agentId, sessionKey)) {
    await removeInboxContractIfExists(inboxDir, logger, agentId);
    logger.info(`[router] routeInbox(${agentId}): skipped restaging while live worker tracker is active`);
    return;
  }

  const resumedTrackingState = sessionKey ? getTrackingState(sessionKey) : null;
  const resumedContractPath = resumedTrackingState?.contract?.path || null;
  const resumedContractSnapshot = resumedContractPath
    ? await readContractSnapshotByPath(resumedContractPath, { preferCache: false })
    : resumedTrackingState?.contract || null;
  if (
    resumedContractSnapshot
    && isActiveContractStatus(resumedContractSnapshot.status)
    && resumedContractSnapshot.assignee === agentId
  ) {
    await stageInboxContract(inboxDir, resumedContractSnapshot, logger, agentId);
    return;
  }

  const normalizedContractIdHint = normalizeContractIdentity(contractIdHint);
  const normalizedContractPathHint = normalizeString(contractPathHint);
  const hasExactContractHint = Boolean(normalizedContractIdHint || normalizedContractPathHint);
  if (normalizedContractPathHint) {
    try {
      const requestedContract = normalizedContractIdHint
        ? await readCachedContractSnapshotById(normalizedContractIdHint, {
            contractPathHint: normalizedContractPathHint,
            preferCache: false,
          })
        : await readContractSnapshotByPath(normalizedContractPathHint, {
            preferCache: false,
          });
      if (
        requestedContract
        && isActiveContractStatus(requestedContract.status)
        && requestedContract.assignee === agentId
        && (
          !normalizedContractIdHint
          || normalizeContractIdentity(requestedContract.id) === normalizedContractIdHint
        )
      ) {
        await stageInboxContract(inboxDir, requestedContract, logger, agentId);
        return;
      }
    } catch (error) {
      logger.warn(
        `[router] routeInbox(${agentId}): requested worker lookup failed for `
        + `${normalizedContractIdHint || normalizedContractPathHint}: ${error.message}`,
      );
    }
  }

  if (hasExactContractHint) {
    await removeInboxContractIfExists(inboxDir, logger, agentId);
    logger.info(
      `[router] routeInbox(${agentId}): exact contract `
      + `${normalizedContractIdHint || normalizedContractPathHint} not claimable`,
    );
    return;
  }

  try {
    const entries = (await listSharedContractEntries())
      .slice();
    for (const entry of entries) {
      try {
        const contract = entry.contract;
        if (isActiveContractStatus(contract.status)
          && contract.assignee === agentId) {
          await stageInboxContract(inboxDir, contract, logger, agentId);
          return;
        }
      } catch (e) {
        logger.warn(`[router] routeInbox: failed to read ${entry.path}: ${e.message}`);
      }
    }
    await removeInboxContractIfExists(inboxDir, logger, agentId);
    logger.info(`[router] routeInbox(${agentId}): no pending/running contracts found`);
  } catch (e) {
    logger.warn(`[router] routeInbox(${agentId}) error: ${e.message}`);
  }
}
