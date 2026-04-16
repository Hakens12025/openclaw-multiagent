import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { agentWorkspace, sseClients, OC } from "../lib/state.js";
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
import { createTrackingState } from "../lib/session-bootstrap.js";
import { cleanupAgentEndTransport } from "../lib/lifecycle/agent-end-transport.js";
import { createDirectRequestEnvelope } from "../lib/protocol-primitives.js";
const logger = {
  info() {},
  warn() {},
  error() {},
};

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
  let [workerId] = listDispatchTargetIds();
  if (!workerId) {
    const fallbackWorkerId = [...runtimeAgentConfigs.values()]
      .find((agent) => agent?.role === "executor")?.id || null;
    assert.ok(fallbackWorkerId, "expected at least one configured executor agent");
    await syncDispatchTargets([fallbackWorkerId], logger);
    [workerId] = listDispatchTargetIds();
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
    const result = await dispatchSendDirectRequest({
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
        sessionKey: "agent:researcher:pipeline:test",
      },
      dispatchAlert: {
        route: "loop",
        stageName: "researcher",
      },
    });

    assert.equal(result.enqueueResult.promoted, true);
    assert.equal(result.enqueueResult.active, true);
    assert.equal(wakeCalls.length, 1);
    assert.equal(wakeCalls[0].targetAgent, "researcher");
    assert.equal(wakeCalls[0].wakeOptions.sessionKey, "agent:researcher:pipeline:test");

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
    const result = await dispatchSendDirectRequest({
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

    const queued = await dispatchSendDirectRequest({
      targetAgent: agentId,
      inboxDir,
      contract: directEnvelope,
      from: "worker-runtime",
      logger,
      wakeupFunc: async () => {
        throw new Error("queued direct envelope should not wake before promotion");
      },
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

    const activeInbox = JSON.parse(await readFile(join(inboxDir, "contract.json"), "utf8"));
    assert.equal(activeInbox.id, directEnvelope.id);
  } finally {
    cfg.hooksToken = originalHooksToken;
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("dispatchSendDirectRequest no longer treats legacy pool source as an internal exemption", async () => {
  const inboxDir = join(tmpdir(), `openclaw-conveyor-${Date.now()}-legacy-pool`);
  const contract = buildContract(`TC-CONVEYOR-LEGACY-POOL-${Date.now()}`);

  await mkdir(inboxDir, { recursive: true });

  try {
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
    const result = await dispatchSendDirectRequest({
      targetAgent: "worker-a",
      inboxDir,
      contract,
      from: "system",
      logger,
      broadcastDispatch: false,
      wakeupFunc: async () => ({ ok: true, mode: "test" }),
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

test("dispatchSendExecutionContract stages shared contract into worker inbox, wakes worker, and emits inbox_dispatch", async () => {
  const config = await primeRuntimeAgents();
  const workerId = await resolveConfiguredWorkerId(config);
  const contractId = `TC-CONVEYOR-DISPATCH-RUNTIME-${Date.now()}`;
  const contractPath = getContractPath(contractId);
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

    const result = await dispatchSendExecutionContract({
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
    output: join(OC, "workspaces", "controller", "output", `${contractId}.md`),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
      route: "long",
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
    output: join(OC, "workspaces", "controller", "output", `${contractId}.md`),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
      route: "long",
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
