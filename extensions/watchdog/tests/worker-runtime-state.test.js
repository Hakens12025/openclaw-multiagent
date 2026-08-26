import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph as saveGraphUnattributed } from "../lib/agent/agent-graph-mutations.js";

// §13 整写门:测试夹具写图报身份(writer),edge 级差异日志可追溯到本文件。
const saveGraph = (graph) => saveGraphUnattributed(graph, { writer: "test:worker-runtime-state.test.js" });
import * as state from "../lib/state.js";
import { getContractPath, persistContractById } from "../lib/contract/contracts.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { evictContractSnapshotByPath } from "../lib/store/contract-store.js";
import {
  buildDispatchRuntimeSnapshot,
  claimDispatchTargetContract,
  dequeueDispatchContract,
  enqueueDispatchContract,
  enqueueOutgoingDispatchContract,
  ensureDispatchTargetAvailable,
  getDispatchQueueDepth,
  getDispatchTargetCurrentContract,
  loadDispatchRuntimeState,
  markDispatchTargetDispatching,
  listDispatchTargetIds,
  removeDispatchContract,
  removeOutgoingDispatchContract,
  releaseDispatchTargetContract,
  resetAllDispatchStates,
  syncDispatchTargets,
  syncDispatchTargetsFromRuntime,
} from "../lib/routing/dispatch/dispatch-runtime-state.js";
import { reconcileDispatchRuntimeTruth } from "../lib/routing/dispatch/dispatch-runtime-reconcile.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

const logger = { info() {}, warn() {}, error() {} };
const { runtimeAgentConfigs, dispatchOutgoingStateMap, dispatchTargetStateMap } = state;

function clearDispatchStores() {
  dispatchTargetStateMap.clear();
  dispatchOutgoingStateMap.clear();
}

test("syncDispatchTargets adds new targets and prunes stale idle ones", async () => {
  clearDispatchStores();
  dispatchTargetStateMap.set("stale-idle", {
    busy: false, healthy: true, dispatching: false, lastSeen: 1, currentContract: null, queue: [],
  });

  await syncDispatchTargets(["worker-a", "worker-b"], logger);

  assert.equal(dispatchTargetStateMap.has("worker-a"), true);
  assert.equal(dispatchTargetStateMap.has("worker-b"), true);
  assert.equal(dispatchTargetStateMap.has("stale-idle"), false);
});

test("syncDispatchTargets preserves busy targets even if not in target list", async () => {
  clearDispatchStores();
  dispatchTargetStateMap.set("busy-worker", {
    busy: true, healthy: true, dispatching: false, lastSeen: 1, currentContract: "TC-1", queue: [],
  });

  await syncDispatchTargets(["worker-a"], logger);

  assert.equal(dispatchTargetStateMap.has("busy-worker"), true, "busy worker should not be pruned");
  assert.equal(dispatchTargetStateMap.has("worker-a"), true);
});

test("resetAllDispatchStates clears incoming and outgoing dispatch state", () => {
  clearDispatchStores();
  dispatchTargetStateMap.set("planner-a", {
    busy: true,
    healthy: true,
    dispatching: true,
    lastSeen: 1,
    currentContract: "TC-RUNNING",
    dispatchingQueueEntry: { contractId: "TC-LEASED", fromAgent: "controller" },
    queue: [{ contractId: "TC-QUEUED", fromAgent: "controller" }],
    outgoingQueue: [{ contractId: "TC-OUT", targetAgent: "worker-a", status: "blocked" }],
  });
  dispatchOutgoingStateMap.set("planner-a", {
    outgoingQueue: [{ contractId: "TC-OUT-2", targetAgent: "worker-a", status: "blocked" }],
  });

  resetAllDispatchStates();

  const stateAfter = dispatchTargetStateMap.get("planner-a");
  assert.equal(stateAfter.busy, false);
  assert.equal(stateAfter.dispatching, false);
  assert.equal(stateAfter.currentContract, null);
  assert.equal(stateAfter.dispatchingQueueEntry, null);
  assert.deepEqual(stateAfter.queue, []);
  assert.equal("outgoingQueue" in stateAfter, false);
  assert.equal(dispatchOutgoingStateMap.size, 0);
});

