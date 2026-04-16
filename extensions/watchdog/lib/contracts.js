// lib/contracts.js — Contract CRUD, persistence, scanning, and TASK_STATE

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  OC, CONTRACTS_DIR,
  agentWorkspace,
  withLock, atomicWriteFile,
} from "./state.js";
import { broadcast } from "./transport/sse.js";
import { EVENT_TYPE } from "./core/event-types.js";
import {
  CONTRACT_STATUS,
  isActiveContractStatus,
} from "./core/runtime-status.js";
import { resolveGatewayAgentIdForSource } from "./agent/agent-identity.js";
import {
  cacheContractSnapshot,
  listSharedContractEntries,
  readCachedContractSnapshotById,
  readContractSnapshotByPath,
} from "./store/contract-store.js";
import { readRuntimeResultContent } from "./routing/delivery-result.js";

export async function scanPendingContracts(logger, forAgentId) {
  try {
    await mkdir(CONTRACTS_DIR, { recursive: true });
    const entries = await listSharedContractEntries();
    for (const entry of entries) {
      const contract = entry.contract;
      if (isActiveContractStatus(contract.status)) {
        if (forAgentId && contract.assignee && contract.assignee !== forAgentId) continue;
        logger.info(`[watchdog] found ${contract.status} contract: ${contract.id} (assignee: ${contract.assignee || "any"})`);
        return { contract, path: entry.path };
      }
    }
  } catch (e) {
    logger.warn(`[watchdog] scanPendingContracts error: ${e.message}`);
  }
  return null;
}

export function getContractPath(contractId) {
  return join(CONTRACTS_DIR, `${contractId}.json`);
}

export async function readContractSnapshotById(contractId) {
  return readCachedContractSnapshotById(contractId);
}

export async function readContractCompletionArtifact(contractId, contract, {
  deliveryAgentId = resolveGatewayAgentIdForSource("webui"),
} = {}) {
  const normalizedId = typeof contractId === "string" && contractId.trim() ? contractId.trim() : null;
  if (!normalizedId || !contract || typeof contract !== "object") {
    return null;
  }

  try {
    const raw = await readFile(join(getDeliveryDir(deliveryAgentId), `DL-${normalizedId}.json`), "utf8");
    const delivery = JSON.parse(raw);
    return {
      type: "text",
      content: delivery?.resultSummary || "",
      mimeType: "text/markdown",
    };
  } catch {}

  const content = await readRuntimeResultContent({ contract });
  if (!content) {
    return null;
  }
  return {
    type: "text",
    content,
    mimeType: "text/markdown",
  };
}

async function writeContractSnapshot(contractPath, contract, { touchUpdatedAt = false } = {}) {
  if (touchUpdatedAt) contract.updatedAt = Date.now();
  await atomicWriteFile(contractPath, JSON.stringify(contract, null, 2));
  cacheContractSnapshot(contractPath, contract);
  return contractPath;
}

export async function persistContractSnapshot(contractPath, contract, logger, options = {}) {
  const { touchUpdatedAt = false, logMessage = null } = options;
  if (!contractPath || !contract || typeof contract !== "object") {
    return contractPath || null;
  }

  return withLock(`contract:${contractPath}`, async () => {
    await writeContractSnapshot(contractPath, contract, { touchUpdatedAt });
    const message = typeof logMessage === "function"
      ? logMessage(contract, contractPath)
      : logMessage;
    if (message) logger?.info?.(message);
    return contractPath;
  });
}

export async function persistContractById(contract, logger, options = {}) {
  if (!contract?.id) return null;
  return persistContractSnapshot(options.contractPath || getContractPath(contract.id), contract, logger, options);
}

export async function mutateContractSnapshot(contractPath, logger, mutator, options = {}) {
  const { touchUpdatedAt = true, logMessage = null } = options;
  if (!contractPath || typeof mutator !== "function") {
    return null;
  }

  return withLock(`contract:${contractPath}`, async () => {
    const contract = await readContractSnapshotByPath(contractPath, { preferCache: true });
    if (!contract) {
      throw new Error(`contract snapshot missing: ${contractPath}`);
    }
    const result = await mutator(contract);
    if (result === false) {
      return { contract, contractPath, result };
    }
    await writeContractSnapshot(contractPath, contract, { touchUpdatedAt });
    const message = typeof logMessage === "function"
      ? logMessage(contract, contractPath, result)
      : logMessage;
    if (message) logger?.info?.(message);
    return { contract, contractPath, result };
  });
}

