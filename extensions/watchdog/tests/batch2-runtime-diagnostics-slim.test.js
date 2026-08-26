import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";

// 账物分离 batch2 守卫:终态收口写正本 runtimeDiagnostics 时,只保留有读者的子字段,
// 砍掉零读者取证子字段。反证见文末注释(临时恢复写入→本文件必红)。
//
// 判据(本会话 grep 核实,非猜):
//   砍(零读者):contractRead / lateCompletion / duplicateTerminal
//     - contractRead 成功收口这份全库无人读(唯一消费者是 crash-recovery 自己的重试写点)
//     - lateCompletion 的租约机器已整体退役(arm 侧 v136,读侧 2026-08-26 整删)
//     - duplicateTerminal 全库无人读
//   留(有读者):executionTrace(graph-route 崩溃冷兜底)/ ioObservation(交付)/
//     deliveryTicketId(展示)/ executionIncident(operator 快照 summarizeWorkItem +
//     listRecentRuntimeIncidents 读 workItem.runtimeDiagnostics.executionIncident,
//     workItem 直接来自正本 contract.runtimeDiagnostics —— tracking-work-item.js:45)
import {
  handleSuccessfulTrackingCompletion,
} from "../lib/lifecycle/agent-end/terminal.js";
import {
  createTrackingState,
} from "../lib/session/session-bootstrap.js";
import {
  getContractPath,
  persistContractById,
} from "../lib/contract/contracts.js";
import {
  registerRuntimeAgents,
} from "../lib/agent/agent-identity.js";
import {
  CONTRACT_STATUS,
} from "../lib/core/runtime-status.js";
import { runtimeAgentConfigs } from "../lib/state.js";
import {
  openSessionProgress,
  clearSessionProgress,
} from "../lib/evidence/session-progress-projection.js";
import {
  upsertExecutionIncident,
  clearExecutionIncident,
} from "../lib/runtime/execution-incident-store.js";

const logger = { info() {}, warn() {}, error() {} };

function registerWorker() {
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: "worker",
          binding: {
            roleRef: "planner",
            workspace: { configured: "~/.openclaw/workspaces/worker" },
            model: { ref: "demo/worker" },
          },
        },
      ],
    },
  });
}

test("batch2: 成功收口砍零读者取证子字段,保留 executionTrace/executionIncident 与交付链字段", async () => {
  const contractId = `TC-BATCH2-SLIM-${Date.now()}`;
  registerWorker();
  const contractPath = await persistContractById({
    id: contractId,
    task: "batch2 守卫任务",
    assignee: "worker",
    replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    phases: ["执行"],
    total: 1,
    output: `/tmp/${contractId}.md`,
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: { version: 1, envelope: "execution_contract", transport: "contracts/*.json", source: "webui" },
  }, logger);

  const sessionKey = `agent:worker:test:${Date.now()}`;
  const trackingState = createTrackingState({ sessionKey, agentId: "worker", parentSession: null });
  trackingState.contract = {
    id: contractId,
    task: "batch2 守卫任务",
    assignee: "worker",
    phases: ["执行"],
    total: 1,
    output: `/tmp/${contractId}.md`,
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: { version: 1, envelope: "execution_contract" },
    path: contractPath,
  };

  // 种子:让"有读者"的两个子字段的写入前置条件成立,证明瘦身是外科手术、没误伤它们。
  openSessionProgress(sessionKey, trackingState.contract, { agentId: "worker" }); // → executionTrace
  upsertExecutionIncident({ contractId, rootFault: "test_root_fault", firstFaultCode: "E-TEST-001" }); // → executionIncident

  try {
    const context = {
      agentId: "worker",
      sessionKey,
      event: { success: true, error: null },
      trackingState,
      effectiveContractData: {
        id: contractId,
        task: "batch2 守卫任务",
        status: CONTRACT_STATUS.PENDING, // 非终态 → 走 else(非重复)分支
        phases: ["执行"],
        total: 1,
        output: `/tmp/${contractId}.md`,
      },
      executionObservation: { collected: true, contractId, status: CONTRACT_STATUS.PENDING },
      systemActionResult: null,
      // 关键:被砍字段的触发条件摆上——即使触发,也不该出现在正本。
      // (lateCompletionLease 的租约机器 2026-08-26 已整删,context 不再有该字段)
      contractReadDiagnostic: { lane: "contract_read", error: "seeded diagnostic", ts: Date.now() },
      api: { runtime: { system: { requestHeartbeatNow() {} } } },
      logger,
    };

    await handleSuccessfulTrackingCompletion(context);

    const rd = trackingState.contract.runtimeDiagnostics || {};

    // 砍掉的三个取证子字段:即使触发条件成立,也不写正本。
    assert.equal(rd.contractRead, undefined, "batch2: contractRead 不该写进正本 runtimeDiagnostics");
    assert.equal(rd.lateCompletion, undefined, "batch2: lateCompletion 不该写进正本 runtimeDiagnostics");
    assert.equal(rd.duplicateTerminal, undefined, "batch2: duplicateTerminal 不该出现在非重复分支");

    // 保留的有读者子字段:瘦身不能误伤。
    assert.ok(rd.executionTrace, "batch2: executionTrace 必须保留(graph-route 崩溃冷兜底读它)");
    assert.ok(rd.executionIncident, "batch2: executionIncident 必须保留(operator 快照读它)");
    assert.equal(rd.executionIncident.rootFault, "test_root_fault");
    assert.ok(rd.deliveryTicketId, "batch2: deliveryTicketId 必须保留(展示读它)");

    // 交付链字段不动(delivery-result 真读):不误伤。
    assert.ok(trackingState.contract.executionObservation, "executionObservation 不动");
    assert.ok(trackingState.contract.terminalOutcome, "terminalOutcome 不动");

    // 盘上正本同步(mergeTrackingContractFields 落盘)。
    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(persisted.runtimeDiagnostics?.contractRead, undefined);
    assert.equal(persisted.runtimeDiagnostics?.lateCompletion, undefined);
    assert.equal(persisted.runtimeDiagnostics?.duplicateTerminal, undefined);
  } finally {
    clearSessionProgress(sessionKey);
    clearExecutionIncident({ contractId });
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
  }
});

