import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";

import { loadGraph, saveGraph } from "../lib/agent/agent-graph.js";
import * as state from "../lib/state.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { evictContractSnapshotByPath } from "../lib/store/contract-store.js";
import {
  buildDispatchRuntimeSnapshot,
  claimDispatchTargetContract,
  enqueueDispatchContract,
  getDispatchQueueDepth,
  getDispatchTargetCurrentContract,
  listDispatchTargetIds,
  removeDispatchContract,
  releaseDispatchTargetContract,
  syncDispatchTargets,
  syncDispatchTargetsFromRuntime,
} from "../lib/routing/dispatch-runtime-state.js";
import { reconcileDispatchRuntimeTruth } from "../lib/routing/dispatch-runtime-reconcile.js";
import { runGlobalTestEnvironmentSerial } from "./test-locks.js";

const logger = { info() {}, warn() {}, error() {} };
const { runtimeAgentConfigs, dispatchTargetStateMap } = state;

test("syncDispatchTargets adds new targets and prunes stale idle ones", async () => {
  dispatchTargetStateMap.clear();
  dispatchTargetStateMap.set("stale-idle", {
    busy: false, healthy: true, dispatching: false, lastSeen: 1, currentContract: null, queue: [],
  });

  await syncDispatchTargets(["worker-a", "worker-b"], logger);

  assert.equal(dispatchTargetStateMap.has("worker-a"), true);
  assert.equal(dispatchTargetStateMap.has("worker-b"), true);
  assert.equal(dispatchTargetStateMap.has("stale-idle"), false);
});

test("syncDispatchTargets preserves busy targets even if not in target list", async () => {
  dispatchTargetStateMap.clear();
  dispatchTargetStateMap.set("busy-worker", {
    busy: true, healthy: true, dispatching: false, lastSeen: 1, currentContract: "TC-1", queue: [],
  });

  await syncDispatchTargets(["worker-a"], logger);

  assert.equal(dispatchTargetStateMap.has("busy-worker"), true, "busy worker should not be pruned");
  assert.equal(dispatchTargetStateMap.has("worker-a"), true);
});

test("syncDispatchTargetsFromRuntime hydrates every configured dispatch role instead of only the executor lane", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousGraph = await loadGraph();
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  dispatchTargetStateMap.clear();

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("planner", { id: "planner", role: "planner" });
    runtimeAgentConfigs.set("worker-a", { id: "worker-a", role: "executor" });
    runtimeAgentConfigs.set("reviewer-a", { id: "reviewer-a", role: "reviewer" });
    await saveGraph({
      edges: [
        { from: "planner", to: "worker-a", label: "assign" },
        { from: "worker-a", to: "reviewer-a", label: "review" },
      ],
    });

    await syncDispatchTargetsFromRuntime(logger);

    assert.deepEqual(listDispatchTargetIds().sort(), ["planner", "reviewer-a", "worker-a"]);
  } finally {
    dispatchTargetStateMap.clear();
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await saveGraph(previousGraph);
  }
}));

test("claimDispatchTargetContract marks target busy and removes queued contract", async () => {
  dispatchTargetStateMap.clear();
  dispatchTargetStateMap.set("worker-a", {
    busy: false, healthy: true, dispatching: true, lastSeen: 1, currentContract: null, queue: ["TC-1"],
  });

  await claimDispatchTargetContract({ contractId: "TC-1", agentId: "worker-a", logger });

  const state = dispatchTargetStateMap.get("worker-a");
  assert.equal(state.busy, true);
  assert.equal(state.dispatching, false);
  assert.equal(state.currentContract, "TC-1");
  assert.equal(Array.isArray(state.queue), true);
  assert.equal(state.queue.length, 0);
});

test("releaseDispatchTargetContract clears target state", async () => {
  dispatchTargetStateMap.clear();
  dispatchTargetStateMap.set("worker-a", {
    busy: true, healthy: true, dispatching: false, lastSeen: 1, currentContract: "TC-1", queue: [],
  });

  await releaseDispatchTargetContract({ agentId: "worker-a", logger });

  const state = dispatchTargetStateMap.get("worker-a");
  assert.equal(state.busy, false);
  assert.equal(state.dispatching, false);
  assert.equal(state.currentContract, null);
});

