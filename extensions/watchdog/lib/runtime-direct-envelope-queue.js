import { access, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, agentWorkspace, withLock } from "./state.js";
import {
  cacheContractSnapshot,
  moveContractSnapshotPath,
  readContractSnapshotByPath,
} from "./store/contract-store.js";
import { isDirectRequestEnvelope } from "./protocol-primitives.js";
import {
  clearPendingSignal,
  PENDING_SIGNAL_KINDS,
  registerPendingSignal,
} from "./runtime/pending-signal-registry.js";
import { listRuntimeAgentIds } from "./agent/agent-identity.js";

const QUEUED_FILENAME_RE = /^contract-(\d+)-(\d+)-(.+)\.json$/;

function parseQueuedContractFile(fileName) {
  const match = fileName.match(QUEUED_FILENAME_RE);
  if (!match) return null;
  return { queuedAt: match[1], sequence: match[2], contractId: match[3] };
}

const RUNTIME_DIRECT_ENVELOPE_QUEUE_DIR = ".runtime-direct-envelope-queue";
let queueSequence = 0;

function getQueueDir(inboxDir) {
  return join(inboxDir, RUNTIME_DIRECT_ENVELOPE_QUEUE_DIR);
}

function getInboxLockKey(inboxDir) {
  return `runtime-direct-envelope-inbox:${inboxDir}`;
}

async function activeInboxPathIsFree(inboxDir) {
  try {
    await access(join(inboxDir, "contract.json"));
    return false;
  } catch {
    return true;
  }
}

async function readActiveInboxContract(inboxDir) {
  try {
    return await readContractSnapshotByPath(join(inboxDir, "contract.json"), { preferCache: false });
  } catch {
    return null;
  }
}

async function listQueuedContracts(inboxDir) {
  try {
    const files = await readdir(getQueueDir(inboxDir));
    return files
      .filter((file) => /^contract-.*\.json$/i.test(file))
      .sort();
  } catch {
    return [];
  }
}

async function countQueuedContractFiles(inboxDir) {
  return (await listQueuedContracts(inboxDir)).length;
}

function clearRuntimeDirectEnvelopePendingSignal({ agentId, envelopeId }) {
  if (!envelopeId) return false;
  return clearPendingSignal({
    agentId,
    sourceKind: PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE,
    sourceRef: envelopeId,
    envelopeId,
  });
}

async function ensureRuntimeDirectEnvelopeInboxUnlocked({
  inboxDir,
  agentId = "agent",
  logger,
}) {
  const activeContract = await readActiveInboxContract(inboxDir);
  if (isDirectRequestEnvelope(activeContract)) {
    clearRuntimeDirectEnvelopePendingSignal({
      agentId,
      envelopeId: activeContract?.id || null,
    });
    return {
      active: true,
      promoted: false,
      contractId: activeContract?.id || null,
      contract: activeContract || null,
      source: "active_contract",
    };
  }

  if (!(await activeInboxPathIsFree(inboxDir))) {
    return {
      active: false,
      promoted: false,
      contractId: null,
      source: "occupied_contract",
    };
  }

  const queuedFiles = await listQueuedContracts(inboxDir);
  if (queuedFiles.length === 0) {
    return {
      active: false,
      promoted: false,
      contractId: null,
      source: "queue_empty",
    };
  }

  let selectedQueuePath = null;
  let selectedQueueFile = null;
  let queuedContractId = null;
  let queuedContract = null;
  for (const queuedFile of queuedFiles) {
    const queuePath = join(getQueueDir(inboxDir), queuedFile);
    try {
      const candidate = await readContractSnapshotByPath(queuePath, { preferCache: false });
      if (!isDirectRequestEnvelope(candidate)) {
        await rm(queuePath, { force: true });
        const parsed = parseQueuedContractFile(queuedFile);
        clearRuntimeDirectEnvelopePendingSignal({
          agentId,
          envelopeId: candidate?.id || parsed?.contractId || null,
        });
        logger?.warn?.(
          `[runtime_direct_envelope_queue] discarded non-direct queued contract ${candidate?.id || queuedFile} for ${agentId}`,
        );
        continue;
      }
      selectedQueuePath = queuePath;
      selectedQueueFile = queuedFile;
      queuedContract = candidate;
      queuedContractId = candidate?.id || null;
      break;
    } catch {
      await rm(queuePath, { force: true }).catch(() => {});
      const parsed = parseQueuedContractFile(queuedFile);
      clearRuntimeDirectEnvelopePendingSignal({
        agentId,
        envelopeId: parsed?.contractId || null,
      });
    }
  }

  if (!selectedQueuePath) {
    return {
      active: false,
      promoted: false,
      contractId: null,
      source: "queue_empty",
    };
  }

  const activePath = join(inboxDir, "contract.json");
  await rename(selectedQueuePath, activePath);
  moveContractSnapshotPath(selectedQueuePath, activePath);
  clearRuntimeDirectEnvelopePendingSignal({
    agentId,
    envelopeId: queuedContractId,
  });
  logger?.info?.(
    `[runtime_direct_envelope_queue] activated queued direct envelope ${queuedContractId || selectedQueueFile} for ${agentId}`,
  );

  return {
    active: true,
    promoted: true,
    contractId: queuedContractId,
    contract: queuedContract || null,
    source: "runtime_queue",
  };
}

