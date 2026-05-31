import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { agentWorkspace, dispatchTargetStateMap, sseClients, OC, apiRef, setApiRef } from "../lib/state.js";
import { cfg } from "../lib/state.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import {
  dispatchSendDirectRequest,
  dispatchSendExecutionContract,
} from "../lib/routing/dispatch-transport.js";
import { routeInbox } from "../runtime-mailbox.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { evictContractSnapshotByPath } from "../lib/store/contract-store.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import {
  listDispatchTargetIds,
  syncDispatchTargets,
  syncDispatchTargetsFromRuntime,
} from "../lib/routing/dispatch-runtime-state.js";
import {
  clearTrackingStore,
  rememberTrackingState,
} from "../lib/store/tracker-store.js";
import { runtimeAgentConfigs } from "../lib/state.js";
import { SYSTEM_ACTION_DELIVERY_IDS } from "../lib/routing/delivery-protocols.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { cleanupAgentEndTransport } from "../lib/lifecycle/agent-end-transport.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";
import { createDirectRequestEnvelope } from "../lib/protocol-primitives.js";
import {
  ensureRuntimeDirectEnvelopeInbox,
  enqueueRuntimeDirectEnvelope,
  rehydrateRuntimeDirectEnvelopePendingSignals,
} from "../lib/runtime-direct-envelope-queue.js";
import {
  clearAllPendingSignals,
  listPendingSignals,
  PENDING_SIGNAL_KINDS,
  registerPendingSignal,
} from "../lib/runtime/pending-signal-registry.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";
const logger = {
  info() {},
  warn() {},
  error() {},
};

function registerTestRuntimeAgent(agentId, overrides = {}) {
  runtimeAgentConfigs.set(agentId, {
    id: agentId,
    role: "executor",
    gateway: false,
    ingressSource: null,
    specialized: false,
    skills: [],
    ...overrides,
  });
}

async function withTestGraph(edges, fn) {
  return runGlobalTestEnvironmentSerial(async () => {
    const snapshot = await snapshotFile(CONTROL_PLANE_PATHS.agentGraphFile);
    await mkdir(dirname(CONTROL_PLANE_PATHS.agentGraphFile), { recursive: true });
    await writeFile(CONTROL_PLANE_PATHS.agentGraphFile, JSON.stringify({ edges }, null, 2), "utf8");
    try {
      return await fn();
    } finally {
      await restoreFile(CONTROL_PLANE_PATHS.agentGraphFile, snapshot);
    }
  });
}

function captureSseEvents() {
  const events = [];
  const client = {
    finished: false,
    destroyed: false,
    write(payload) {
      const eventMatch = String(payload).match(/^event:\s*(.+)$/m);
      const dataMatch = String(payload).match(/^data:\s*(.+)$/m);
      if (!eventMatch || !dataMatch) return;
      events.push({
        event: eventMatch[1],
        data: JSON.parse(dataMatch[1]),
      });
    },
  };
  sseClients.add(client);
  return {
    events,
    close() {
      sseClients.delete(client);
    },
  };
}

function buildContract(id, envelope = "direct_request") {
  return {
    id,
    task: `task for ${id}`,
    protocol: {
      version: 1,
      envelope,
    },
  };
}

