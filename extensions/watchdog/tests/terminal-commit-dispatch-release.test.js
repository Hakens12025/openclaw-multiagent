import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";

import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { dispatchTargetStateMap } from "../lib/state.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { commitSemanticTerminalState } from "../lib/terminal-commit.js";
import { evictContractSnapshotByPath } from "../lib/store/contract-store.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test.afterEach(() => {
  dispatchTargetStateMap.clear();
});

test("commitSemanticTerminalState releases dispatch ownership for terminal contract", async () => {
  const contractId = `TC-TERMINAL-DISPATCH-${Date.now()}`;
  const contractPath = getContractPath(contractId);

  try {
    const contract = {
      id: contractId,
      task: "release dispatch owner on terminal commit",
      assignee: "worker",
      status: CONTRACT_STATUS.RUNNING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      output: `/tmp/${contractId}.md`,
    };
    await persistContractSnapshot(contractPath, contract, logger);

    dispatchTargetStateMap.set("worker", {
      busy: true,
      healthy: true,
      dispatching: false,
      lastSeen: Date.now(),
      currentContract: contractId,
      queue: [],
    });

    const trackingState = createTrackingState({
      sessionKey: `agent:worker:contract:${contractId}`,
      agentId: "worker",
      parentSession: null,
    });
    trackingState.contract = {
      ...contract,
      path: contractPath,
    };

    const result = await commitSemanticTerminalState({
      trackingState,
      terminalStatus: CONTRACT_STATUS.COMPLETED,
      terminalOutcome: {
        status: CONTRACT_STATUS.COMPLETED,
        source: "completion_criteria",
        reason: "artifact verified",
      },
      logger,
    });

    assert.equal(result.committed, true);
    const dispatchState = dispatchTargetStateMap.get("worker");
    assert.equal(dispatchState.busy, false);
    assert.equal(dispatchState.dispatching, false);
    assert.equal(dispatchState.currentContract, null);
  } finally {
    evictContractSnapshotByPath(contractPath);
    await unlink(contractPath).catch(() => {});
  }
});