test("removeDispatchContract releases busy current owner and prunes queued copies", async () => {
  dispatchTargetStateMap.clear();
  dispatchTargetStateMap.set("worker-a", {
    busy: true,
    healthy: true,
    dispatching: false,
    lastSeen: 1,
    currentContract: "TC-1",
    queue: [{ contractId: "TC-1", fromAgent: "planner" }, { contractId: "TC-2", fromAgent: "planner" }],
  });

  const result = await removeDispatchContract("TC-1", logger);
  const state = dispatchTargetStateMap.get("worker-a");

  assert.equal(result.changed, true);
  assert.equal(state.busy, false);
  assert.equal(state.dispatching, false);
  assert.equal(state.currentContract, null);
  assert.deepEqual(state.queue, [{ contractId: "TC-2", fromAgent: "planner" }]);
});

test("getDispatchTargetCurrentContract returns canonical current contract id", () => {
  dispatchTargetStateMap.clear();
  dispatchTargetStateMap.set("worker-a", {
    busy: true,
    healthy: true,
    dispatching: false,
    lastSeen: 1,
    currentContract: "  TC-1  ",
    queue: [],
  });

  assert.equal(getDispatchTargetCurrentContract("worker-a"), "TC-1");
  assert.equal(getDispatchTargetCurrentContract("missing"), null);
});

test("dispatch-runtime-state module no longer exports worker-only names", async () => {
  const dispatchRuntimeState = await import("../lib/routing/dispatch-runtime-state.js");

  assert.equal("buildWorkerRuntimeSnapshot" in dispatchRuntimeState, false);
  assert.equal("enqueueContract" in dispatchRuntimeState, false);
});

test("state module exposes dispatchTargetStateMap without legacy queue/pool aliases", () => {
  assert.equal("dispatchTargetStateMap" in state, true);
  assert.equal("workerPool" in state, false);
  assert.equal("taskQueue" in state, false);
});

test("buildDispatchRuntimeSnapshot returns canonical payload", () => {
  dispatchTargetStateMap.clear();
  dispatchTargetStateMap.set("planner-a", {
    busy: true, healthy: true, dispatching: false, lastSeen: 100, currentContract: "TC-1", queue: ["TC-2"],
  });

  const snapshot = buildDispatchRuntimeSnapshot();

  assert.deepEqual(Object.keys(snapshot).sort(), ["queue", "targets", "ts"]);
  assert.equal(snapshot.targets["planner-a"].busy, true);
  assert.equal(snapshot.targets["planner-a"].currentContract, "TC-1");
  assert.deepEqual(snapshot.targets["planner-a"].queue, ["TC-2"]);
  assert.deepEqual(snapshot.queue, ["TC-2"]);
});

test("enqueueDispatchContract works for executor and planner targets alike", async () => {
  dispatchTargetStateMap.clear();
  await syncDispatchTargets(["planner-a", "worker-a"], logger);

  const plannerQueued = enqueueDispatchContract("planner-a", "TC-PLANNER-1", { fromAgent: "controller" }, logger);
  const workerQueued = enqueueDispatchContract("worker-a", "TC-WORKER-1", { fromAgent: "planner-a" }, logger);
  const plannerDup = enqueueDispatchContract("planner-a", "TC-PLANNER-1", { fromAgent: "controller" }, logger);

  assert.equal(plannerQueued, true);
  assert.equal(workerQueued, true);
  assert.equal(plannerDup, true);
  assert.equal(getDispatchQueueDepth("planner-a"), 1);
  assert.equal(getDispatchQueueDepth("worker-a"), 1);
});

