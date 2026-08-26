import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

const qqMessages = [];
const fanoutMessages = [];

mock.module("../lib/transport/channel-notify.js", {
  namedExports: {
    getQQTarget: (contract) => {
      if (contract?.replyTo?.channel === "qqbot" && contract.replyTo.target) {
        return { target: contract.replyTo.target };
      }
      return null;
    },
    getQQTargetAddress: (target) => target?.target || null,
    qqNotify: async (target, text) => {
      qqMessages.push({ target, text });
      return { ok: true, messageId: "mock-message" };
    },
  },
});

mock.module("../lib/routing/delivery/delivery-targets.js", {
  namedExports: {
    deliverDeliveryTargets: async (targets, message) => {
      fanoutMessages.push({ targets, message });
      return [{ ok: true, channel: "mock_fanout" }];
    },
    excludeDeliveryTargets: (targets) => targets,
    listContractDeliveryTargets: (contract) => contract?.deliveryTargets || [],
  },
});

const { deliveryRunTerminalRuntime } = await import("../lib/routing/delivery/delivery-terminal-runtime.js");

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("QQ completed delivery without artifact stays minimal and does not expose task or runtime metadata", async () => {
  qqMessages.length = 0;
  const contractId = `TC-QQ-MINIMAL-${Date.now()}`;
  const internalTask = "这是不应该回显给用户的内部任务正文";

  const result = await deliveryRunTerminalRuntime({
    trackingState: {
      status: CONTRACT_STATUS.COMPLETED,
      startMs: Date.now() - 120000,
      toolCallTotal: 7,
      contract: {
        id: contractId,
        task: internalTask,
        replyTo: {
          channel: "qqbot",
          target: "qq-user-1",
        },
      },
    },
    contractData: {
      id: contractId,
      task: internalTask,
      replyTo: {
        channel: "qqbot",
        target: "qq-user-1",
      },
    },
    terminalStatus: CONTRACT_STATUS.COMPLETED,
    outcome: {
      status: CONTRACT_STATUS.COMPLETED,
      source: "completion_criteria",
    },
    api: null,
    logger,
  });

  assert.equal(result.ok, true);
  assert.equal(qqMessages.length, 1);
  assert.match(qqMessages[0].text, /任务完成/u);
  assert.doesNotMatch(qqMessages[0].text, /工具调用|耗时|内部任务正文|runtime_result|completion_criteria/iu);
});

test("QQ failure delivery carries the handoff gate summary and a stage locator", async () => {
  qqMessages.length = 0;
  fanoutMessages.length = 0;
  const contractId = `TC-QQ-FAILED-SUMMARY-${Date.now()}`;
  const gateSummary = "产物为空或过短（8 字 < 24 阈值），未转发给下一环 worker-b；需重做并产出实质交付物";

  const result = await deliveryRunTerminalRuntime({
    trackingState: {
      status: CONTRACT_STATUS.FAILED,
      startMs: Date.now() - 60000,
      toolCallTotal: 2,
      agentId: "worker-a",
      contract: {
        id: contractId,
        task: "failed delivery must localize the failure",
        replyTo: { channel: "qqbot", target: "qq-user-1" },
      },
    },
    contractData: {
      id: contractId,
      task: "failed delivery must localize the failure",
      replyTo: { channel: "qqbot", target: "qq-user-1" },
      // 回路退役(B6b):「📍 环节」定位线索单源 = stageRuntime.currentStageId,
      // 原 pipelineStage.semanticStageId 路由段已随回路面移出 schema。
      stageRuntime: { version: 1, currentStageId: "research_stage", completedStageIds: [] },
      deliveryTargets: [{ channel: "qqbot", target: "qq-user-2" }],
    },
    terminalStatus: CONTRACT_STATUS.FAILED,
    outcome: {
      status: CONTRACT_STATUS.FAILED,
      source: "handoff_completion_gate",
      reason: "incomplete_output",
      summary: gateSummary,
    },
    api: null,
    logger,
  });

  assert.equal(result.ok, true);
  assert.equal(qqMessages.length, 1);
  assert.match(qqMessages[0].text, /任务失败/u);
  assert.ok(qqMessages[0].text.includes(gateSummary));
  assert.match(qqMessages[0].text, /环节: research_stage/u);
  // summary 占据说明位后，机器码 reason 不再露出。
  assert.doesNotMatch(qqMessages[0].text, /incomplete_output|handoff_completion_gate/iu);
  assert.ok(fanoutMessages[0].message.includes(gateSummary));
});

