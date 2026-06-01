// lib/runtime-mailbox-inbox-handlers.js — role-specific inbox routing handlers

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../state.js";
import {
  cacheContractSnapshot,
  evictContractSnapshotByPath,
  readCachedContractSnapshotById,
  readContractSnapshotByPath,
} from "../store/contract-store.js";
import { getContractPath } from "../contracts.js";
import {
  getTrackingState,
  hasOtherRunningBoundTrackingSessionForAgent,
  listOtherRunningTrackingSessionsForAgent,
} from "../store/tracker-store.js";
import {
  getDispatchTargetCurrentContract,
} from "./dispatch-runtime-state.js";
import { isDirectRequestEnvelope } from "../protocol-primitives.js";
import { ensureRuntimeDirectEnvelopeInbox } from "../runtime-direct-envelope-queue.js";
import { normalizeContractIdentity, normalizeString } from "../core/normalize.js";
import { isActiveContractStatus } from "../core/runtime-status.js";

const TASK_FACING_INBOX_ALLOW_KEYS = Object.freeze([
  "id",
  "task",
  "taskType",
  "assignee",
  "status",
  "completionCriteria",
  "codingSpec",
  "protocol",
  "stagePlan",
  "stageRuntime",
  "runtimeContext",
  "phases",
  "total",
  "pipelineStage",
  "followUp",
  "systemActionDelivery",
  "systemActionDeliveryTicket",
  "systemAction",
  "executionObservation",
  "terminalOutcome",
  "upstreamPackages",
]);

function isDispatchOwnedContract(agentId, contractId) {
  const currentContractId = normalizeContractIdentity(getDispatchTargetCurrentContract(agentId));
  const normalizedContractId = normalizeContractIdentity(contractId);
  return Boolean(currentContractId && normalizedContractId && currentContractId === normalizedContractId);
}

async function removeInboxContractIfExists(inboxDir, logger, agentId) {
  const contractPath = join(inboxDir, "contract.json");
  try {
    const contract = await readContractSnapshotByPath(contractPath, { preferCache: false });
    if (isDirectRequestEnvelope(contract)) {
      logger.info(`[mailbox] routeInbox(${agentId}): preserved direct_request inbox/contract.json`);
      return { removed: false, preserved: "direct_request" };
    }
  } catch {}

  try {
    await unlink(contractPath);
    evictContractSnapshotByPath(contractPath);
    logger.info(`[mailbox] routeInbox(${agentId}): removed stale inbox/contract.json`);
    await ensureRuntimeDirectEnvelopeInbox({ inboxDir, agentId, logger });
    return { removed: true, preserved: null };
  } catch {
    return { removed: false, preserved: null };
  }
}

function projectTaskFacingInboxContract(contract, agentId = null) {
  if (!contract || typeof contract !== "object") {
    return contract;
  }
  const projected = {};
  for (const key of TASK_FACING_INBOX_ALLOW_KEYS) {
    if (Object.prototype.hasOwnProperty.call(contract, key)) {
      projected[key] = contract[key];
    }
  }
  return projected;
}

function serializeContract(contract, agentId) {
  return JSON.stringify(projectTaskFacingInboxContract(contract, agentId), null, 2);
}

async function stageInboxContract(inboxDir, contract, logger, agentId) {
  const dest = join(inboxDir, "contract.json");
  await atomicWriteFile(dest, serializeContract(contract, agentId));
  cacheContractSnapshot(dest, contract);
  logger.info(`[mailbox] routeInbox(${agentId}): ${contract.id}.json → inbox/contract.json`);
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
    logger.info(`[mailbox] routeInbox(${agentId}): preserved direct_request inbox/contract.json`);
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
  const otherRunningBoundSessions = listOtherRunningTrackingSessionsForAgent(agentId, sessionKey)
    .filter((entry) => entry.hasContract);

  if (!hasExactContractHint && hasOtherRunningBoundTrackingSessionForAgent(agentId, sessionKey)) {
    await removeInboxContractIfExists(inboxDir, logger, agentId);
    logger.info(`[mailbox] routeInbox(${agentId}): skipped scan restaging while another bound tracker is active`);
    return;
  }

  if (
    hasExactContractHint
    && normalizedContractIdHint
    && otherRunningBoundSessions.some((entry) => entry.contractId !== normalizedContractIdHint)
  ) {
    await removeInboxContractIfExists(inboxDir, logger, agentId);
    logger.info(
      `[mailbox] routeInbox(${agentId}): skipped exact staging for ${normalizedContractIdHint} `
      + "while another bound tracker is active",
    );
    return;
  }

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
        && isDispatchOwnedContract(agentId, requestedContract.id)
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
        `[mailbox] routeInbox(${agentId}): requested worker lookup failed for `
        + `${normalizedContractIdHint || normalizedContractPathHint}: ${error.message}`,
      );
    }
  }

  if (hasExactContractHint) {
    await removeInboxContractIfExists(inboxDir, logger, agentId);
    logger.info(
      `[mailbox] routeInbox(${agentId}): exact contract `
      + `${normalizedContractIdHint || normalizedContractPathHint} not claimable`,
    );
    return;
  }

  const dispatchOwnerContractId = normalizeContractIdentity(getDispatchTargetCurrentContract(agentId));
  if (dispatchOwnerContractId) {
    try {
      const contract = await readCachedContractSnapshotById(dispatchOwnerContractId, {
        contractPathHint: getContractPath(dispatchOwnerContractId),
        preferCache: false,
      });
      if (
        contract
        && isActiveContractStatus(contract.status)
        && contract.assignee === agentId
      ) {
        await stageInboxContract(inboxDir, contract, logger, agentId);
        return;
      }
    } catch (e) {
      logger.warn(`[mailbox] routeInbox: failed to read dispatch owner ${dispatchOwnerContractId}: ${e.message}`);
    }
  }

  await removeInboxContractIfExists(inboxDir, logger, agentId);
  logger.info(`[mailbox] routeInbox(${agentId}): no dispatch-owned contract found`);
}