test("dispatch runtime persistence no longer reads or writes legacy workers shape", async () => {
  const dispatchRuntimeSource = await readFile(
    new URL("../lib/routing/dispatch-runtime-state.js", import.meta.url),
    "utf8",
  );
  const runtimeAdminSource = await readFile(
    new URL("../lib/admin/runtime-admin.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(
    dispatchRuntimeSource,
    /persisted\?\.workers|Object\.entries\(persisted\.workers\)/,
    "dispatch-runtime-state should only accept canonical targets persistence",
  );
  assert.doesNotMatch(
    runtimeAdminSource,
    /workers:\s*\{\}/,
    "runtime reset should no longer rewrite legacy workers persistence shape",
  );
  assert.match(
    runtimeAdminSource,
    /targets:\s*\{\}/,
    "runtime reset should rewrite canonical targets persistence shape",
  );
});

test("reconcileDispatchRuntimeTruth prunes stale queue entries and requeues orphan pending shared contracts", async () => {
  dispatchTargetStateMap.clear();
  await syncDispatchTargets(["planner-a"], logger);

  const orphanContractId = `TC-RUNTIME-ORPHAN-${Date.now()}`;
  const orphanContractPath = getContractPath(orphanContractId);

  try {
    dispatchTargetStateMap.set("planner-a", {
      busy: false,
      healthy: true,
      dispatching: false,
      lastSeen: Date.now(),
      currentContract: null,
      queue: [{ contractId: "TC-STALE-QUEUE", fromAgent: "controller" }],
      roundRobinCursor: 0,
    });

    await persistContractSnapshot(orphanContractPath, {
      id: orphanContractId,
      task: "reconcile should recover orphan pending contract",
      assignee: "planner-a",
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      output: `/tmp/${orphanContractId}.md`,
      phases: ["执行"],
      total: 1,
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
      coordination: {
        caller: {
          agentId: "controller",
        },
      },
      replyTo: {
        agentId: "controller",
        sessionKey: "agent:controller:main",
      },
    }, logger);

    const result = await reconcileDispatchRuntimeTruth(logger);
    const snapshot = buildDispatchRuntimeSnapshot();

    assert.equal(result.changed, true);
    assert.deepEqual(snapshot.queue, [orphanContractId]);
    assert.deepEqual(snapshot.targets["planner-a"]?.queue, [orphanContractId]);
  } finally {
    evictContractSnapshotByPath(orphanContractPath);
    await unlink(orphanContractPath).catch(() => {});
  }
});

test("reconcileDispatchRuntimeTruth stays idempotent under concurrent startup calls", async () => {
  dispatchTargetStateMap.clear();
  await syncDispatchTargets(["planner-a"], logger);

  const queuedContractId = `TC-RUNTIME-QUEUED-${Date.now()}`;
  const queuedContractPath = getContractPath(queuedContractId);
  const orphanContractId = `TC-RUNTIME-ORPHAN-CONCURRENT-${Date.now()}`;
  const orphanContractPath = getContractPath(orphanContractId);

  try {
    await persistContractSnapshot(queuedContractPath, {
      id: queuedContractId,
      task: "existing queued contract should not duplicate",
      assignee: "planner-a",
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      output: `/tmp/${queuedContractId}.md`,
      phases: ["执行"],
      total: 1,
      protocol: { version: 1, envelope: "execution_contract" },
      coordination: { caller: { agentId: "controller" } },
      replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    }, logger);

    await persistContractSnapshot(orphanContractPath, {
      id: orphanContractId,
      task: "orphan contract should only be recovered once",
      assignee: "planner-a",
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now() + 1,
      updatedAt: Date.now() + 1,
      output: `/tmp/${orphanContractId}.md`,
      phases: ["执行"],
      total: 1,
      protocol: { version: 1, envelope: "execution_contract" },
      coordination: { caller: { agentId: "controller" } },
      replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    }, logger);

    dispatchTargetStateMap.set("planner-a", {
      busy: false,
      healthy: true,
      dispatching: false,
      lastSeen: Date.now(),
      currentContract: null,
      queue: [{ contractId: queuedContractId, fromAgent: "controller" }],
      roundRobinCursor: 0,
    });

    await Promise.all([
      reconcileDispatchRuntimeTruth(logger),
      reconcileDispatchRuntimeTruth(logger),
    ]);

    const snapshot = buildDispatchRuntimeSnapshot();
    assert.deepEqual(snapshot.targets["planner-a"]?.queue, [queuedContractId, orphanContractId]);
  } finally {
    evictContractSnapshotByPath(queuedContractPath);
    evictContractSnapshotByPath(orphanContractPath);
    await unlink(queuedContractPath).catch(() => {});
    await unlink(orphanContractPath).catch(() => {});
  }
});
