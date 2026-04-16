import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  agentWorkspace,
  dispatchTargetStateMap,
  runtimeAgentConfigs,
} from "../lib/state.js";
import {
  createTrackingState,
  bindInboxContractEnvelope,
  bindPendingWorkerContract,
} from "../lib/session-bootstrap.js";
import { routeInbox } from "../runtime-mailbox.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { evictContractSnapshotByPath } from "../lib/store/contract-store.js";
import { clearTrackingStore } from "../lib/store/tracker-store.js";
import { createDirectRequestEnvelope } from "../lib/protocol-primitives.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

function buildExecutionContract({
  contractId,
  assignee,
  createdAt,
  status = CONTRACT_STATUS.PENDING,
}) {
  return {
    id: contractId,
    task: `task for ${contractId}`,
    assignee,
    status,
    createdAt,
    updatedAt: createdAt,
    output: join(tmpdir(), `${contractId}.md`),
    protocol: {
      version: 1,
      envelope: "execution_contract",
    },
  };
}

async function removeContractSnapshot(contractId) {
  const contractPath = getContractPath(contractId);
  await unlink(contractPath).catch(() => {});
  evictContractSnapshotByPath(contractPath);
}

async function withTempExecutor(callback) {
  const agentId = `worker-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const workspace = join(tmpdir(), `openclaw-${agentId}`);
  runtimeAgentConfigs.set(agentId, {
    id: agentId,
    role: "executor",
    workspace,
  });
  await mkdir(join(workspace, "inbox"), { recursive: true });

  try {
    return await callback({ agentId, workspace, inboxPath: join(workspace, "inbox", "contract.json") });
  } finally {
    clearTrackingStore();
    dispatchTargetStateMap.delete(agentId);
    runtimeAgentConfigs.delete(agentId);
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

test("bindPendingWorkerContract prefers dispatch owner currentContract over shared scan order", async () => withTempExecutor(async ({ agentId }) => {
  const ownerContractId = `TC-OWNER-${Date.now()}`;
  const newerContractId = `TC-NEWER-${Date.now()}`;
  const ownerCreatedAt = Date.now() - 10_000;
  const newerCreatedAt = Date.now();

  await persistContractSnapshot(
    getContractPath(ownerContractId),
    buildExecutionContract({
      contractId: ownerContractId,
      assignee: agentId,
      createdAt: ownerCreatedAt,
    }),
    logger,
  );
  await persistContractSnapshot(
    getContractPath(newerContractId),
    buildExecutionContract({
      contractId: newerContractId,
      assignee: agentId,
      createdAt: newerCreatedAt,
    }),
    logger,
  );

  dispatchTargetStateMap.set(agentId, {
    busy: true,
    healthy: true,
    dispatching: false,
    lastSeen: Date.now(),
    currentContract: ownerContractId,
    queue: [{ contractId: newerContractId }],
  });

  const trackingState = createTrackingState({
    sessionKey: `agent:${agentId}:main`,
    agentId,
    parentSession: null,
  });

  try {
    const bound = await bindPendingWorkerContract({
      agentId,
      sessionKey: trackingState.sessionKey,
      trackingState,
      logger,
      logContext: "recovery session",
    });

    assert.equal(bound?.contract?.id, ownerContractId);
    assert.equal(trackingState.contract?.id, ownerContractId);
  } finally {
    await removeContractSnapshot(ownerContractId);
    await removeContractSnapshot(newerContractId);
  }
}));

test("routeInbox exact contract sessions clear stale inbox instead of falling back to another active contract", async () => withTempExecutor(async ({
  agentId,
  inboxPath,
}) => {
  const oldContractId = `TC-OLD-${Date.now()}`;
  const missingExactContractId = `TC-MISSING-${Date.now()}`;

  const oldContract = buildExecutionContract({
    contractId: oldContractId,
    assignee: agentId,
    createdAt: Date.now() - 5_000,
  });

  await persistContractSnapshot(getContractPath(oldContractId), oldContract, logger);
  await writeFile(inboxPath, JSON.stringify(oldContract, null, 2), "utf8");

  try {
    await routeInbox(agentId, logger, {
      sessionKey: `agent:${agentId}:contract:${missingExactContractId}`,
      contractIdHint: missingExactContractId,
      contractPathHint: getContractPath(missingExactContractId),
    });

    await assert.rejects(
      readFile(inboxPath, "utf8"),
      /ENOENT/,
      "exact contract claim miss should clear stale inbox instead of restaging another active contract",
    );
  } finally {
    await removeContractSnapshot(oldContractId);
  }
}));

test("exact contract hints still bind when runtime session key casing drifts from stored contract id", async () => withTempExecutor(async ({
  agentId,
  inboxPath,
}) => {
  const contractId = `TC-CASE-${Date.now()}`;
  const hintedContractId = contractId.toLowerCase();
  const contract = buildExecutionContract({
    contractId,
    assignee: agentId,
    createdAt: Date.now(),
  });

  await persistContractSnapshot(getContractPath(contractId), contract, logger);

  const trackingState = createTrackingState({
    sessionKey: `agent:${agentId}:contract:${hintedContractId}`,
    agentId,
    parentSession: null,
  });

  try {
    await routeInbox(agentId, logger, {
      sessionKey: trackingState.sessionKey,
      contractIdHint: hintedContractId,
      contractPathHint: getContractPath(hintedContractId),
    });

    const staged = JSON.parse(await readFile(inboxPath, "utf8"));
    assert.equal(staged.id, contractId);

    const bound = await bindInboxContractEnvelope({
      agentId,
      trackingState,
      logger,
      allowNonDirectRequest: true,
      requiredContractId: hintedContractId,
    });

    assert.equal(bound?.contract?.id, contractId);
    assert.equal(trackingState.contract?.id, contractId);
  } finally {
    await removeContractSnapshot(contractId);
  }
}));

test("exact contract sessions still bind direct_request return envelopes whose DIRECT id differs from the parent contract id", async () => withTempExecutor(async ({
  agentId,
  workspace,
  inboxPath,
}) => {
  const parentContractId = `TC-PARENT-${Date.now()}`;
  const hintedContractId = parentContractId.toLowerCase();
  const sessionKey = `agent:${agentId}:contract:${hintedContractId}`;

  await mkdir(join(workspace, "output"), { recursive: true });

  const directEnvelope = createDirectRequestEnvelope({
    agentId,
    sessionKey,
    replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    returnContext: {
      sourceAgentId: agentId,
      sourceContractId: parentContractId,
      sourceSessionKey: sessionKey,
      intentType: "create_task",
    },
    message: "resume queued direct request",
    outputDir: join(workspace, "output"),
    source: "create_task",
  });

  await writeFile(inboxPath, JSON.stringify(directEnvelope, null, 2), "utf8");

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });

  const bound = await bindInboxContractEnvelope({
    agentId,
    trackingState,
    logger,
    allowNonDirectRequest: true,
    requiredContractId: hintedContractId,
  });

  assert.equal(bound?.contract?.id, directEnvelope.id);
  assert.equal(trackingState.contract?.id, directEnvelope.id);
}));