test("batch2: 重复终态收口分支不再写 duplicateTerminal(executionTrace 仍写)", async () => {
  const contractId = `TC-BATCH2-DUP-${Date.now()}`;
  registerWorker();
  const contractPath = await persistContractById({
    id: contractId,
    task: "batch2 重复终态守卫",
    assignee: "worker",
    replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    phases: ["执行"],
    total: 1,
    output: `/tmp/${contractId}.md`,
    status: CONTRACT_STATUS.COMPLETED,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: { version: 1, envelope: "execution_contract", transport: "contracts/*.json", source: "webui" },
  }, logger);

  const sessionKey = `agent:worker:dup:${Date.now()}`;
  const trackingState = createTrackingState({ sessionKey, agentId: "worker", parentSession: null });
  trackingState.contract = {
    id: contractId,
    task: "batch2 重复终态守卫",
    assignee: "worker",
    phases: ["执行"],
    total: 1,
    output: `/tmp/${contractId}.md`,
    status: CONTRACT_STATUS.COMPLETED,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: { version: 1, envelope: "execution_contract" },
    path: contractPath,
  };

  openSessionProgress(sessionKey, trackingState.contract, { agentId: "worker" }); // → executionTrace 让 runtimeDiagnostics 非空并落盘

  try {
    const context = {
      agentId: "worker",
      sessionKey,
      event: { success: true, error: null },
      trackingState,
      // 终态 effectiveContractData → duplicateTerminalContract=true → 走重复分支
      effectiveContractData: {
        id: contractId,
        task: "batch2 重复终态守卫",
        status: CONTRACT_STATUS.COMPLETED,
        terminalOutcome: { status: CONTRACT_STATUS.COMPLETED, reason: "already done" },
        phases: ["执行"],
        total: 1,
        output: `/tmp/${contractId}.md`,
      },
      executionObservation: { collected: true, contractId, status: CONTRACT_STATUS.COMPLETED },
      systemActionResult: null,
      contractReadDiagnostic: null,
      api: { runtime: { system: { requestHeartbeatNow() {} } } },
      logger,
    };

    await handleSuccessfulTrackingCompletion(context);

    const rd = trackingState.contract.runtimeDiagnostics || {};
    assert.equal(rd.duplicateTerminal, undefined, "batch2: 重复终态分支不该写 duplicateTerminal");
    assert.ok(rd.executionTrace, "batch2: executionTrace 仍写(瘦身只砍取证字段)");
  } finally {
    clearSessionProgress(sessionKey);
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
  }
});
