// Contract envelope binding logic for session bootstrap.
// Exports: bindPendingWorkerContract, bindDirectInboxEnvelope, bindInboxContractEnvelope

import { join, resolve } from "node:path";
import { getContractPath, updateContractStatus } from "./contracts.js";
import { agentWorkspace } from "./state.js";
import { readCachedContractSnapshotById, readContractSnapshotByPath } from "./store/contract-store.js";
import { isDirectRequestEnvelope } from "./protocol-primitives.js";
import { ensureRuntimeDirectEnvelopeInbox } from "./runtime-direct-envelope-queue.js";
import { CONTRACT_STATUS, isActiveContractStatus } from "./core/runtime-status.js";
import { normalizeContractIdentity } from "./core/normalize.js";
import { notifyTrackingContractClaim } from "./store/tracker-store.js";
import {
  claimDispatchTargetContract,
  getDispatchTargetCurrentContract,
  hasDispatchTarget,
} from "./routing/dispatch-runtime-state.js";
import { toTrackingContract } from "./session-tracking-state.js";
import { ensureWorkspaceContractOutputAlias } from "./runtime-contract-output-alias.js";
import { AGENT_ROLE, getAgentIdentitySnapshot } from "./agent/agent-identity.js";
import { getQQTarget, qqNotify, qqTypingStart, hasQQPassiveReplyTarget } from "./channel-notify.js";

function trimSingleLine(value, limit = 72) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function buildClaimMessage(agentId, contract) {
  const normalizedAgentId = trimSingleLine(agentId, 40) || "agent";
  const contractId = trimSingleLine(contract?.id, 64) || "unknown contract";
  const title = trimSingleLine(contract?.task || contract?.title || contract?.objective, 72);
  return [
    `🔧 ${normalizedAgentId} 开始处理 ${contractId}`,
    title ? `标题：${title}` : null,
  ].filter(Boolean).join("\n");
}

function notifyDispatchTargetClaim(agentId, contract) {
  const identity = getAgentIdentitySnapshot(agentId);
  if (identity.role !== AGENT_ROLE.EXECUTOR) {
    return;
  }
  const qqTarget = getQQTarget(contract);
  if (!qqTarget) {
    return;
  }
  if (hasQQPassiveReplyTarget(qqTarget)) {
    return;
  }
  void qqNotify(qqTarget, buildClaimMessage(agentId, contract));
  qqTypingStart(contract.id, qqTarget);
}

async function ensureDirectRequestInboxEnvelope(agentId, logger) {
  const ws = agentWorkspace(agentId);
  if (!ws) return { active: false };
  return ensureRuntimeDirectEnvelopeInbox({
    inboxDir: join(ws, "inbox"),
    agentId,
    logger,
  });
}

async function resolveTrackingEnvelopeBinding(contract, fallbackPath) {
  if (!contract?.id || isDirectRequestEnvelope(contract)) {
    return {
      contract,
      path: fallbackPath,
    };
  }

  const sharedPath = getContractPath(contract.id);
  if (!sharedPath || sharedPath === fallbackPath) {
    return {
      contract,
      path: fallbackPath,
    };
  }

  try {
    const sharedContract = await readContractSnapshotByPath(sharedPath, { preferCache: false });
    if (sharedContract?.id === contract.id) {
      return {
        contract: sharedContract,
        path: sharedPath,
      };
    }
  } catch {}

  return {
    contract,
    path: fallbackPath,
  };
}

function isCanonicalSharedContractBinding(contractId, bindingPath) {
  const sharedPath = contractId ? getContractPath(contractId) : null;
  if (!sharedPath || !bindingPath) {
    return false;
  }
  return resolve(sharedPath) === resolve(bindingPath);
}

function isDispatchOwnedSharedContract(agentId, contractId) {
  if (!hasDispatchTarget(agentId)) {
    return false;
  }
  const currentContractId = normalizeContractIdentity(getDispatchTargetCurrentContract(agentId));
  const normalizedContractId = normalizeContractIdentity(contractId);
  return Boolean(currentContractId && normalizedContractId && currentContractId === normalizedContractId);
}

