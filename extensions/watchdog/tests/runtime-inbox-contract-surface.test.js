import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { routeWorkerInbox } from "../lib/routing/runtime-mailbox-inbox-handlers.js";
import { dispatchTargetStateMap } from "../lib/state.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("routeWorkerInbox stages a task-facing contract surface without planningContext noise", async () => {
  const agentId = `worker-inbox-surface-${Date.now()}`;
  const inboxRoot = await mkdtemp(join(tmpdir(), "openclaw-inbox-surface-"));
  const inboxDir = join(inboxRoot, "inbox");
  const contractId = `TC-INBOX-SURFACE-${Date.now()}`;
  const contractPath = getContractPath(contractId);

  await mkdir(inboxDir, { recursive: true });

  try {
    dispatchTargetStateMap.set(agentId, {
      busy: true,
      healthy: true,
      dispatching: false,
      lastSeen: Date.now(),
      currentContract: contractId,
      queue: [],
    });
    const sharedContract = {
      id: contractId,
      task: "现在几点了",
      assignee: agentId,
      status: CONTRACT_STATUS.PENDING,
      output: join(inboxRoot, "output", `${contractId}.md`),
      replyTo: {
        agentId: "controller",
        sessionKey: "agent:controller:main",
      },
      coordination: {
        owner: { agentId },
        caller: { agentId: "controller", sessionKey: "agent:controller:main" },
      },
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
      stageRuntime: {
        version: 1,
        currentStageId: "stage-1",
        completedStageIds: [],
        revisionCount: 0,
        lastRevisionReason: null,
      },
      runtimeContext: {
        version: 1,
        currentTime: {
          unixMs: 1778568000000,
          iso: "2026-05-12T12:00:00.000Z",
          timeZone: "Asia/Shanghai",
          date: "2026-05-12",
          time: "20:00:00",
          weekday: "Tuesday",
          weekdayZh: "星期二",
          text: "Current time: 2026-05-12 20:00:00 Asia/Shanghai (Tuesday / 星期二).",
        },
      },
    };
    await persistContractSnapshot(contractPath, sharedContract, logger);

    await routeWorkerInbox({
      agentId,
      inboxDir,
      logger,
      contractIdHint: contractId,
      contractPathHint: contractPath,
    });

    const staged = JSON.parse(await readFile(join(inboxDir, "contract.json"), "utf8"));

    assert.equal(staged.id, contractId);
    assert.equal(staged.task, "现在几点了");
    // outbox 统一(f7769b5): agent 面向投影去掉 output/outputAlias，agent 写 outbox/。
    assert.equal("outputAlias" in staged, false);
    assert.equal("output" in staged, false);
    assert.deepEqual(staged.stageRuntime, sharedContract.stageRuntime);
    assert.deepEqual(staged.runtimeContext, sharedContract.runtimeContext);
    assert.equal("replyTo" in staged, false);
    assert.equal("coordination" in staged, false);
  } finally {
    dispatchTargetStateMap.delete(agentId);
    await rm(contractPath, { force: true });
    await rm(inboxRoot, { recursive: true, force: true });
  }
});
