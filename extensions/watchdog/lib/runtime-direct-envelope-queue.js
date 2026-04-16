import { access, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./state.js";
import {
  cacheContractSnapshot,
  moveContractSnapshotPath,
  readContractSnapshotByPath,
} from "./store/contract-store.js";
import { isDirectRequestEnvelope } from "./protocol-primitives.js";

const RUNTIME_DIRECT_ENVELOPE_QUEUE_DIR = ".runtime-direct-envelope-queue";
let queueSequence = 0;

function getQueueDir(inboxDir) {
  return join(inboxDir, RUNTIME_DIRECT_ENVELOPE_QUEUE_DIR);
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

export async function ensureRuntimeDirectEnvelopeInbox({
  inboxDir,
  agentId = "agent",
  logger,
}) {
  const activeContract = await readActiveInboxContract(inboxDir);
  if (isDirectRequestEnvelope(activeContract)) {
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

  const queuePath = join(getQueueDir(inboxDir), queuedFiles[0]);
  const activePath = join(inboxDir, "contract.json");
  let queuedContractId = null;
  let queuedContract = null;
  try {
    queuedContract = await readContractSnapshotByPath(queuePath, { preferCache: false });
    queuedContractId = queuedContract?.id || null;
  } catch {}

  await rename(queuePath, activePath);
  moveContractSnapshotPath(queuePath, activePath);
  logger?.info?.(
    `[runtime_direct_envelope_queue] activated queued direct envelope ${queuedContractId || queuedFiles[0]} for ${agentId}`,
  );

  return {
    active: true,
    promoted: true,
    contractId: queuedContractId,
    contract: queuedContract || null,
    source: "runtime_queue",
  };
}

export async function enqueueRuntimeDirectEnvelope({
  inboxDir,
  contract,
  agentId = "agent",
  logger,
}) {
  const queueDir = getQueueDir(inboxDir);
  await mkdir(queueDir, { recursive: true });

  const sequence = String(queueSequence++).padStart(6, "0");
  const queuedAt = String(Date.now()).padStart(13, "0");
  const queuePath = join(queueDir, `contract-${queuedAt}-${sequence}-${contract.id}.json`);
  await atomicWriteFile(queuePath, JSON.stringify(contract, null, 2));
  cacheContractSnapshot(queuePath, contract);

  const readyState = await ensureRuntimeDirectEnvelopeInbox({ inboxDir, agentId, logger });
  return {
    queuePath,
    contractId: contract.id,
    promoted: readyState.promoted === true && readyState.contractId === contract.id,
    active: readyState.active === true && readyState.contractId === contract.id,
    readyState,
  };
}