export async function bindPendingWorkerContract({
  agentId,
  sessionKey,
  trackingState,
  logger,
  logContext = "session",
  requiredContractId = null,
}) {
  const directInboxState = await ensureDirectRequestInboxEnvelope(agentId, logger);
  if (directInboxState.active) {
    logger.info(`[watchdog] direct_request present for ${agentId}, skipping shared-contract bind`);
    return null;
  }

  let pending = null;
  const normalizedRequiredContractId = normalizeContractIdentity(requiredContractId);
  const dispatchOwnerContractId = getDispatchTargetCurrentContract(agentId);
  const preferredCurrentContractId = normalizedRequiredContractId || dispatchOwnerContractId;

  if (preferredCurrentContractId) {
    const contract = await readCachedContractSnapshotById(preferredCurrentContractId, {
      contractPathHint: getContractPath(preferredCurrentContractId),
      preferCache: false,
    });
    const path = contract?.id ? getContractPath(contract.id) : getContractPath(preferredCurrentContractId);
    if (
      contract
      && isActiveContractStatus(contract.status)
      && contract.assignee === agentId
    ) {
      pending = { contract, path };
    } else {
      if (normalizedRequiredContractId) {
        logger.info(
          `[watchdog] exact contract ${normalizedRequiredContractId} not claimable for ${agentId}; `
          + `skipping bind`,
        );
        return null;
      }
      logger.info(
        `[watchdog] dispatch owner currentContract ${preferredCurrentContractId} not claimable for `
        + `${agentId}; skipping bind`,
      );
      return null;
    }
  }
  if (!pending && !normalizedRequiredContractId) {
    logger.info(`[watchdog] no dispatch owner for ${agentId}; skipping shared-contract bind`);
    return null;
  }
  if (!pending) return null;

  const { contract, path } = pending;
  trackingState.contract = toTrackingContract(contract, path);
  await ensureWorkspaceContractOutputAlias({
    agentId,
    contractOutput: trackingState.contract.output,
    logger,
  });
  notifyTrackingContractClaim(sessionKey, trackingState.contract.id);
  await updateContractStatus(path, CONTRACT_STATUS.RUNNING, logger);
  await claimDispatchTargetContract({ contractId: contract.id, agentId, logger });
  notifyDispatchTargetClaim(agentId, contract);

  return { contract, path, trackingContract: trackingState.contract };
}

export async function bindDirectInboxEnvelope({
  agentId,
  trackingState,
  logger,
}) {
  return bindInboxContractEnvelope({
    agentId,
    trackingState,
    logger,
    allowNonDirectRequest: false,
  });
}

export async function bindInboxContractEnvelope({
  agentId,
  trackingState,
  logger,
  allowNonDirectRequest = false,
  requiredContractId = null,
}) {
  if (!trackingState || trackingState.contract) return null;

  const ws = agentWorkspace(agentId);
  if (!ws) return null;

  const contractPath = join(ws, "inbox", "contract.json");
  try {
    await ensureDirectRequestInboxEnvelope(agentId, logger);
    const contract = await readContractSnapshotByPath(contractPath, { preferCache: false });
    const normalizedRequiredContractId = normalizeContractIdentity(requiredContractId);
    const isDirectRequest = isDirectRequestEnvelope(contract);
    if (
      normalizedRequiredContractId
      && !isDirectRequest
      && normalizeContractIdentity(contract?.id) !== normalizedRequiredContractId
    ) {
      logger.info(
        `[watchdog] skipped inbox contract ${contract?.id || "unknown"} for ${trackingState.sessionKey}; `
        + `required ${normalizedRequiredContractId}`,
      );
      return null;
    }
    if (!isDirectRequest && allowNonDirectRequest !== true) {
      return null;
    }
    if (!isDirectRequest && !isActiveContractStatus(contract?.status)) {
      logger.info(
        `[watchdog] skipped non-active inbox contract ${contract?.id || "unknown"} `
        + `(${contract?.status || "unknown"}) for ${trackingState.sessionKey}`,
      );
      return null;
    }
    if (!isDirectRequest && !isDispatchOwnedSharedContract(agentId, contract?.id)) {
      logger.info(
        `[watchdog] skipped inbox contract ${contract?.id || "unknown"} for ${trackingState.sessionKey}; `
        + "missing dispatch ownership",
      );
      return null;
    }

    const binding = await resolveTrackingEnvelopeBinding(contract, contractPath);
    trackingState.contract = toTrackingContract(binding.contract, binding.path);
    await ensureWorkspaceContractOutputAlias({
      agentId,
      contractOutput: trackingState.contract.output,
      logger,
    });
    if (
      !isDirectRequest
      && isCanonicalSharedContractBinding(contract?.id, binding.path)
      && trackingState.contract?.status !== CONTRACT_STATUS.RUNNING
    ) {
      await updateContractStatus(binding.path, CONTRACT_STATUS.RUNNING, logger);
      binding.contract.status = CONTRACT_STATUS.RUNNING;
      trackingState.contract.status = CONTRACT_STATUS.RUNNING;
    }
    notifyTrackingContractClaim(trackingState.sessionKey, trackingState.contract.id);
    logger.info(
      `[watchdog] bound ${isDirectRequest ? "direct inbox" : "inbox"} envelope `
      + `${contract.id} to ${trackingState.sessionKey}`,
    );
    return { contract, path: contractPath, trackingContract: trackingState.contract };
  } catch {
    return null;
  }
}