export async function ensureRuntimeDirectEnvelopeInbox({
  inboxDir,
  agentId = "agent",
  logger,
}) {
  return withLock(getInboxLockKey(inboxDir), () => ensureRuntimeDirectEnvelopeInboxUnlocked({
    inboxDir,
    agentId,
    logger,
  }));
}

export async function clearRuntimeDirectEnvelopeStores(agentIds = [], { logger = null } = {}) {
  const uniqueAgentIds = [...new Set(
    (Array.isArray(agentIds) ? agentIds : [])
      .filter((agentId) => typeof agentId === "string" && agentId.trim())
      .map((agentId) => agentId.trim()),
  )];

  let files = 0;
  await Promise.all(uniqueAgentIds.map(async (agentId) => {
    const inboxDir = join(agentWorkspace(agentId), "inbox");
    const queueDir = getQueueDir(inboxDir);
    try {
      files += await countQueuedContractFiles(inboxDir);
      const activeContract = await readActiveInboxContract(inboxDir);
      if (isDirectRequestEnvelope(activeContract)) {
        files += 1;
      }
      await rm(queueDir, { recursive: true, force: true });
      await rm(join(inboxDir, "contract.json"), { force: true });
    } catch (error) {
      logger?.warn?.(`[runtime_direct_envelope_queue] reset cleanup failed for ${agentId}: ${error?.message || error}`);
    }
  }));

  return { files };
}

export async function enqueueRuntimeDirectEnvelope({
  inboxDir,
  contract,
  agentId = "agent",
  logger,
}) {
  if (!isDirectRequestEnvelope(contract)) {
    logger?.warn?.(
      `[runtime_direct_envelope_queue] rejected non-direct contract ${contract?.id || "unknown"} for ${agentId}`,
    );
    return {
      enqueued: false,
      rejected: true,
      reason: "non_direct_request_envelope",
      contractId: contract?.id || null,
      promoted: false,
      active: false,
    };
  }

  return withLock(getInboxLockKey(inboxDir), async () => {
    const queueDir = getQueueDir(inboxDir);
    await mkdir(queueDir, { recursive: true });

    const sequence = String(queueSequence++).padStart(6, "0");
    const queuedAt = String(Date.now()).padStart(13, "0");
    // Format mirrored in parseQueuedContractFile — keep in sync.
    const queuePath = join(queueDir, `contract-${queuedAt}-${sequence}-${contract.id}.json`);
    await atomicWriteFile(queuePath, JSON.stringify(contract, null, 2));
    cacheContractSnapshot(queuePath, contract);

    registerPendingSignal({
      agentId,
      sourceKind: PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE,
      sourceRef: contract.id,
      envelopeId: contract.id,
      envelope: contract,
    });

    const readyState = await ensureRuntimeDirectEnvelopeInboxUnlocked({ inboxDir, agentId, logger });
    return {
      queuePath,
      contractId: contract.id,
      promoted: readyState.promoted === true && readyState.contractId === contract.id,
      active: readyState.active === true && readyState.contractId === contract.id,
      readyState,
    };
  });
}

// Boot-time rehydrate: scan persisted queue dirs for every configured agent
// and re-register pending signals so the heartbeat gate reflects persistent
// truth immediately after restart. Agents are scanned in parallel.
export async function rehydrateRuntimeDirectEnvelopePendingSignals({ logger = null } = {}) {
  const agents = listRuntimeAgentIds().map((agentId) => ({
    agentId,
    inboxDir: join(agentWorkspace(agentId), "inbox"),
  }));
  const counts = await Promise.all(agents.map(async ({ agentId, inboxDir }) => {
    let local = 0;
    try {
      const queuedFiles = await listQueuedContracts(inboxDir);
      for (const file of queuedFiles) {
        const parsed = parseQueuedContractFile(file) || { contractId: file.replace(/^contract-/, "").replace(/\.json$/, "") };
        registerPendingSignal({
          agentId,
          sourceKind: PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE,
          sourceRef: parsed.contractId,
          envelopeId: parsed.contractId,
        });
        local += 1;
      }
      const activeContract = await readActiveInboxContract(inboxDir);
      if (isDirectRequestEnvelope(activeContract)) {
        registerPendingSignal({
          agentId,
          sourceKind: PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE,
          sourceRef: activeContract.id,
          envelopeId: activeContract.id,
          envelope: activeContract,
        });
        local += 1;
      }
    } catch (error) {
      logger?.warn?.(`[runtime_direct_envelope_queue] rehydrate failed for ${agentId}: ${error?.message || error}`);
    }
    return local;
  }));
  const registered = counts.reduce((sum, n) => sum + n, 0);
  if (registered > 0) {
    logger?.info?.(`[runtime_direct_envelope_queue] rehydrated ${registered} pending signals`);
  }
  return { registered };
}
