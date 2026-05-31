import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

const qqMessages = [];
const fanoutMessages = [];

mock.module("../lib/channel-notify.js", {
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

mock.module("../lib/routing/delivery-targets.js", {
  namedExports: {
    deliverDeliveryTargets: async (targets, message) => {
      fanoutMessages.push({ targets, message });
      return [{ ok: true, channel: "mock_fanout" }];
    },
    excludeDeliveryTargets: (targets) => targets,
    listContractDeliveryTargets: (contract) => contract?.deliveryTargets || [],
  },
});

const { deliveryRunTerminalRuntime } = await import("../lib/routing/delivery-terminal-runtime.js");

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

test("QQ awaiting-input delivery keeps internal clarification out of primary and fanout copy", async () => {
  qqMessages.length = 0;
  fanoutMessages.length = 0;
  const contractId = `TC-QQ-AWAITING-SAFE-${Date.now()}`;

  const result = await deliveryRunTerminalRuntime({
    trackingState: {
      status: CONTRACT_STATUS.AWAITING_INPUT,
      startMs: Date.now() - 120000,
      toolCallTotal: 3,
      agentId: "worker-a",
      contract: {
        id: contractId,
        task: "awaiting input must not expose runtime internals",
        replyTo: {
          channel: "qqbot",
          target: "qq-user-1",
        },
      },
    },
    contractData: {
      id: contractId,
      task: "awaiting input must not expose runtime internals",
      replyTo: {
        channel: "qqbot",
        target: "qq-user-1",
      },
      deliveryTargets: [
        { channel: "qqbot", target: "qq-user-2" },
      ],
    },
    terminalStatus: CONTRACT_STATUS.AWAITING_INPUT,
    outcome: {
      status: CONTRACT_STATUS.AWAITING_INPUT,
      source: "completion_criteria",
      reason: "missing runtime_result: contract.output missing completion_criteria evidence",
      clarification: "runtime incident: tool_write_failed while reading contract.output",
    },
    api: null,
    logger,
  });

  assert.equal(result.ok, true);
  assert.equal(qqMessages.length, 1);
  assert.equal(fanoutMessages.length, 1);
  assert.match(qqMessages[0].text, /任务需要补充信息/u);
  assert.match(qqMessages[0].text, /请补充必要输入/u);
  assert.doesNotMatch(qqMessages[0].text, /runtime_result|contract\.output|completion_criteria|tool_write_failed|runtime incident/iu);
  assert.doesNotMatch(fanoutMessages[0].message, /runtime_result|contract\.output|completion_criteria|tool_write_failed|runtime incident/iu);
});