test("syncDispatchTargets drops target-owned outgoing diagnostics", async () => {
  clearDispatchStores();
  dispatchTargetStateMap.set("controller", {
    busy: false,
    healthy: true,
    dispatching: false,
    lastSeen: 1,
    currentContract: null,
    queue: [],
    outgoingQueue: [{ contractId: "TC-LEGACY-OUT", targetAgent: "planner-a", status: "blocked" }],
  });

  await syncDispatchTargets(["planner-a"], logger);

  assert.equal(dispatchTargetStateMap.has("controller"), false);
  assert.equal(dispatchOutgoingStateMap.has("controller"), false);
  const snapshot = buildDispatchRuntimeSnapshot();
  assert.equal(snapshot.targets.controller, undefined);
  assert.equal(snapshot.outgoingBySource.controller, undefined);
});

test("syncDispatchTargetsFromRuntime hydrates every configured dispatch role instead of only the executor lane", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousGraph = await loadGraph();
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  clearDispatchStores();

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("planner", { id: "planner", role: "planner" });
    runtimeAgentConfigs.set("worker-a", { id: "worker-a", role: "executor" });
    runtimeAgentConfigs.set("researcher-a", { id: "researcher-a", role: "researcher" });
    await saveGraph({
      edges: [
        { from: "planner", to: "worker-a", label: "assign" },
        { from: "worker-a", to: "researcher-a", label: "research" },
      ],
    });

    await syncDispatchTargetsFromRuntime(logger);

    assert.deepEqual(listDispatchTargetIds().sort(), ["planner", "researcher-a", "worker-a"]);
  } finally {
    clearDispatchStores();
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await saveGraph(previousGraph);
  }
}));

test("syncDispatchTargetsFromRuntime excludes hidden control-plane agents from runtime queue targets", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousGraph = await loadGraph();
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  clearDispatchStores();

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("operator", {
      id: "operator",
      role: "agent",
      plane: "control_plane",
      mainViewVisible: false,
      formalTimelineVisible: false,
      autoWakeEligible: false,
    });
    runtimeAgentConfigs.set("worker-a", {
      id: "worker-a",
      role: "executor",
      plane: "runtime",
      mainViewVisible: true,
      formalTimelineVisible: true,
      autoWakeEligible: true,
    });
    await saveGraph({
      edges: [
        { from: "worker-a", to: "worker-a", label: "self-test" },
      ],
    });

    await syncDispatchTargetsFromRuntime(logger);

    assert.deepEqual(listDispatchTargetIds().sort(), ["worker-a"]);
  } finally {
    clearDispatchStores();
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await saveGraph(previousGraph);
  }
}));

test("syncDispatchTargetsFromRuntime excludes named control-layer actors by default", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousGraph = await loadGraph();
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  clearDispatchStores();

  try {
    runtimeAgentConfigs.clear();
    for (const agentId of ["harness", "cli-system", "automation"]) {
      runtimeAgentConfigs.set(agentId, {
        id: agentId,
        role: "agent",
        plane: "control_plane",
        mainViewVisible: false,
        formalTimelineVisible: false,
        autoWakeEligible: false,
      });
    }
    runtimeAgentConfigs.set("worker-a", {
      id: "worker-a",
      role: "executor",
      plane: "runtime",
      mainViewVisible: true,
      formalTimelineVisible: true,
      autoWakeEligible: true,
    });
    await saveGraph({
      edges: [
        { from: "worker-a", to: "worker-a", label: "self-test" },
      ],
    });

    await syncDispatchTargetsFromRuntime(logger);

    assert.deepEqual(listDispatchTargetIds().sort(), ["worker-a"]);
  } finally {
    clearDispatchStores();
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await saveGraph(previousGraph);
  }
}));