test("QQ failure delivery degrades a bare machine-code reason to the generic shell", async () => {
  qqMessages.length = 0;
  const contractId = `TC-QQ-FAILED-CODE-${Date.now()}`;

  const result = await deliveryRunTerminalRuntime({
    trackingState: {
      status: CONTRACT_STATUS.FAILED,
      startMs: Date.now() - 60000,
      toolCallTotal: 1,
      agentId: "worker-a",
      contract: {
        id: contractId,
        task: "machine codes stay out of user copy",
        replyTo: { channel: "qqbot", target: "qq-user-1" },
      },
    },
    contractData: {
      id: contractId,
      task: "machine codes stay out of user copy",
      replyTo: { channel: "qqbot", target: "qq-user-1" },
    },
    terminalStatus: CONTRACT_STATUS.FAILED,
    outcome: {
      status: CONTRACT_STATUS.FAILED,
      source: "execution_hard_stop",
      reason: "tool_write_failed",
    },
    api: null,
    logger,
  });

  assert.equal(result.ok, true);
  assert.equal(qqMessages.length, 1);
  assert.equal(qqMessages[0].text, "❌ 任务失败\n任务未完成。");
});

test("QQ failed delivery keeps internal reason text out of primary and fanout copy", async () => {
  // 原为 awaiting-input 案;该状态已随假等待态整体删除(2026-08-10)。
  // 锁的实质不变:内部机器码/诊断文本不得进入用户可见文案(主投递与 fanout 都不许)。
  qqMessages.length = 0;
  fanoutMessages.length = 0;
  const contractId = `TC-QQ-FAILED-SAFE-${Date.now()}`;

  const result = await deliveryRunTerminalRuntime({
    trackingState: {
      status: CONTRACT_STATUS.FAILED,
      startMs: Date.now() - 120000,
      toolCallTotal: 3,
      agentId: "worker-a",
      contract: {
        id: contractId,
        task: "failed delivery must not expose runtime internals",
        replyTo: {
          channel: "qqbot",
          target: "qq-user-1",
        },
      },
    },
    contractData: {
      id: contractId,
      task: "failed delivery must not expose runtime internals",
      replyTo: {
        channel: "qqbot",
        target: "qq-user-1",
      },
      deliveryTargets: [
        { channel: "qqbot", target: "qq-user-2" },
      ],
    },
    terminalStatus: CONTRACT_STATUS.FAILED,
    outcome: {
      status: CONTRACT_STATUS.FAILED,
      source: "deliverable",
      reason: "contract.output missing_file",
      clarification: "runtime incident: tool_write_failed while reading contract.output",
    },
    api: null,
    logger,
  });

  assert.equal(result.ok, true);
  assert.equal(qqMessages.length, 1);
  assert.equal(fanoutMessages.length, 1);
  assert.match(qqMessages[0].text, /任务失败/u);
  assert.doesNotMatch(qqMessages[0].text, /missing_file|contract\.output|tool_write_failed|runtime incident/iu);
  assert.doesNotMatch(fanoutMessages[0].message, /missing_file|contract\.output|tool_write_failed|runtime incident/iu);
});

// BC-8(回路退役 schema 收口,2026-08-18):「📍 环节」定位线索的取值链由
// pipelineStage.semanticStageId → pipelineStage.stage → stageRuntime.currentStageId
// 三级收成 stageRuntime 单源。contract.pipelineStage 整个路由段已移出 schema,
// 历史落盘合约不迁移 —— 因此残值必须是惰性的,不得再被当作阶段真值抬出来给用户看。
test("BC-8: stage locator reads stageRuntime only, legacy pipelineStage residue stays inert", async () => {
  const { resolveContractStageLabel } = await import("../lib/routing/delivery/delivery-result-extract.js");

  assert.equal(
    resolveContractStageLabel({ stageRuntime: { version: 1, currentStageId: "research_stage" } }),
    "research_stage",
  );
  assert.equal(
    resolveContractStageLabel({ pipelineStage: { stage: "legacy", semanticStageId: "legacy_stage" } }),
    "",
  );
  assert.equal(resolveContractStageLabel(null), "");
});