export async function updateContractStatus(contractPath, status, logger, extraFields) {
  try {
    const mutation = await mutateContractSnapshot(contractPath, logger, (contract) => {
      contract.status = status;
      if (extraFields) Object.assign(contract, extraFields);
    }, {
      touchUpdatedAt: true,
      logMessage: (contract) => `[watchdog] contract ${contract.id} → ${status}`,
    });

    const contract = mutation?.contract;

    // Mirror status to shared CONTRACTS_DIR copy if the primary path is an agent inbox
    if (contract?.id) {
      const sharedPath = getContractPath(contract.id);
      if (resolve(contractPath) !== resolve(sharedPath)) {
        try {
          await mutateContractSnapshot(sharedPath, null, (shared) => {
            shared.status = status;
            if (extraFields) Object.assign(shared, extraFields);
          }, { touchUpdatedAt: true });
        } catch {}
      }
    }

    if (status === CONTRACT_STATUS.AWAITING_INPUT && contract) {
      broadcast("alert", {
        type: EVENT_TYPE.TASK_AWAITING_INPUT,
        contractId: contract.id,
        task: (contract.task || "").slice(0, 100),
        clarification: contract.clarification || null,
        ts: Date.now(),
      });
    }
    return { ok: true };
  } catch (e) {
    logger.error(`[watchdog] updateContractStatus FAILED (${status}): ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export async function mergeContractFields(contractPath, logger, extraFields) {
  if (!contractPath || !extraFields || typeof extraFields !== "object") {
    return;
  }

  try {
    const mutation = await mutateContractSnapshot(contractPath, logger, (contract) => {
      Object.assign(contract, extraFields);
    }, {
      touchUpdatedAt: true,
      logMessage: (contract) => `[watchdog] contract ${contract.id} runtime fields merged`,
    });

    // Mirror fields to shared CONTRACTS_DIR copy if the primary path is an agent inbox
    const contract = mutation?.contract;
    if (contract?.id) {
      const sharedPath = getContractPath(contract.id);
      if (resolve(contractPath) !== resolve(sharedPath)) {
        try {
          await mutateContractSnapshot(sharedPath, null, (shared) => {
            Object.assign(shared, extraFields);
          }, { touchUpdatedAt: true });
        } catch {}
      }
    }
  } catch (e) {
    logger.warn(`[watchdog] mergeContractFields error: ${e.message}`);
  }
}

export async function writeTaskState(trackingState, logger) {
  if (!trackingState.contract) return;
  const s = trackingState;
  const c = s.contract;
  const completedItems = s.toolCalls
    .filter(tc => /^(write|Write|create)$/i.test(tc.tool))
    .map(tc => tc.label)
    .slice(-10);

  const content = [
    `SESSION: ${s.sessionKey}`,
    `TASK: ${c.task}`,
    `CURSOR: ${s.cursor || "--"}`,
    `PHASE: ${s.estimatedPhase || "--"}`,
    `CURRENT: ${s.lastLabel}`,
    `COMPLETED:`,
    ...completedItems.map(item => `  - ${item}`),
    `REMAINING: ${
      Number.isFinite(s?.stageProjection?.total) && Number.isFinite(s?.stageProjection?.done)
        ? Math.max(0, s.stageProjection.total - s.stageProjection.done)
        : "unknown"
    } steps`,
    `ARTIFACTS: ${c.output || ""}`,
    `TASK_COMPLETE: ${s.status === CONTRACT_STATUS.COMPLETED}`,
    ``,
    `# Debug info`,
    `TOOL_CALL_COUNT: ${s.toolCallTotal}`,
    `ELAPSED_MS: ${Date.now() - s.startMs}`,
    `CONTRACT_ID: ${c.id}`,
  ].join("\n");

  try {
    await writeFile(join(OC, "workspaces", "controller", "TASK_STATE.md"), content);
  } catch (e) {
    logger.warn(`[watchdog] writeTaskState error: ${e.message}`);
  }
}

export function getDeliveryDir(agentId) {
  const normalizedAgentId = typeof agentId === "string" && agentId.trim()
    ? agentId.trim()
    : resolveGatewayAgentIdForSource("webui");
  return join(agentWorkspace(normalizedAgentId), "deliveries");
}

export { readContractSnapshotByPath } from "./store/contract-store.js";
export { evaluateContractOutcome } from "./contract-outcome.js";
export { listLifecycleWorkItems } from "./contract-lifecycle-view.js";
