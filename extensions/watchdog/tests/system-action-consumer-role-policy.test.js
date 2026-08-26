// system-action-consumer-role-policy.test.js — 消费门 known-but-denied 单元级对照面
//
// collab 预设 create-task-denied 案(E-SYSACTION-002)把"门本身好不好"与"探针
// 引导/拓扑有效性"解耦的那一半:直接驱动 systemActionConsume 的 injectedAction
// 路(即 [ACTION] 文本提取路),断言角色策略门在任何副作用之前结构化拒绝,并向
// SSE 广播 system_action_role_policy_rejected(2026-08-26 live 取证:拒绝真发生
// 在 executor(worker)身上,门是好的;探针失败根因在拓扑,见 suite-collab.js)。

import test from "node:test";
import assert from "node:assert/strict";

import { runtimeAgentConfigs } from "../lib/state.js";
import { addSseClient, removeSseClient } from "../lib/transport/sse.js";
import { EVENT_TYPE } from "../lib/core/event-types.js";
import { SYSTEM_ACTION_STATUS } from "../lib/core/runtime-status.js";
import { systemActionConsume } from "../lib/system-action/system-action-consumer.js";

const silentLogger = { info() {}, warn() {}, error() {} };

function captureSseFrames() {
  const frames = [];
  const client = {
    finished: false,
    destroyed: false,
    write: (payload) => { frames.push(payload); },
  };
  addSseClient(client);
  return {
    frames,
    close: () => removeSseClient(client),
  };
}

function parseAlertData(frame) {
  const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
  return dataLine ? JSON.parse(dataLine.slice("data: ".length)) : null;
}

async function consumeCreateTaskAs(agentId, role) {
  runtimeAgentConfigs.set(agentId, { role });
  const capture = captureSseFrames();
  try {
    const result = await systemActionConsume({
      agentId,
      sessionKey: `agent:${agentId}:contract:tc-unit-probe`,
      contractData: null,
      api: null,
      logger: silentLogger,
      injectedAction: { type: "create_task", params: { message: "unit probe" } },
    });
    const alertFrame = capture.frames.find(
      (frame) => frame.includes(EVENT_TYPE.SYSTEM_ACTION_ROLE_POLICY_REJECTED),
    );
    return { result, alert: alertFrame ? parseAlertData(alertFrame) : null };
  } finally {
    capture.close();
    runtimeAgentConfigs.delete(agentId);
  }
}

test("consumer gate: planner 的 [ACTION] create_task 在副作用之前结构化拒绝并广播告警", async () => {
  const { result, alert } = await consumeCreateTaskAs("unit-policy-planner", "planner");
  assert.equal(result.rolePolicyRejected, true);
  assert.equal(result.status, SYSTEM_ACTION_STATUS.DISPATCH_ERROR);
  assert.equal(result.actionType, "create_task");
  assert.match(result.error, /create_task/);
  assert.ok(alert, "拒绝必须广播 system_action_role_policy_rejected(探针的确定性观测面)");
  assert.equal(alert.type, EVENT_TYPE.SYSTEM_ACTION_ROLE_POLICY_REJECTED);
  assert.equal(alert.source, "unit-policy-planner");
  assert.equal(alert.role, "planner");
  assert.equal(alert.actionType, "create_task");
});

test("consumer gate: executor 的 create_task 同样拒绝(allowed 集为空;2026-08-26 live 同款路径)", async () => {
  const { result, alert } = await consumeCreateTaskAs("unit-policy-executor", "executor");
  assert.equal(result.rolePolicyRejected, true);
  assert.match(result.error, /<none>/, "executor 的拒绝理由如实标注空授权集");
  assert.ok(alert);
  assert.equal(alert.role, "executor");
  assert.equal(alert.source, "unit-policy-executor");
});
