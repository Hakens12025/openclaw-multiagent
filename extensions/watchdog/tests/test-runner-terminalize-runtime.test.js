import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";

import { getContractPath, persistContractById, readContractSnapshotById } from "../lib/contracts.js";
import { CONTRACT_STATUS, TRACKING_STATUS } from "../lib/core/runtime-status.js";
import { dispatchOutgoingStateMap, dispatchTargetStateMap, runtimeAgentConfigs, taskHistory } from "../lib/state.js";
import { clearAllSessions, HARD_STOP_REASON, isSessionHardStopped, markSessionHardStopped } from "../lib/loop/loop-detection.js";
import { resolveLoopEpochKey } from "../lib/loop/loop-epoch-key.js";
import { reconcileDispatchRuntimeTruth } from "../lib/routing/dispatch-runtime-reconcile.js";
import {
  clearTrackingStore,
  getTrackingState,
  rememberTrackingState,
} from "../lib/store/tracker-store.js";
import { terminalizeContractForTestRunner } from "../lib/test-runner-terminalize.js";
import { evictContractSnapshotByPath } from "../lib/store/contract-store.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test.afterEach(() => {
  clearTrackingStore();
  clearAllSessions();
  dispatchOutgoingStateMap.clear();
  dispatchTargetStateMap.clear();
  runtimeAgentConfigs.clear();
  taskHistory.length = 0;
});

test("test-runner terminalize closes running tracker before dispatch reconcile can restore ownership", async () => {
  const contractId = `TC-TERMINALIZE-RUNTIME-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const sessionKey = `agent:planner:contract:${contractId}`;
  runtimeAgentConfigs.set("planner", { id: "planner", role: "planner" });
  const trackingState = {
    sessionKey,
    agentId: "planner",
    runId: `run-${Date.now()}`,
    status: TRACKING_STATUS.RUNNING,
    startMs: Date.now() - 1000,
    toolCalls: [],
    recentToolEvents: [],
    toolCallTotal: 0,
    lastLabel: "running",
    contract: {
      id: contractId,
      path: contractPath,
      task: "terminalize stale running tracker",
      assignee: "planner",
      status: CONTRACT_STATUS.RUNNING,
      output: `/tmp/${contractId}.md`,
      phases: ["run"],
      total: 1,
    },
  };

  await persistContractById({
    id: contractId,
    task: "terminalize stale running tracker",
    assignee: "planner",
    status: CONTRACT_STATUS.RUNNING,
    output: `/tmp/${contractId}.md`,
    phases: ["run"],
    total: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, logger);
  dispatchTargetStateMap.set("planner", {
    busy: true,
    healthy: true,
    dispatching: false,
    lastSeen: Date.now(),
    currentContract: contractId,
    queue: [],
  });
  rememberTrackingState(sessionKey, trackingState);
  markSessionHardStopped(resolveLoopEpochKey(trackingState), HARD_STOP_REASON.MANUAL);

  try {
    const result = await terminalizeContractForTestRunner({
      contractId,
      status: CONTRACT_STATUS.FAILED,
      source: "test_runner",
      reason: "case_timeout",
      summary: "case timed out",
      retryable: false,
      logger,
      api: {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.trackingCleanup.removed, 1);
    assert.equal(getTrackingState(sessionKey), null);
    assert.equal(isSessionHardStopped(resolveLoopEpochKey(trackingState)), false);

    const persisted = await readContractSnapshotById(contractId);
    assert.equal(persisted.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.terminalOutcome?.reason, "case_timeout");

    const dispatchState = dispatchTargetStateMap.get("planner");
    assert.equal(dispatchState.busy, false);
    assert.equal(dispatchState.currentContract, null);

    await reconcileDispatchRuntimeTruth(logger);
    assert.equal(dispatchTargetStateMap.get("planner").busy, false);
    assert.equal(dispatchTargetStateMap.get("planner").currentContract, null);

    assert.equal(taskHistory.some((entry) => entry.sessionKey === sessionKey), true);
  } finally {
    evictContractSnapshotByPath(contractPath);
    await unlink(contractPath).catch(() => {});
  }
});