test("claimDispatchTargetContract marks target busy and removes queued contract", async () => {
  clearDispatchStores();
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

test("claimDispatchTargetContract refuses unknown dispatch target", async () => {
  clearDispatchStores();

  const result = await claimDispatchTargetContract({ contractId: "TC-1", agentId: "ghost-target", logger });

  assert.equal(result, false);
  assert.equal(dispatchTargetStateMap.has("ghost-target"), false);
});

test("ensureDispatchTargetAvailable rejects workspace-only residue outside the runtime roster", async () => {
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  const residueAgentId = `ghost-workspace-${Date.now()}`;
  clearDispatchStores();
  runtimeAgentConfigs.clear();

  try {
    await mkdir(state.agentWorkspace(residueAgentId), { recursive: true });

    const result = await ensureDispatchTargetAvailable(residueAgentId, logger);

    assert.equal(result, false);
    assert.equal(dispatchTargetStateMap.has(residueAgentId), false);
  } finally {
    await rm(state.agentWorkspace(residueAgentId), { recursive: true, force: true });
    clearDispatchStores();
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
  }
});

test("markDispatchTargetDispatching refuses to overwrite busy or dispatching target state", () => {
  clearDispatchStores();
  dispatchTargetStateMap.set("worker-a", {
    busy: true,
    healthy: true,
    dispatching: false,
    lastSeen: 1,
    currentContract: "TC-active",
    queue: [],
  });
  dispatchTargetStateMap.set("worker-b", {
    busy: false,
    healthy: true,
    dispatching: true,
    lastSeen: 1,
    currentContract: "TC-dispatching",
    queue: [],
  });

  assert.equal(markDispatchTargetDispatching("worker-a", "TC-new"), false);
  assert.equal(markDispatchTargetDispatching("worker-b", "TC-new"), false);
  assert.equal(dispatchTargetStateMap.get("worker-a").currentContract, "TC-active");
  assert.equal(dispatchTargetStateMap.get("worker-b").currentContract, "TC-dispatching");
});

test("releaseDispatchTargetContract clears target state", async () => {
  clearDispatchStores();
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
  clearDispatchStores();
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

test("removeOutgoingDispatchContract prunes source-side outgoing diagnostics without target pollution", async () => {
  clearDispatchStores();
  enqueueOutgoingDispatchContract("external-source", "TC-OUT-1", {
    targetAgent: "planner-a",
    status: "dispatching",
  }, logger);

  assert.equal(dispatchTargetStateMap.has("external-source"), false);
  assert.equal(dispatchOutgoingStateMap.has("external-source"), true);

  const removed = await removeOutgoingDispatchContract("external-source", "TC-OUT-1", logger);

  assert.equal(removed, true);
  assert.equal(dispatchTargetStateMap.has("external-source"), false);
  assert.equal(dispatchOutgoingStateMap.has("external-source"), false);
});

test("buildDispatchRuntimeSnapshot ignores target-owned outgoing diagnostics", async () => {
  clearDispatchStores();
  dispatchTargetStateMap.set("planner-a", {
    busy: false,
    healthy: true,
    dispatching: false,
    lastSeen: 1,
    currentContract: null,
    queue: [],
    outgoingQueue: [{ contractId: "TC-DUP-OUT", targetAgent: "worker-a", status: "blocked" }],
  });
  enqueueOutgoingDispatchContract("planner-a", "TC-DUP-OUT", {
    targetAgent: "worker-a",
    status: "blocked",
  }, logger);

  assert.equal(buildDispatchRuntimeSnapshot().outgoingBySource["planner-a"].length, 1);

  const removed = await removeOutgoingDispatchContract("planner-a", "TC-DUP-OUT", logger);
  const snapshot = buildDispatchRuntimeSnapshot();

  assert.equal(removed, true);
  assert.equal(snapshot.outgoingBySource["planner-a"], undefined);
  assert.equal(dispatchTargetStateMap.get("planner-a")?.outgoingQueue?.length || 0, 0);
  assert.equal(dispatchOutgoingStateMap.has("planner-a"), false);
});

test("enqueueOutgoingDispatchContract records source diagnostics without registering dispatch targets", () => {
  clearDispatchStores();
  const queued = enqueueOutgoingDispatchContract("harness:agent_end", "TC-OUT-HARNESS", {
    targetAgent: "planner-a",
    status: "blocked",
  }, logger);

  assert.equal(queued, true);
  assert.equal(dispatchTargetStateMap.has("harness:agent_end"), false);
  assert.equal(listDispatchTargetIds().includes("harness:agent_end"), false);
  const snapshot = buildDispatchRuntimeSnapshot();
  assert.equal(snapshot.targets["harness:agent_end"], undefined);
  assert.equal(snapshot.outgoingBySource["harness:agent_end"]?.[0]?.contractId, "TC-OUT-HARNESS");
});

test("getDispatchTargetCurrentContract returns canonical current contract id", () => {
  clearDispatchStores();
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
  const dispatchRuntimeState = await import("../lib/routing/dispatch/dispatch-runtime-state.js");

  assert.equal("buildWorkerRuntimeSnapshot" in dispatchRuntimeState, false);
  assert.equal("enqueueContract" in dispatchRuntimeState, false);
});

test("dispatch runtime state no longer carries graph round-robin routing state", async () => {
  const dispatchRuntimeSource = await readFile(
    new URL("../lib/routing/dispatch/dispatch-runtime-state.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(dispatchRuntimeSource, /roundRobinCursor/);
  assert.doesNotMatch(dispatchRuntimeSource, /advanceDispatchRoundRobinCursor/);
});

test("state module exposes dispatchTargetStateMap without legacy queue/pool aliases", () => {
  assert.equal("dispatchTargetStateMap" in state, true);
  assert.equal("workerPool" in state, false);
  assert.equal("taskQueue" in state, false);
});

test("buildDispatchRuntimeSnapshot returns canonical payload", () => {
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  clearDispatchStores();
  runtimeAgentConfigs.clear();
  runtimeAgentConfigs.set("planner-a", {
    id: "planner-a",
    role: "planner",
    capabilities: {
      tools: ["read", "write"],
    },
  });
  try {
    dispatchTargetStateMap.set("planner-a", {
      busy: true, healthy: true, dispatching: false, lastSeen: 100, currentContract: "TC-1", queue: ["TC-2"],
    });

    const snapshot = buildDispatchRuntimeSnapshot();

    assert.deepEqual(Object.keys(snapshot).sort(), ["contractFlow", "outgoingBySource", "queue", "targets", "ts"]);
    assert.equal(snapshot.targets["planner-a"].busy, true);
    assert.equal(snapshot.targets["planner-a"].currentContract, "TC-1");
    assert.deepEqual(snapshot.targets["planner-a"].queue, [{
      contractId: "TC-2",
      fromAgent: null,
      targetAgent: "planner-a",
    }]);
    assert.deepEqual(snapshot.queue, [{
      contractId: "TC-2",
      fromAgent: null,
      targetAgent: "planner-a",
    }]);
    assert.deepEqual(snapshot.contractFlow, {
      incomingQueued: 1,
      outgoingQueued: 0,
      running: 1,
      blockedOutgoing: 0,
    });
  } finally {
    clearDispatchStores();
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
  }
});

test("buildDispatchRuntimeSnapshot ignores target-owned outgoing queue residue", () => {
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  clearDispatchStores();
  runtimeAgentConfigs.clear();
  runtimeAgentConfigs.set("controller", {
    id: "controller",
    role: "agent",
  });
  try {
    dispatchTargetStateMap.set("controller", {
      busy: false,
      healthy: true,
      dispatching: false,
      lastSeen: 100,
      currentContract: null,
      queue: [],
      outgoingQueue: [{
        contractId: "TC-OUT-1",
        targetAgent: "planner-a",
        status: "blocked",
      }],
    });

    const snapshot = buildDispatchRuntimeSnapshot();

    assert.equal(snapshot.outgoingBySource.controller, undefined);
    assert.deepEqual(snapshot.contractFlow, {
      incomingQueued: 0,
      outgoingQueued: 0,
      running: 0,
      blockedOutgoing: 0,
    });
  } finally {
    clearDispatchStores();
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
  }
});

test("enqueueDispatchContract works for executor and planner targets alike", async () => {
  clearDispatchStores();
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

test("enqueueDispatchContract treats a dispatching queue lease as an existing queue entry", async () => {
  clearDispatchStores();
  await syncDispatchTargets(["planner-a"], logger);
  enqueueDispatchContract("planner-a", "TC-LEASE-DUP", { fromAgent: "controller" }, logger);

  const leased = await dequeueDispatchContract("planner-a", logger);
  const queuedAgain = enqueueDispatchContract("planner-a", "TC-LEASE-DUP", { fromAgent: "controller" }, logger);

  assert.equal(leased?.contractId, "TC-LEASE-DUP");
  assert.equal(queuedAgain, true);
  assert.deepEqual(buildDispatchRuntimeSnapshot().targets["planner-a"]?.queue, []);
  assert.equal(buildDispatchRuntimeSnapshot().targets["planner-a"]?.dispatchingQueueEntry?.contractId, "TC-LEASE-DUP");
});

test("dequeueDispatchContract persists an inflight queue lease and reload restores it to the queue", async () => runGlobalTestEnvironmentSerial(async () => {
  clearDispatchStores();
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  runtimeAgentConfigs.clear();
  runtimeAgentConfigs.set("planner-a", { id: "planner-a", role: "planner" });

  try {
    await syncDispatchTargets(["planner-a"], logger);
    enqueueDispatchContract("planner-a", "TC-LEASE-1", { fromAgent: "controller" }, logger);
    enqueueDispatchContract("planner-a", "TC-LEASE-2", { fromAgent: "controller" }, logger);

    const leased = await dequeueDispatchContract("planner-a", logger);
    assert.deepEqual(leased, { contractId: "TC-LEASE-1", fromAgent: "controller", targetAgent: "planner-a" });
    assert.deepEqual(buildDispatchRuntimeSnapshot().targets["planner-a"]?.queue, [{
      contractId: "TC-LEASE-2",
      fromAgent: "controller",
      targetAgent: "planner-a",
    }]);

    clearDispatchStores();
    await loadDispatchRuntimeState(logger);

    assert.deepEqual(buildDispatchRuntimeSnapshot().targets["planner-a"]?.queue, [
      {
        contractId: "TC-LEASE-1",
        fromAgent: "controller",
        targetAgent: "planner-a",
      },
      {
        contractId: "TC-LEASE-2",
        fromAgent: "controller",
        targetAgent: "planner-a",
      },
    ]);
  } finally {
    await unlink(state.QUEUE_STATE_FILE).catch(() => {});
    clearDispatchStores();
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
  }
}));

test("dispatch runtime persistence no longer reads or writes legacy workers shape", async () => {
  const dispatchRuntimeSource = await readFile(
    new URL("../lib/routing/dispatch/dispatch-runtime-state.js", import.meta.url),
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
  assert.doesNotMatch(
    runtimeAdminSource,
    /targets:\s*\{\}/,
    "runtime reset should not hand-write a second queue persistence schema",
  );
  assert.match(
    runtimeAdminSource,
    /persistDispatchRuntimeState\(logger\)/,
    "runtime reset should use dispatch-runtime-state as the queue persistence owner",
  );
});

test("reconcileDispatchRuntimeTruth prunes persisted targets outside the active runtime roster", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousGraph = await loadGraph();
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  const ghostContractId = `TC-GHOST-PERSISTED-${Date.now()}`;
  let ghostContractPath = getContractPath(ghostContractId);
  clearDispatchStores();
  runtimeAgentConfigs.clear();
  runtimeAgentConfigs.set("planner-a", { id: "planner-a", role: "planner" });

  try {
    ghostContractPath = await persistContractById({
      id: ghostContractId,
      task: "persisted ghost target should not self-authorize",
      assignee: "ghost-target",
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      protocol: { version: 1, envelope: "execution_contract" },
      coordination: { caller: { agentId: "controller" } },
      replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    }, logger);
    await saveGraph({
      edges: [
        { from: "controller", to: "ghost-target", label: "stale" },
      ],
    });
    await mkdir(dirname(state.QUEUE_STATE_FILE), { recursive: true });
    await writeFile(state.QUEUE_STATE_FILE, JSON.stringify({
      targets: {
        "ghost-target": {
          busy: false,
          healthy: true,
          dispatching: false,
          currentContract: null,
          queue: [{ contractId: ghostContractId, fromAgent: "controller" }],
          outgoingQueue: [],
        },
      },
      savedAt: Date.now(),
    }, null, 2));

    await loadDispatchRuntimeState(logger);
    assert.equal(dispatchTargetStateMap.has("ghost-target"), true);

    const result = await reconcileDispatchRuntimeTruth(logger);

    assert.equal(result.changed, true);
    assert.equal(dispatchTargetStateMap.has("ghost-target"), false);
    assert.equal(buildDispatchRuntimeSnapshot().targets["ghost-target"], undefined);
  } finally {
    evictContractSnapshotByPath(ghostContractPath);
    await unlink(ghostContractPath).catch(() => {});
    await unlink(state.QUEUE_STATE_FILE).catch(() => {});
    clearDispatchStores();
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await saveGraph(previousGraph);
  }
}));

test("ensureDispatchTargetAvailable rejects persisted ghost targets before reconcile", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  clearDispatchStores();
  runtimeAgentConfigs.clear();
  runtimeAgentConfigs.set("planner-a", { id: "planner-a", role: "planner" });

  try {
    await mkdir(dirname(state.QUEUE_STATE_FILE), { recursive: true });
    await writeFile(state.QUEUE_STATE_FILE, JSON.stringify({
      targets: {
        "ghost-target": {
          busy: false,
          healthy: true,
          dispatching: false,
          currentContract: null,
          queue: [{ contractId: "TC-GHOST-QUEUED", fromAgent: "controller" }],
          outgoingQueue: [],
        },
      },
      savedAt: Date.now(),
    }, null, 2));

    await loadDispatchRuntimeState(logger);
    assert.equal(dispatchTargetStateMap.has("ghost-target"), true);

    const available = await ensureDispatchTargetAvailable("ghost-target", logger);

    assert.equal(available, false);
  } finally {
    await unlink(state.QUEUE_STATE_FILE).catch(() => {});
    clearDispatchStores();
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
  }
}));

test("reconcileDispatchRuntimeTruth prunes stale queue entries and requeues orphan pending shared contracts", async () => runGlobalTestEnvironmentSerial(async () => {
  clearDispatchStores();
  const previousGraph = await loadGraph();
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  runtimeAgentConfigs.set("planner-a", { id: "planner-a", role: "planner" });
  await syncDispatchTargets(["planner-a"], logger);

  const orphanContractId = `TC-RUNTIME-ORPHAN-${Date.now()}`;
  let orphanContractPath = getContractPath(orphanContractId);

  try {
    dispatchTargetStateMap.set("planner-a", {
      busy: false,
      healthy: true,
      dispatching: false,
      lastSeen: Date.now(),
      currentContract: null,
      queue: [{ contractId: "TC-STALE-QUEUE", fromAgent: "controller" }],
    });

    orphanContractPath = await persistContractById({
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
    await saveGraph({
      edges: [
        { from: "controller", to: "planner-a", label: "ingress" },
      ],
    });

    const result = await reconcileDispatchRuntimeTruth(logger);
    const snapshot = buildDispatchRuntimeSnapshot();

    assert.equal(result.changed, true);
    assert.deepEqual(snapshot.queue, [{
      contractId: orphanContractId,
      fromAgent: "controller",
      targetAgent: "planner-a",
    }]);
    assert.deepEqual(snapshot.targets["planner-a"]?.queue, [{
      contractId: orphanContractId,
      fromAgent: "controller",
      targetAgent: "planner-a",
    }]);
  } finally {
    evictContractSnapshotByPath(orphanContractPath);
    await unlink(orphanContractPath).catch(() => {});
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await saveGraph(previousGraph);
  }
}));

test("reconcileDispatchRuntimeTruth prunes existing queued contracts without current graph edge", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousGraph = await loadGraph();
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  clearDispatchStores();
  runtimeAgentConfigs.set("planner-a", { id: "planner-a", role: "planner" });
  await syncDispatchTargets(["planner-a"], logger);

  const queuedContractId = `TC-RUNTIME-QUEUE-EDGE-${Date.now()}`;
  let queuedContractPath = getContractPath(queuedContractId);

  try {
    queuedContractPath = await persistContractById({
      id: queuedContractId,
      task: "existing queue entry should still obey graph truth",
      assignee: "planner-a",
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      protocol: { version: 1, envelope: "execution_contract" },
      coordination: { caller: { agentId: "controller" } },
      replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    }, logger);
    await saveGraph({
      edges: [
        { from: "controller", to: "other-agent", label: "ingress" },
      ],
    });

    dispatchTargetStateMap.set("planner-a", {
      busy: false,
      healthy: true,
      dispatching: false,
      lastSeen: Date.now(),
      currentContract: null,
      queue: [{ contractId: queuedContractId, fromAgent: "controller" }],
    });

    const result = await reconcileDispatchRuntimeTruth(logger);
    const snapshot = buildDispatchRuntimeSnapshot();

    assert.equal(result.changed, true);
    assert.equal(snapshot.queue.some((entry) => entry.contractId === queuedContractId), false);
    assert.deepEqual(snapshot.targets["planner-a"]?.queue, []);
  } finally {
    evictContractSnapshotByPath(queuedContractPath);
    await unlink(queuedContractPath).catch(() => {});
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await saveGraph(previousGraph);
  }
}));

test("reconcileDispatchRuntimeTruth prunes stale outgoing queue diagnostics", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousGraph = await loadGraph();
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  clearDispatchStores();
  runtimeAgentConfigs.set("planner-a", { id: "planner-a", role: "planner" });
  runtimeAgentConfigs.set("worker-b", { id: "worker-b", role: "executor" });
  await syncDispatchTargets(["planner-a", "worker-b"], logger);

  const validContractId = `TC-RUNTIME-OUTGOING-VALID-${Date.now()}`;
  let validContractPath = getContractPath(validContractId);
  const terminalContractId = `TC-RUNTIME-OUTGOING-TERMINAL-${Date.now()}`;
  let terminalContractPath = getContractPath(terminalContractId);
  const invalidEdgeContractId = `TC-RUNTIME-OUTGOING-EDGE-${Date.now()}`;
  let invalidEdgeContractPath = getContractPath(invalidEdgeContractId);

  try {
    await saveGraph({
      edges: [
        { from: "controller", to: "planner-a", label: "ingress" },
      ],
    });
    validContractPath = await persistContractById({
      id: validContractId,
      task: "valid outgoing diagnostic should remain",
      assignee: "planner-a",
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      protocol: { version: 1, envelope: "execution_contract" },
    }, logger);
    terminalContractPath = await persistContractById({
      id: terminalContractId,
      task: "terminal outgoing diagnostic should be pruned",
      assignee: "planner-a",
      status: CONTRACT_STATUS.COMPLETED,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      protocol: { version: 1, envelope: "execution_contract" },
    }, logger);
    invalidEdgeContractPath = await persistContractById({
      id: invalidEdgeContractId,
      task: "invalid edge outgoing diagnostic should be pruned",
      assignee: "worker-b",
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      protocol: { version: 1, envelope: "execution_contract" },
    }, logger);

    enqueueOutgoingDispatchContract("controller", validContractId, {
      targetAgent: "planner-a",
      status: "dispatching",
      routeEdge: { from: "controller", to: "planner-a", direction: null },
    }, logger);
    enqueueOutgoingDispatchContract("controller", "TC-RUNTIME-OUTGOING-MISSING", {
      targetAgent: "planner-a",
      status: "blocked",
      routeEdge: { from: "controller", to: "planner-a", direction: null },
    }, logger);
    enqueueOutgoingDispatchContract("controller", terminalContractId, {
      targetAgent: "planner-a",
      status: "blocked",
      routeEdge: { from: "controller", to: "planner-a", direction: null },
    }, logger);
    enqueueOutgoingDispatchContract("controller", invalidEdgeContractId, {
      targetAgent: "worker-b",
      status: "dispatching",
      routeEdge: { from: "controller", to: "worker-b", direction: null },
    }, logger);

    const result = await reconcileDispatchRuntimeTruth(logger);
    const snapshot = buildDispatchRuntimeSnapshot();

    assert.equal(result.changed, true);
    assert.equal(snapshot.targets.controller, undefined);
    assert.deepEqual(snapshot.outgoingBySource.controller, [{
      contractId: validContractId,
      fromAgent: "controller",
      targetAgent: "planner-a",
      status: "dispatching",
      routeEdge: {
        from: "controller",
        to: "planner-a",
        direction: null,
      },
    }]);
  } finally {
    evictContractSnapshotByPath(validContractPath);
    evictContractSnapshotByPath(terminalContractPath);
    evictContractSnapshotByPath(invalidEdgeContractPath);
    await unlink(validContractPath).catch(() => {});
    await unlink(terminalContractPath).catch(() => {});
    await unlink(invalidEdgeContractPath).catch(() => {});
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await saveGraph(previousGraph);
  }
}));

test("reconcileDispatchRuntimeTruth does not recover orphan pending contracts without graph edge", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousGraph = await loadGraph();
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  clearDispatchStores();
  runtimeAgentConfigs.set("planner-a", { id: "planner-a", role: "planner" });
  await syncDispatchTargets(["planner-a"], logger);

  const orphanContractId = `TC-RUNTIME-UNAUTHORIZED-ORPHAN-${Date.now()}`;
  let orphanContractPath = getContractPath(orphanContractId);

  try {
    orphanContractPath = await persistContractById({
      id: orphanContractId,
      task: "reconcile must not let assignee bypass graph topology",
      assignee: "planner-a",
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      protocol: { version: 1, envelope: "execution_contract" },
      coordination: { caller: { agentId: "controller" } },
      replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    }, logger);
    await saveGraph({
      edges: [
        { from: "controller", to: "other-agent", label: "ingress" },
      ],
    });

    const result = await reconcileDispatchRuntimeTruth(logger);
    const snapshot = buildDispatchRuntimeSnapshot();

    assert.equal(result.queue.some((entry) => entry.contractId === orphanContractId), false);
    assert.equal(snapshot.targets["planner-a"]?.queue?.length || 0, 0);
  } finally {
    evictContractSnapshotByPath(orphanContractPath);
    await unlink(orphanContractPath).catch(() => {});
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await saveGraph(previousGraph);
  }
}));

test("reconcileDispatchRuntimeTruth stays idempotent under concurrent startup calls", async () => runGlobalTestEnvironmentSerial(async () => {
  clearDispatchStores();
  const previousGraph = await loadGraph();
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  runtimeAgentConfigs.set("planner-a", { id: "planner-a", role: "planner" });
  await syncDispatchTargets(["planner-a"], logger);

  const queuedContractId = `TC-RUNTIME-QUEUED-${Date.now()}`;
  let queuedContractPath = getContractPath(queuedContractId);
  const orphanContractId = `TC-RUNTIME-ORPHAN-CONCURRENT-${Date.now()}`;
  let orphanContractPath = getContractPath(orphanContractId);

  try {
    queuedContractPath = await persistContractById({
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

    orphanContractPath = await persistContractById({
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
    await saveGraph({
      edges: [
        { from: "controller", to: "planner-a", label: "ingress" },
      ],
    });

    dispatchTargetStateMap.set("planner-a", {
      busy: false,
      healthy: true,
      dispatching: false,
      lastSeen: Date.now(),
      currentContract: null,
      queue: [{ contractId: queuedContractId, fromAgent: "controller" }],
    });

    await Promise.all([
      reconcileDispatchRuntimeTruth(logger),
      reconcileDispatchRuntimeTruth(logger),
    ]);

    const snapshot = buildDispatchRuntimeSnapshot();
    assert.deepEqual(snapshot.targets["planner-a"]?.queue, [
      {
        contractId: queuedContractId,
        fromAgent: "controller",
        targetAgent: "planner-a",
      },
      {
        contractId: orphanContractId,
        fromAgent: "controller",
        targetAgent: "planner-a",
      },
    ]);
  } finally {
    evictContractSnapshotByPath(queuedContractPath);
    evictContractSnapshotByPath(orphanContractPath);
    await unlink(queuedContractPath).catch(() => {});
    await unlink(orphanContractPath).catch(() => {});
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await saveGraph(previousGraph);
  }
}));
