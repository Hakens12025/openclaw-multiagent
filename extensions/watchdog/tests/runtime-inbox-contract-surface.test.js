import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { persistContractById } from "../lib/contract/contracts.js";
import { routeWorkerInbox } from "../lib/routing/mailbox/runtime-mailbox-inbox-handlers.js";
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
  let contractPath = null;

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
      taskType: "execution_contract",
      assignee: agentId,
      status: CONTRACT_STATUS.PENDING,
      output: join(inboxRoot, "output", `${contractId}.md`),
      expectations: ["report the current time"],
      upstreamPackages: [{ producer: "planner", files: ["brief.md"], primary: "brief.md" }],
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
      stagePlan: [{ id: "stage-1", goal: "answer" }],
      stageRuntime: {
        version: 1,
        currentStageId: "stage-1",
        completedStageIds: [],
        revisionCount: 0,
        lastRevisionReason: null,
      },
      executionObservation: { note: "system-only diagnostic" },
      terminalOutcome: { decision: "pending" },
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
    contractPath = await persistContractById(sharedContract, logger);

    await routeWorkerInbox({
      agentId,
      inboxDir,
      logger,
      contractIdHint: contractId,
      contractPathHint: contractPath,
    });

    const staged = JSON.parse(await readFile(join(inboxDir, "contract.json"), "utf8"));

    // 批1 白名单收敛到 6 键 agent-facing 面:agent 真需要的 + 系统绑定门真读的。
    assert.equal(staged.id, contractId);
    assert.equal(staged.task, "现在几点了");
    // status 保留:仅系统绑定门读(session-contract-binding.js:230 非活跃过滤),非 agent-facing。
    assert.equal(staged.status, CONTRACT_STATUS.PENDING);
    // expectations / upstreamPackages 被 role directive 真读(role-spec-registry.js:8/17)。
    assert.deepEqual(staged.expectations, sharedContract.expectations);
    assert.deepEqual(staged.upstreamPackages, sharedContract.upstreamPackages);

    // 批1b runtimeContext 投影瘦身:只留 currentTime.text 一句,version + 其余 7 子字段砍掉。
    assert.deepEqual(staged.runtimeContext, {
      currentTime: { text: sharedContract.runtimeContext.currentTime.text },
    });
    assert.equal("version" in staged.runtimeContext, false);
    assert.equal("unixMs" in staged.runtimeContext.currentTime, false);
    assert.equal("iso" in staged.runtimeContext.currentTime, false);
    assert.equal("timeZone" in staged.runtimeContext.currentTime, false);
    assert.equal("weekdayZh" in staged.runtimeContext.currentTime, false);

    // 系统噪声不进 agent 面(inbox 副本零系统读者;系统读树正本/内存态)。
    assert.equal("protocol" in staged, false);
    assert.equal("executionObservation" in staged, false);
    assert.equal("terminalOutcome" in staged, false);
    assert.equal("stagePlan" in staged, false);
    assert.equal("stageRuntime" in staged, false);
    assert.equal("assignee" in staged, false);
    assert.equal("taskType" in staged, false);
    // outbox 统一(f7769b5): agent 面向投影去掉 output/outputAlias，agent 写 outbox/。
    assert.equal("outputAlias" in staged, false);
    assert.equal("output" in staged, false);
    assert.equal("replyTo" in staged, false);
    assert.equal("coordination" in staged, false);
  } finally {
    dispatchTargetStateMap.delete(agentId);
    if (contractPath) await rm(contractPath, { force: true });
    await rm(inboxRoot, { recursive: true, force: true });
  }
});