async function snapshotFile(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function restoreFile(filePath, snapshot) {
  if (snapshot === null) {
    await unlink(filePath).catch(() => {});
    return;
  }
  await writeFile(filePath, snapshot);
}

async function primeRuntimeAgents() {
  const config = JSON.parse(await readFile(join(OC, "openclaw.json"), "utf8"));
  registerRuntimeAgents(config);
  return config;
}

async function resolveConfiguredWorkerId(config) {
  void config;
  await syncDispatchTargetsFromRuntime(logger);
  let workerId = listDispatchTargetIds().find(
    (agentId) => runtimeAgentConfigs.get(agentId)?.role === "executor",
  ) || null;
  if (!workerId) {
    const fallbackWorkerId = [...runtimeAgentConfigs.values()]
      .find((agent) => agent?.role === "executor")?.id || null;
    assert.ok(fallbackWorkerId, "expected at least one configured executor agent");
    await syncDispatchTargets([fallbackWorkerId], logger);
    workerId = listDispatchTargetIds().find(
      (agentId) => runtimeAgentConfigs.get(agentId)?.role === "executor",
    ) || fallbackWorkerId;
  }
  assert.ok(workerId, "expected at least one configured worker dispatch target");
  return workerId;
}

test("dispatchSendDirectRequest promotes active inbox, wakes target, and emits inbox_dispatch", async () => {
  const inboxDir = join(tmpdir(), `openclaw-conveyor-${Date.now()}-active`);
  const contract = buildContract(`TC-CONVEYOR-ACTIVE-${Date.now()}`);
  const sse = captureSseEvents();
  const wakeCalls = [];

  await mkdir(inboxDir, { recursive: true });

  try {
    registerTestRuntimeAgent("researcher");
    const result = await withTestGraph([{ from: "worker-runtime", to: "researcher" }], () => {
      return dispatchSendDirectRequest({
        targetAgent: "researcher",
        inboxDir,
        contract,
        from: "worker-runtime",
        logger,
        wakeupFunc: async (targetAgent, wakeOptions = {}) => {
          wakeCalls.push({ targetAgent, wakeOptions });
          return { ok: true, mode: "test" };
        },
        wakePayload: {
          sessionKey: "agent:researcher:contract:TC-CONVEYOR-ACTIVE",
        },
        dispatchAlert: {
          route: "loop",
          stageName: "researcher",
        },
      });
    });

    assert.equal(result.enqueueResult.promoted, true);
    assert.equal(result.enqueueResult.active, true);
    assert.equal(wakeCalls.length, 1);
    assert.equal(wakeCalls[0].targetAgent, "researcher");
    assert.equal(wakeCalls[0].wakeOptions.sessionKey, "agent:researcher:contract:TC-CONVEYOR-ACTIVE");

    const activeInbox = JSON.parse(await readFile(join(inboxDir, "contract.json"), "utf8"));
    assert.equal(activeInbox.id, contract.id);

    const dispatchEvent = sse.events.find(
      (entry) => entry.event === "alert" && entry.data?.type === "inbox_dispatch",
    );
    assert.equal(dispatchEvent?.data?.contractId, contract.id);
    assert.equal(dispatchEvent?.data?.from, "worker-runtime");
    assert.equal(dispatchEvent?.data?.assignee, "researcher");
    assert.equal(dispatchEvent?.data?.route, "loop");
    assert.equal(dispatchEvent?.data?.stageName, "researcher");
  } finally {
    sse.close();
    await rm(inboxDir, { recursive: true, force: true });
  }
});

test("dispatchSendDirectRequest queues when inbox is occupied and skips wake", async () => {
  const inboxDir = join(tmpdir(), `openclaw-conveyor-${Date.now()}-queued`);
  const contract = buildContract(`TC-CONVEYOR-QUEUED-${Date.now()}`);
  let wakeCount = 0;

  await mkdir(inboxDir, { recursive: true });
  await writeFile(
    join(inboxDir, "contract.json"),
    JSON.stringify(buildContract(`TC-EXISTING-${Date.now()}`, "execution_contract"), null, 2),
    "utf8",
  );

  try {
    registerTestRuntimeAgent("researcher");
    const result = await withTestGraph([{ from: "worker-runtime", to: "researcher" }], () => {
      return dispatchSendDirectRequest({
        targetAgent: "researcher",
        inboxDir,
        contract,
        from: "worker-runtime",
        logger,
        wakeupFunc: async () => {
          wakeCount++;
          return { ok: true };
        },
      });
    });

    assert.equal(result.enqueueResult.promoted, false);
    assert.equal(result.enqueueResult.active, false);
    assert.equal(wakeCount, 0);

    const queueDir = join(inboxDir, ".runtime-direct-envelope-queue");
    const queuedFiles = await readdir(queueDir);
    assert.equal(queuedFiles.length, 1);
    assert.match(queuedFiles[0], new RegExp(contract.id));
  } finally {
    await rm(inboxDir, { recursive: true, force: true });
  }
});

test("runtime direct envelope queue does not promote non-direct queued contracts", async () => {
  const inboxDir = join(tmpdir(), `openclaw-conveyor-${Date.now()}-non-direct-queue`);
  const activeContract = buildContract(`TC-ACTIVE-${Date.now()}`, "execution_contract");
  const nonDirectQueuedContract = buildContract(`TC-NON-DIRECT-${Date.now()}`, "execution_contract");

  await mkdir(inboxDir, { recursive: true });
  await writeFile(join(inboxDir, "contract.json"), JSON.stringify(activeContract, null, 2), "utf8");

  try {
    await enqueueRuntimeDirectEnvelope({
      inboxDir,
      contract: nonDirectQueuedContract,
      agentId: "researcher",
      logger,
    });
    await rm(join(inboxDir, "contract.json"), { force: true });

    const result = await ensureRuntimeDirectEnvelopeInbox({
      inboxDir,
      agentId: "researcher",
      logger,
    });

    assert.equal(result.active, false);
    assert.equal(result.promoted, false);
    assert.equal(result.source, "queue_empty");
    await assert.rejects(readFile(join(inboxDir, "contract.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(inboxDir, { recursive: true, force: true });
  }
});

test("runtime direct envelope queue rejects non-direct contracts before persistence", async () => {
  const inboxDir = join(tmpdir(), `openclaw-conveyor-${Date.now()}-non-direct-reject`);
  const nonDirectQueuedContract = buildContract(`TC-NON-DIRECT-REJECT-${Date.now()}`, "execution_contract");

  await mkdir(inboxDir, { recursive: true });

  try {
    const result = await enqueueRuntimeDirectEnvelope({
      inboxDir,
      contract: nonDirectQueuedContract,
      agentId: "researcher",
      logger,
    });

    assert.equal(result.enqueued, false);
    assert.equal(result.rejected, true);
    assert.equal(result.reason, "non_direct_request_envelope");
    await assert.rejects(readdir(join(inboxDir, ".runtime-direct-envelope-queue")), /ENOENT/);
  } finally {
    await rm(inboxDir, { recursive: true, force: true });
  }
});

test("runtime direct envelope queue serializes enqueue and promotion per inbox", async () => {
  const source = await readFile(
    new URL("../lib/runtime-direct-envelope-queue.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /withLock/);
  assert.match(source, /runtime-direct-envelope-inbox:/);
});

test("runtime direct envelope queue clears pending signal when queued envelope is promoted", async () => {
  const agentId = `runtime-direct-signal-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);
  const inboxDir = join(workspaceDir, "inbox");
  const outputDir = join(workspaceDir, "output");
  const activeContract = buildContract(`TC-ACTIVE-${Date.now()}`, "execution_contract");
  const targetSessionKey = `agent:${agentId}:hook:${Date.now()}`;
  const directEnvelope = createDirectRequestEnvelope({
    agentId,
    sessionKey: targetSessionKey,
    replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    returnContext: {
      sourceAgentId: agentId,
      sourceSessionKey: targetSessionKey,
      intentType: "create_task",
    },
    message: "resume direct service session",
    outputDir,
    source: "create_task",
  });

  await mkdir(inboxDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(inboxDir, "contract.json"), JSON.stringify(activeContract, null, 2), "utf8");

  try {
    clearAllPendingSignals();
    registerTestRuntimeAgent(agentId);
    const queued = await enqueueRuntimeDirectEnvelope({
      inboxDir,
      contract: directEnvelope,
      agentId,
      logger,
    });
    assert.equal(queued.promoted, false);
    assert.equal(
      listPendingSignals(agentId).some((entry) => (
        entry.sourceKind === PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE
        && entry.sourceRef === directEnvelope.id
      )),
      true,
    );

    await rm(join(inboxDir, "contract.json"), { force: true });
    const promoted = await ensureRuntimeDirectEnvelopeInbox({
      inboxDir,
      agentId,
      logger,
    });

    assert.equal(promoted.promoted, true);
    assert.equal(promoted.contractId, directEnvelope.id);
    assert.equal(
      listPendingSignals(agentId).some((entry) => entry.sourceRef === directEnvelope.id),
      false,
    );
  } finally {
    clearAllPendingSignals();
    runtimeAgentConfigs.delete(agentId);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("runtime direct envelope queue clears rehydrated active envelope signal when consumed", async () => {
  const agentId = `runtime-direct-active-signal-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);
  const inboxDir = join(workspaceDir, "inbox");
  const outputDir = join(workspaceDir, "output");
  const targetSessionKey = `agent:${agentId}:hook:${Date.now()}`;
  const directEnvelope = createDirectRequestEnvelope({
    agentId,
    sessionKey: targetSessionKey,
    replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    returnContext: {
      sourceAgentId: agentId,
      sourceSessionKey: targetSessionKey,
      intentType: "create_task",
    },
    message: "active direct service session",
    outputDir,
    source: "create_task",
  });

  try {
    clearAllPendingSignals();
    registerTestRuntimeAgent(agentId);
    await mkdir(inboxDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(directEnvelope, null, 2), "utf8");

    const rehydrated = await rehydrateRuntimeDirectEnvelopePendingSignals({ logger });
    assert.equal(rehydrated.registered >= 1, true);
    assert.equal(listPendingSignals(agentId).some((entry) => entry.sourceRef === directEnvelope.id), true);

    const active = await ensureRuntimeDirectEnvelopeInbox({ inboxDir, agentId, logger });
    assert.equal(active.active, true);
    assert.equal(active.source, "active_contract");

    assert.equal(
      listPendingSignals(agentId).some((entry) => entry.sourceRef === directEnvelope.id),
      false,
    );
  } finally {
    clearAllPendingSignals();
    runtimeAgentConfigs.delete(agentId);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("runtime direct envelope queue clears stale pending signal when queued file is invalid", async () => {
  const agentId = `runtime-direct-invalid-signal-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);
  const inboxDir = join(workspaceDir, "inbox");
  const queueDir = join(inboxDir, ".runtime-direct-envelope-queue");
  const staleEnvelopeId = `DIRECT-STALE-${Date.now()}`;

  try {
    clearAllPendingSignals();
    registerTestRuntimeAgent(agentId);
    await mkdir(queueDir, { recursive: true });
    await writeFile(
      join(queueDir, `contract-${Date.now()}-000000-${staleEnvelopeId}.json`),
      "{ invalid json",
      "utf8",
    );
    registerPendingSignal({
      agentId,
      sourceKind: PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE,
      sourceRef: staleEnvelopeId,
      envelopeId: staleEnvelopeId,
    });
    assert.equal(listPendingSignals(agentId).some((entry) => entry.sourceRef === staleEnvelopeId), true);

    const result = await ensureRuntimeDirectEnvelopeInbox({ inboxDir, agentId, logger });
    assert.equal(result.active, false);
    assert.equal(result.source, "queue_empty");
    assert.deepEqual(await readdir(queueDir), []);
    assert.equal(listPendingSignals(agentId).some((entry) => entry.sourceRef === staleEnvelopeId), false);
  } finally {
    clearAllPendingSignals();
    runtimeAgentConfigs.delete(agentId);
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("cleanupAgentEndTransport promotes queued direct envelope and exact-session wakes it", async () => {
  const agentId = `runtime-queue-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);
  const inboxDir = join(workspaceDir, "inbox");
  const outputDir = join(workspaceDir, "output");
  const activeContract = buildContract(`TC-ACTIVE-${Date.now()}`, "execution_contract");
  const targetSessionKey = `agent:${agentId}:hook:${Date.now()}`;
  const directEnvelope = createDirectRequestEnvelope({
    agentId,
    sessionKey: targetSessionKey,
    replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    returnContext: {
      sourceAgentId: agentId,
      sourceSessionKey: targetSessionKey,
      intentType: "create_task",
    },
    message: "resume direct service session",
    outputDir,
    source: "create_task",
  });
  const originalHooksToken = cfg.hooksToken;
  const heartbeatCalls = [];

  await mkdir(inboxDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(inboxDir, "contract.json"), JSON.stringify(activeContract, null, 2), "utf8");

  try {
    cfg.hooksToken = "";
    registerTestRuntimeAgent(agentId);

    const queued = await withTestGraph([{ from: "worker-runtime", to: agentId }], () => {
      return dispatchSendDirectRequest({
        targetAgent: agentId,
        inboxDir,
        contract: directEnvelope,
        from: "worker-runtime",
        logger,
        wakeupFunc: async () => {
          throw new Error("queued direct envelope should not wake before promotion");
        },
      });
    });

    assert.equal(queued.enqueueResult.promoted, false);

    await cleanupAgentEndTransport({
      agentId,
      api: {
        runtime: {
          system: {
            requestHeartbeatNow(payload) {
              heartbeatCalls.push(payload);
            },
          },
        },
      },
      logger,
    });

    assert.equal(heartbeatCalls.length, 1);
    assert.equal(heartbeatCalls[0]?.agentId, agentId);
    assert.equal(heartbeatCalls[0]?.sessionKey, targetSessionKey);
    assert.equal(
      heartbeatCalls[0]?.reason,
      "继续当前用户会话。",
    );
    assert.doesNotMatch(heartbeatCalls[0]?.reason || "", /inbox\/contract\.json/);

    const activeInbox = JSON.parse(await readFile(join(inboxDir, "contract.json"), "utf8"));
    assert.equal(activeInbox.id, directEnvelope.id);
  } finally {
    cfg.hooksToken = originalHooksToken;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("cleanupAgentEndTransport preserves inbox when a later contract already owns it", async () => {
  const agentId = `runtime-cleanup-owner-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);
  const inboxDir = join(workspaceDir, "inbox");
  const oldContract = buildContract(`TC-OLD-${Date.now()}`, "execution_contract");
  const newContract = buildContract(`TC-NEW-${Date.now()}`, "execution_contract");

  await mkdir(inboxDir, { recursive: true });
  await writeFile(join(inboxDir, "contract.json"), JSON.stringify(newContract, null, 2), "utf8");

  try {
    const result = await cleanupAgentEndTransport({
      agentId,
      logger,
      trackingState: {
        contract: {
          id: oldContract.id,
        },
      },
    });

    assert.equal(result.cleaned, false);
    assert.equal(result.preserved, true);
    assert.equal(result.preserveReason, "different_contract");

    const activeInbox = JSON.parse(await readFile(join(inboxDir, "contract.json"), "utf8"));
    assert.equal(activeInbox.id, newContract.id);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("dispatchSendExecutionContract derives execution-contract wake text when caller does not provide one", async () => {
  const config = await primeRuntimeAgents();
  const workerId = await resolveConfiguredWorkerId(config);
  const contractId = `TC-CONVEYOR-DEFAULT-WAKE-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const workerInboxPath = join(agentWorkspace(workerId), "inbox", "contract.json");
  const originalWorkerInbox = await snapshotFile(workerInboxPath);
  const heartbeatCalls = [];

  await mkdir(join(agentWorkspace(workerId), "inbox"), { recursive: true });

  try {
    await unlink(workerInboxPath).catch(() => {});
    await persistContractSnapshot(contractPath, {
      id: contractId,
      task: "derive default execution wake semantics",
      assignee: null,
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phases: [],
      total: 1,
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
    }, logger);
    dispatchTargetStateMap.set(workerId, {
      busy: true,
      healthy: true,
      dispatching: true,
      lastSeen: Date.now(),
      currentContract: contractId,
      queue: [],
    });

    const result = await withTestGraph([{ from: "worker-runtime", to: workerId }], () => {
      return dispatchSendExecutionContract({
        contractId,
        targetAgent: workerId,
        logger,
        api: {
          runtime: {
            system: {
              requestHeartbeatNow(payload) {
                heartbeatCalls.push(payload);
              },
            },
          },
        },
        updateContract(contract) {
          if (contract.assignee === workerId) return false;
          contract.assignee = workerId;
        },
        from: "worker-runtime",
      });
    });

    assert.equal(result.ok, true);
    assert.equal(heartbeatCalls.length, 1);
    assert.equal(heartbeatCalls[0]?.reason, "继续处理当前任务。");
  } finally {
    runtimeAgentConfigs.clear();
    dispatchTargetStateMap.delete(workerId);
    await unlink(contractPath).catch(() => {});
    await restoreFile(workerInboxPath, originalWorkerInbox);
  }
});

test("dispatchSendDirectRequest no longer treats legacy pool source as an internal exemption", async () => {
  const inboxDir = join(tmpdir(), `openclaw-conveyor-${Date.now()}-legacy-pool`);
  const contract = buildContract(`TC-CONVEYOR-LEGACY-POOL-${Date.now()}`);

  await mkdir(inboxDir, { recursive: true });

  try {
    registerTestRuntimeAgent("researcher");
    const result = await dispatchSendDirectRequest({
      targetAgent: "researcher",
      inboxDir,
      contract,
      from: "pool",
      logger,
      wakeupFunc: async () => ({ ok: true, mode: "test" }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.match(result.blockReason || "", /no graph edge from pool to researcher/);
  } finally {
    await rm(inboxDir, { recursive: true, force: true });
  }
});

test("dispatchSendDirectRequest can suppress inbox_dispatch alert for non-frontend transport callers", async () => {
  const inboxDir = join(tmpdir(), `openclaw-conveyor-${Date.now()}-silent`);
  const contract = buildContract(`TC-CONVEYOR-SILENT-${Date.now()}`);
  const sse = captureSseEvents();

  await mkdir(inboxDir, { recursive: true });

  try {
    registerTestRuntimeAgent("worker-a");
    const result = await withTestGraph([{ from: "system", to: "worker-a" }], () => {
      return dispatchSendDirectRequest({
        targetAgent: "worker-a",
        inboxDir,
        contract,
        from: "system",
        logger,
        broadcastDispatch: false,
        wakeupFunc: async () => ({ ok: true, mode: "test" }),
      });
    });

    assert.equal(result.enqueueResult.promoted, true);
    const dispatchEvent = sse.events.find(
      (entry) => entry.event === "alert" && entry.data?.type === "inbox_dispatch",
    );
    assert.equal(dispatchEvent, undefined);
  } finally {
    sse.close();
    await rm(inboxDir, { recursive: true, force: true });
  }
});

test("transport graph bypass requires explicit runtime authority", async () => {
  const inboxDir = join(tmpdir(), `openclaw-conveyor-${Date.now()}-authority`);
  const contract = buildContract(`TC-CONVEYOR-AUTHORITY-${Date.now()}`);
  await mkdir(inboxDir, { recursive: true });

  try {
    registerTestRuntimeAgent("researcher");
    const forged = await withTestGraph([], () => dispatchSendDirectRequest({
      targetAgent: "researcher",
      inboxDir,
      contract,
      from: "worker-runtime",
      logger,
      wakeupFunc: async () => ({ ok: true, mode: "test" }),
    }));
    assert.equal(forged.ok, false);
    assert.equal(forged.blocked, true);
    assert.match(forged.blockReason || "", /no graph edge from worker-runtime to researcher/);

    const emptyAuthority = await withTestGraph([], () => dispatchSendDirectRequest({
      targetAgent: "researcher",
      inboxDir,
      contract: buildContract(`TC-CONVEYOR-AUTHORITY-EMPTY-${Date.now()}`),
      from: "",
      runtimeAuthority: {
        kind: "system_action_delivery",
        deliveryId: "",
      },
      logger,
      wakeupFunc: async () => ({ ok: true, mode: "test" }),
    }));
    assert.equal(emptyAuthority.ok, false);
    assert.equal(emptyAuthority.blocked, true);
    assert.match(emptyAuthority.blockReason || "", /no graph edge/);

    const forgedTarget = await withTestGraph([], () => dispatchSendDirectRequest({
      targetAgent: "researcher",
      inboxDir,
      contract: buildContract(`TC-CONVEYOR-AUTHORITY-FORGED-TARGET-${Date.now()}`),
      from: SYSTEM_ACTION_DELIVERY_IDS.RUNTIME_RESULT,
      runtimeAuthority: {
        kind: "system_action_delivery",
        deliveryId: SYSTEM_ACTION_DELIVERY_IDS.RUNTIME_RESULT,
        targetAgent: "other-agent",
      },
      logger,
      wakeupFunc: async () => ({ ok: true, mode: "test" }),
    }));
    assert.equal(forgedTarget.ok, false);
    assert.equal(forgedTarget.blocked, true);
    assert.match(forgedTarget.blockReason || "", /no graph edge/);

    const authorized = await dispatchSendDirectRequest({
      targetAgent: "researcher",
      inboxDir,
      contract: buildContract(`TC-CONVEYOR-AUTHORITY-OK-${Date.now()}`),
      from: SYSTEM_ACTION_DELIVERY_IDS.RUNTIME_RESULT,
      runtimeAuthority: {
        kind: "system_action_delivery",
        deliveryId: SYSTEM_ACTION_DELIVERY_IDS.RUNTIME_RESULT,
        targetAgent: "researcher",
      },
      logger,
      wakeupFunc: async () => ({ ok: true, mode: "test" }),
    });
    assert.equal(authorized.ok, true);
    assert.equal(authorized.blocked, false);
  } finally {
    await rm(inboxDir, { recursive: true, force: true });
  }
});

test("bridge-origin direct transport still requires a graph edge", async () => {
  const inboxDir = join(tmpdir(), `openclaw-conveyor-${Date.now()}-bridge-no-edge`);
  const contract = buildContract(`TC-CONVEYOR-BRIDGE-NO-EDGE-${Date.now()}`);
  await mkdir(inboxDir, { recursive: true });

  try {
    registerTestRuntimeAgent("controller", { role: "bridge", gateway: true, ingressSource: "webui" });
    registerTestRuntimeAgent("researcher");
    const result = await withTestGraph([], () => dispatchSendDirectRequest({
      targetAgent: "researcher",
      inboxDir,
      contract,
      from: "controller",
      logger,
      wakeupFunc: async () => ({ ok: true, mode: "test" }),
    }));

    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.match(result.blockReason || "", /no graph edge from controller to researcher/);
    await assert.rejects(
      readFile(join(inboxDir, "contract.json"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await rm(inboxDir, { recursive: true, force: true });
  }
});

test("dispatchSendExecutionContract stages shared contract into worker inbox, wakes worker, and emits inbox_dispatch", async () => {
  const workerId = `conveyor-worker-${Date.now()}`;
  const workspace = join(tmpdir(), `openclaw-${workerId}`);
  const contractId = `TC-CONVEYOR-DISPATCH-RUNTIME-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  registerTestRuntimeAgent(workerId, { workspace });
  const workerInboxPath = join(agentWorkspace(workerId), "inbox", "contract.json");
  const originalWorkerInbox = await snapshotFile(workerInboxPath);
  const sse = captureSseEvents();
  const wakeCalls = [];

  await mkdir(join(agentWorkspace(workerId), "inbox"), { recursive: true });

  try {
    await unlink(workerInboxPath).catch(() => {});
    await persistContractSnapshot(contractPath, {
      id: contractId,
      task: "dispatch runtime conveyor regression",
      assignee: null,
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phases: [],
      total: 1,
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
    }, logger);
    dispatchTargetStateMap.set(workerId, {
      busy: true,
      healthy: true,
      dispatching: true,
      lastSeen: Date.now(),
      currentContract: contractId,
      queue: [],
    });

    const result = await withTestGraph([{ from: "worker-runtime", to: workerId }], () => {
      return dispatchSendExecutionContract({
        contractId,
        targetAgent: workerId,
        logger,
        wakeupFunc: async (targetAgent, wakeOptions = {}) => {
          wakeCalls.push({ targetAgent, wakeOptions });
          return { ok: true, mode: "test" };
        },
        wakePayload: {
          reason: "dispatch runtime dispatch regression",
        },
        updateContract(contract) {
          if (contract.assignee === workerId) return false;
          contract.assignee = workerId;
        },
        from: "worker-runtime",
      });
    });

    assert.equal(result.ok, true);
    assert.equal(wakeCalls.length, 1);
    assert.equal(wakeCalls[0].targetAgent, workerId);
    assert.equal(wakeCalls[0].wakeOptions.reason, "dispatch runtime dispatch regression");

    assert.equal(result.contract?.assignee, workerId);

    const workerInboxContract = JSON.parse(await readFile(workerInboxPath, "utf8"));
    assert.equal(workerInboxContract.id, contractId);
    assert.equal(workerInboxContract.assignee, workerId);

    const dispatchEvent = sse.events.find(
      (entry) => entry.event === "alert" && entry.data?.type === "inbox_dispatch",
    );
    assert.equal(dispatchEvent?.data?.contractId, contractId);
    assert.equal(dispatchEvent?.data?.assignee, workerId);
    assert.equal(dispatchEvent?.data?.from, "worker-runtime");
  } finally {
    sse.close();
    dispatchTargetStateMap.delete(workerId);
    runtimeAgentConfigs.delete(workerId);
    await unlink(contractPath).catch(() => {});
    await restoreFile(workerInboxPath, originalWorkerInbox);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("dispatchSendExecutionContract fails closed when no wake transport is available", async () => {
  const config = await primeRuntimeAgents();
  const workerId = await resolveConfiguredWorkerId(config);
  const contractId = `TC-CONVEYOR-NO-WAKE-TRANSPORT-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const workerInboxPath = join(agentWorkspace(workerId), "inbox", "contract.json");
  const originalWorkerInbox = await snapshotFile(workerInboxPath);
  const originalApiRef = apiRef;

  await mkdir(join(agentWorkspace(workerId), "inbox"), { recursive: true });

  try {
    setApiRef(null);
    await unlink(workerInboxPath).catch(() => {});
    await persistContractSnapshot(contractPath, {
      id: contractId,
      task: "shared contract must not silently skip wake transport",
      assignee: null,
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phases: [],
      total: 1,
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
    }, logger);

    const result = await withTestGraph([{ from: "worker-runtime", to: workerId }], () => {
      return dispatchSendExecutionContract({
        contractId,
        targetAgent: workerId,
        logger,
        api: null,
        updateContract(contract) {
          if (contract.assignee === workerId) return false;
          contract.assignee = workerId;
        },
        from: "worker-runtime",
      });
    });

    assert.equal(result.ok, false);
    assert.equal(result.wake?.ok, false);
    assert.equal(result.wake?.requested, false);
    assert.equal(result.wake?.reason, "missing_runtime_wake_transport");
  } finally {
    setApiRef(originalApiRef);
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await restoreFile(workerInboxPath, originalWorkerInbox);
  }
});

test("routeInbox does not restage a running worker contract while another live worker tracker already owns it", async () => {
  const config = await primeRuntimeAgents();
  const workerId = await resolveConfiguredWorkerId(config);
  const contractId = `TC-CONVEYOR-LIVE-TRACKER-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const inboxPath = join(agentWorkspace(workerId), "inbox", "contract.json");
  const originalInbox = await snapshotFile(inboxPath);

  clearTrackingStore();

  const contract = {
    id: contractId,
    task: "prevent duplicate worker heartbeat pickup",
    assignee: workerId,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    output: join(CONTROL_PLANE_PATHS.outputDir, `${contractId}.md`),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
    },
  };

  const trackingState = createTrackingState({
    sessionKey: `agent:${workerId}:hook:${contractId}`,
    agentId: workerId,
    parentSession: null,
  });
  trackingState.contract = {
    ...contract,
    path: contractPath,
  };

  await persistContractSnapshot(contractPath, contract, logger);
  await mkdir(join(agentWorkspace(workerId), "inbox"), { recursive: true });
  await writeFile(inboxPath, JSON.stringify(contract, null, 2), "utf8");
  rememberTrackingState(trackingState.sessionKey, trackingState);

  try {
    await routeInbox(workerId, logger);

    await assert.rejects(
      readFile(inboxPath, "utf8"),
      /ENOENT/,
      "worker inbox should be cleared while another live tracker already owns the running contract",
    );
  } finally {
    clearTrackingStore();
    await unlink(contractPath).catch(() => {});
    await restoreFile(inboxPath, originalInbox);
  }
});

test("routeInbox restages the pending worker contract for the same resumed session", async () => {
  const config = await primeRuntimeAgents();
  const workerId = await resolveConfiguredWorkerId(config);
  const contractId = `TC-CONVEYOR-RESUME-SAME-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const inboxPath = join(agentWorkspace(workerId), "inbox", "contract.json");
  const originalInbox = await snapshotFile(inboxPath);

  clearTrackingStore();

  const contract = {
    id: contractId,
    task: "resume same-session worker contract",
    assignee: workerId,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    output: join(CONTROL_PLANE_PATHS.outputDir, `${contractId}.md`),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
    },
  };

  const trackingState = createTrackingState({
    sessionKey: `agent:${workerId}:hook:${contractId}`,
    agentId: workerId,
    parentSession: null,
  });
  trackingState.contract = {
    ...contract,
    path: contractPath,
  };

  await persistContractSnapshot(contractPath, contract, logger);
  await mkdir(join(agentWorkspace(workerId), "inbox"), { recursive: true });
  await unlink(inboxPath).catch(() => {});
  rememberTrackingState(trackingState.sessionKey, trackingState);

  try {
    await routeInbox(workerId, logger, { sessionKey: trackingState.sessionKey });

    const staged = JSON.parse(await readFile(inboxPath, "utf8"));
    assert.equal(
      staged.id,
      contractId,
      "worker inbox should be restaged when the running tracker belongs to the same resumed session",
    );
  } finally {
    clearTrackingStore();
    await unlink(contractPath).catch(() => {});
    await restoreFile(inboxPath, originalInbox);
  }
});

test("routeInbox exact contract hint stages despite unrelated unclaimed running tracker", async () => {
  const config = await primeRuntimeAgents();
  const workerId = await resolveConfiguredWorkerId(config);
  const ghostContractId = `TC-CONVEYOR-GHOST-${Date.now()}`;
  const contractId = `TC-CONVEYOR-EXACT-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const inboxPath = join(agentWorkspace(workerId), "inbox", "contract.json");
  const originalInbox = await snapshotFile(inboxPath);

  clearTrackingStore();

  const contract = {
    id: contractId,
    task: "exact hint must own staging even when a prior claim left an unbound tracker",
    assignee: workerId,
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    output: join(CONTROL_PLANE_PATHS.outputDir, `${contractId}.md`),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
    },
  };

  const ghostTrackingState = createTrackingState({
    sessionKey: `agent:${workerId}:contract:${ghostContractId.toLowerCase()}`,
    agentId: workerId,
    parentSession: null,
  });

  await persistContractSnapshot(contractPath, contract, logger);
  await mkdir(join(agentWorkspace(workerId), "inbox"), { recursive: true });
  await unlink(inboxPath).catch(() => {});
  dispatchTargetStateMap.set(workerId, {
    busy: true,
    healthy: true,
    dispatching: false,
    lastSeen: Date.now(),
    currentContract: contractId,
    queue: [],
  });
  rememberTrackingState(ghostTrackingState.sessionKey, ghostTrackingState);

  try {
    await routeInbox(workerId, logger, {
      sessionKey: `agent:${workerId}:contract:${contractId.toLowerCase()}`,
      contractIdHint: contractId.toLowerCase(),
      contractPathHint: getContractPath(contractId.toLowerCase()),
    });

    const staged = JSON.parse(await readFile(inboxPath, "utf8"));
    assert.equal(
      staged.id,
      contractId,
      "exact contract dispatch should stage the target contract instead of being blocked by unclaimed tracker residue",
    );
  } finally {
    clearTrackingStore();
    dispatchTargetStateMap.delete(workerId);
    await unlink(contractPath).catch(() => {});
    await restoreFile(inboxPath, originalInbox);
  }
});

test("routeInbox exact contract hint does not overwrite another bound running tracker", async () => {
  const config = await primeRuntimeAgents();
  const workerId = await resolveConfiguredWorkerId(config);
  const activeContractId = `TC-CONVEYOR-BOUND-${Date.now()}`;
  const exactContractId = `TC-CONVEYOR-EXACT-BLOCKED-${Date.now()}`;
  const activeContractPath = getContractPath(activeContractId);
  const exactContractPath = getContractPath(exactContractId);
  const inboxPath = join(agentWorkspace(workerId), "inbox", "contract.json");
  const originalInbox = await snapshotFile(inboxPath);

  clearTrackingStore();

  const activeContract = {
    id: activeContractId,
    task: "already running work",
    assignee: workerId,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    output: join(CONTROL_PLANE_PATHS.outputDir, `${activeContractId}.md`),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
    },
  };
  const exactContract = {
    ...activeContract,
    id: exactContractId,
    task: "must stay queued until active tracker ends",
    status: CONTRACT_STATUS.PENDING,
    output: join(CONTROL_PLANE_PATHS.outputDir, `${exactContractId}.md`),
  };

  const activeTrackingState = createTrackingState({
    sessionKey: `agent:${workerId}:contract:${activeContractId.toLowerCase()}`,
    agentId: workerId,
    parentSession: null,
  });
  activeTrackingState.contract = {
    ...activeContract,
    path: activeContractPath,
  };

  await persistContractSnapshot(activeContractPath, activeContract, logger);
  await persistContractSnapshot(exactContractPath, exactContract, logger);
  await mkdir(join(agentWorkspace(workerId), "inbox"), { recursive: true });
  await writeFile(inboxPath, JSON.stringify(activeContract, null, 2), "utf8");
  rememberTrackingState(activeTrackingState.sessionKey, activeTrackingState);

  try {
    await routeInbox(workerId, logger, {
      sessionKey: `agent:${workerId}:contract:${exactContractId.toLowerCase()}`,
      contractIdHint: exactContractId.toLowerCase(),
      contractPathHint: getContractPath(exactContractId.toLowerCase()),
    });

    await assert.rejects(
      readFile(inboxPath, "utf8"),
      /ENOENT/,
      "exact dispatch should not overwrite an inbox while another bound tracker owns the agent",
    );
  } finally {
    clearTrackingStore();
    await unlink(activeContractPath).catch(() => {});
    await unlink(exactContractPath).catch(() => {});
    await restoreFile(inboxPath, originalInbox);
  }
});
