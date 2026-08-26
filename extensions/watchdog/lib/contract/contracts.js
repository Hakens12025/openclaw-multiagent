// lib/contract/contracts.js — Contract CRUD, persistence, scanning, and TASK_STATE

import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  agentWorkspace,
  withLock, atomicWriteFile,
} from "../state.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  CONTRACT_STATUS,
  isActiveContractStatus,
} from "../core/runtime-status.js";
import { resolveGatewayAgentIdForSource } from "../agent/agent-identity.js";
import {
  cacheContractSnapshot,
  listSharedContractEntries,
  readCachedContractSnapshotById,
  readContractSnapshotByPath,
  resolveSharedContractPathById,
} from "../store/contract-store.js";
import {
  RUN_CONTRACTS_DIRNAME,
  ensureRunScaffold,
  recordContractHome,
  runDirFor,
} from "../archive/thread-tree-store.js";
import { ensureLineage, normalizeLineage } from "./contract-lineage.js";
import { resolveTerminalUserFacingResultContent } from "../routing/delivery/delivery-result.js";

export async function scanPendingContracts(logger, forAgentId) {
  try {
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

// 全系统 id→正本路径唯一解析点(保同步签名:索引常驻内存)。
// 索引命中 → threads/{t}/runs/{r}/contracts/{id}.json;索引 miss → null,
// 调用方必须处理 null(读侧当缺席,写侧走 persistContractById 落位)。
export function getContractPath(contractId) {
  return resolveSharedContractPathById(contractId);
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

  const content = await resolveTerminalUserFacingResultContent({ contract });
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
  await mkdir(resolve(contractPath, ".."), { recursive: true });
  await atomicWriteFile(contractPath, JSON.stringify(contract, null, 2));
  cacheContractSnapshot(contractPath, contract);
  return contractPath;
}

// 字面写:合约快照写到调用方给定的路径(inbox 副本/交付副本等非正本写专用),
// 不做任何改道。正本写必须走 persistContractById。
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

// 正本写唯一 API:目标恒为树内 threads/{t}/runs/{r}/contracts/{id}.json,
// 由合约谱系推导(缺谱系 → warn + 铸孤儿线兜底,树需要全覆盖),
// 落盘前建 run 脚手架并登记 id→home 索引(建约时刻索引单写一行,§三)。
export async function persistContractById(contract, logger, options = {}) {
  const contractId = typeof contract?.id === "string" && contract.id.trim() ? contract.id.trim() : null;
  if (!contractId) {
    throw new Error("persistContractById requires contract.id");
  }

  let lineage = normalizeLineage(contract.lineage);
  if (!lineage?.threadId || !lineage?.runId) {
    lineage = ensureLineage(lineage);
    contract.lineage = lineage;
    logger?.warn?.(
      `[contracts] ${contractId} reached canonical persist without full lineage — `
      + `minted orphan lineage ${lineage.threadId}/${lineage.runId} (工厂兜底应已覆盖,这是调用方 bug)`,
    );
  }
  await ensureRunScaffold(lineage);
  await recordContractHome(contractId, lineage);
  const targetPath = join(runDirFor(lineage), RUN_CONTRACTS_DIRNAME, `${contractId}.json`);
  return persistContractSnapshot(targetPath, contract, logger, options);
}

export async function mutateContractSnapshot(contractPath, logger, mutator, options = {}) {
  const { touchUpdatedAt = true, logMessage = null } = options;
  if (!contractPath) {
    throw new Error("mutateContractSnapshot requires a contractPath (got null/empty) — 静默 no-op 会绕过 fail-closed 守卫");
  }
  if (typeof mutator !== "function") {
    throw new Error(`mutateContractSnapshot requires a mutator function for ${contractPath}`);
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

// 按 id 突变正本:id → 树内正本路径(索引解析),索引 miss 即抛错——调用方要么
// 处理异常要么让它冒泡,不存在"假成功"。
export async function mutateContractById(contractId, logger, mutator, options = {}) {
  const normalizedId = typeof contractId === "string" && contractId.trim() ? contractId.trim() : null;
  if (!normalizedId) {
    throw new Error("mutateContractById requires a contractId");
  }
  const contractPath = getContractPath(normalizedId);
  if (!contractPath) {
    throw new Error(`contract home not found for ${normalizedId} (id→home 索引未收录)`);
  }
  return mutateContractSnapshot(contractPath, logger, mutator, options);
}

export async function updateContractStatus(contractPath, status, logger, extraFields) {
  if (!contractPath) {
    throw new Error(`updateContractStatus requires a contractPath (status=${status}) — 假成功会掩盖正本失联`);
  }
  try {
    const mutation = await mutateContractSnapshot(contractPath, logger, (contract) => {
      contract.status = status;
      if (extraFields) Object.assign(contract, extraFields);
    }, {
      touchUpdatedAt: true,
      logMessage: (contract) => `[watchdog] contract ${contract.id} → ${status}`,
    });

    const contract = mutation?.contract;

    // Mirror status to the shared canonical copy (树内正本) if the primary path is an agent inbox
    // (批④ workspace symlink 化后整段退役)
    if (contract?.id) {
      const sharedPath = getContractPath(contract.id);
      if (sharedPath && resolve(contractPath) !== resolve(sharedPath)) {
        try {
          await mutateContractSnapshot(sharedPath, null, (shared) => {
            shared.status = status;
            if (extraFields) Object.assign(shared, extraFields);
          }, { touchUpdatedAt: true });
        } catch {}
      }
    }

    return { ok: true };
  } catch (e) {
    logger.error(`[watchdog] updateContractStatus FAILED (${status}): ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export async function mergeContractFields(contractPath, logger, extraFields) {
  if (!contractPath) {
    throw new Error("mergeContractFields requires a contractPath — 静默 no-op 会丢运行时字段");
  }
  if (!extraFields || typeof extraFields !== "object") {
    return;
  }

  try {
    const mutation = await mutateContractSnapshot(contractPath, logger, (contract) => {
      Object.assign(contract, extraFields);
    }, {
      touchUpdatedAt: true,
      logMessage: (contract) => `[watchdog] contract ${contract.id} runtime fields merged`,
    });

    // Mirror fields to the shared canonical copy (树内正本) if the primary path is an agent inbox
    // (批④ workspace symlink 化后整段退役)
    const contract = mutation?.contract;
    if (contract?.id) {
      const sharedPath = getContractPath(contract.id);
      if (sharedPath && resolve(contractPath) !== resolve(sharedPath)) {
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
    await atomicWriteFile(CONTROL_PLANE_PATHS.taskStateFile, content);
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

export { readContractSnapshotByPath } from "../store/contract-store.js";
export { listLifecycleWorkItems } from "./contract-lifecycle-view.js";
