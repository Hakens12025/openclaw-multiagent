import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph as saveGraphUnattributed } from "../lib/agent/agent-graph-mutations.js";

// §13 整写门:测试夹具写图报身份(writer),edge 级差异日志可追溯到本文件。
const saveGraph = (graph) => saveGraphUnattributed(graph, { writer: "test:system-action-context.test.js" });
import { SYSTEM_ACTION_STATUS } from "../lib/core/runtime-status.js";
import { INTENT_TYPES } from "../lib/protocol/protocol-primitives.js";
import { agentWorkspace, runtimeAgentConfigs } from "../lib/state.js";
import { systemActionDispatch } from "../lib/system-action/system-action-runtime.js";
import { WAKE_SEMANTIC_TYPE } from "../lib/transport/runtime-wake-envelope.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

function registerSystemActionRuntimeAgents(agentIds) {
  for (const agentId of agentIds) {
    runtimeAgentConfigs.set(agentId, {
      id: agentId,
      role: "agent",
      plane: "runtime",
      mainViewVisible: true,
      formalTimelineVisible: true,
      autoWakeEligible: true,
    });
  }
}

function restoreRuntimeAgentConfigs(snapshot) {
  runtimeAgentConfigs.clear();
  for (const [agentId, config] of snapshot.entries()) {
    runtimeAgentConfigs.set(agentId, config);
  }
}

test("systemActionDispatch wake_agent ignores legacy context payload and only requests wake", async () => runGlobalTestEnvironmentSerial(async () => {
  const suffix = `${Date.now()}`;
  const sourceAgent = `wake-context-source-${suffix}`;
  const targetAgent = `wake-context-target-${suffix}`;
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);
  const contextPayload = {
    manual: true,
    note: "显式唤醒上下文",
    nested: {
      stage: "review",
      owner: sourceAgent,
    },
  };
  const heartbeatCalls = [];

  try {
    registerSystemActionRuntimeAgents([sourceAgent, targetAgent]);
    await saveGraph({
      edges: [
        { from: sourceAgent, to: targetAgent, label: "wake" },
      ],
    });

    const result = await systemActionDispatch({
      type: INTENT_TYPES.WAKE_AGENT,
      params: {
        targetAgent,
        reason: "manual wake for explicit context",
        context: contextPayload,
      },
    }, {
      agentId: sourceAgent,
      sessionKey: `agent:${sourceAgent}:wake-context`,
      contractData: {
        id: `TC-WAKE-CONTEXT-${suffix}`,
      },
      api: {
        runtime: {
          system: {
            requestHeartbeatNow(payload) {
              heartbeatCalls.push(payload);
            },
          },
        },
      },
      logger,
    });

    assert.equal(result?.status, SYSTEM_ACTION_STATUS.DISPATCHED);
    assert.equal(result?.targetAgent, targetAgent);
    assert.ok(heartbeatCalls.some((payload) => payload?.agentId === targetAgent));

    await assert.rejects(
      readFile(join(agentWorkspace(targetAgent), "inbox", "context.json"), "utf8"),
      /ENOENT/,
    );
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
    await rm(agentWorkspace(sourceAgent), { recursive: true, force: true });
    await rm(agentWorkspace(targetAgent), { recursive: true, force: true });
  }
}));

test("systemActionDispatch wake_agent uses unified semantic wake reason when caller does not provide one", async () => runGlobalTestEnvironmentSerial(async () => {
  const suffix = `${Date.now()}`;
  const sourceAgent = `wake-semantic-source-${suffix}`;
  const targetAgent = `wake-semantic-target-${suffix}`;
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);
  const heartbeatCalls = [];

  try {
    registerSystemActionRuntimeAgents([sourceAgent, targetAgent]);
    await saveGraph({
      edges: [
        { from: sourceAgent, to: targetAgent, label: "wake" },
      ],
    });

    const result = await systemActionDispatch({
      type: INTENT_TYPES.WAKE_AGENT,
      params: {
        targetAgent,
      },
    }, {
      agentId: sourceAgent,
      sessionKey: `agent:${sourceAgent}:wake-semantic`,
      contractData: {
        id: `TC-WAKE-SEMANTIC-${suffix}`,
      },
      api: {
        runtime: {
          system: {
            requestHeartbeatNow(payload) {
              heartbeatCalls.push(payload);
            },
          },
        },
      },
      logger,
    });

    assert.equal(result?.status, SYSTEM_ACTION_STATUS.DISPATCHED);
    assert.equal(heartbeatCalls.length, 1);
    assert.equal(heartbeatCalls[0]?.wakeEnvelope?.semanticType, WAKE_SEMANTIC_TYPE.SYSTEM_ACTION_WAKE_AGENT);
    assert.equal(
      heartbeatCalls[0]?.reason,
      "继续当前协作任务。",
    );
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
    await rm(agentWorkspace(sourceAgent), { recursive: true, force: true });
    await rm(agentWorkspace(targetAgent), { recursive: true, force: true });
  }
}));

test("systemActionDispatch assign_task uses unified semantic wake reason when caller does not provide one", async () => runGlobalTestEnvironmentSerial(async () => {
  const suffix = `${Date.now()}`;
  const sourceAgent = `assign-semantic-source-${suffix}`;
  const targetAgent = `assign-semantic-target-${suffix}`;
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);
  const heartbeatCalls = [];

  try {
    registerSystemActionRuntimeAgents([sourceAgent, targetAgent]);
    await saveGraph({
      edges: [
        { from: sourceAgent, to: targetAgent, label: "assign" },
      ],
    });

    const result = await systemActionDispatch({
      type: INTENT_TYPES.ASSIGN_TASK,
      params: {
        targetAgent,
        message: "请处理这个协作任务",
      },
    }, {
      agentId: sourceAgent,
      sessionKey: `agent:${sourceAgent}:assign-semantic`,
      contractData: {
        id: `TC-ASSIGN-SEMANTIC-${suffix}`,
      },
      actionReplyTo: {
        agentId: sourceAgent,
        sessionKey: `agent:${sourceAgent}:main`,
      },
      api: {
        runtime: {
          system: {
            requestHeartbeatNow(payload) {
              heartbeatCalls.push(payload);
            },
          },
        },
      },
      logger,
    });

    assert.equal(result?.status, SYSTEM_ACTION_STATUS.DISPATCHED);
    assert.equal(result?.targetAgent, targetAgent);
    assert.equal(heartbeatCalls.length, 1);
    assert.equal(heartbeatCalls[0]?.wakeEnvelope?.semanticType, WAKE_SEMANTIC_TYPE.ASSIGN_TASK_DISPATCH);
    assert.equal(
      heartbeatCalls[0]?.reason,
      "处理当前协作任务。",
    );
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
    await rm(agentWorkspace(sourceAgent), { recursive: true, force: true });
    await rm(agentWorkspace(targetAgent), { recursive: true, force: true });
  }
}));

test("systemActionDispatch wake_agent and assign_task ignore graph topology but reject unknown and self targets", async () => runGlobalTestEnvironmentSerial(async () => {
  const suffix = `${Date.now()}`;
  const sourceAgent = `system-action-denied-source-${suffix}`;
  const targetAgent = `system-action-denied-target-${suffix}`;
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);
  const heartbeatCalls = [];

  try {
    registerSystemActionRuntimeAgents([sourceAgent, targetAgent]);
    await saveGraph({ edges: [] });
    const context = {
      agentId: sourceAgent,
      sessionKey: `agent:${sourceAgent}:denied`,
      contractData: {
        id: `TC-SYSTEM-ACTION-DENIED-${suffix}`,
      },
      actionReplyTo: {
        agentId: sourceAgent,
        sessionKey: `agent:${sourceAgent}:main`,
      },
      api: {
        runtime: {
          system: {
            requestHeartbeatNow(payload) {
              heartbeatCalls.push(payload);
            },
          },
        },
      },
      logger,
    };

    const wakeResult = await systemActionDispatch({
      type: INTENT_TYPES.WAKE_AGENT,
      params: { targetAgent },
    }, context);
    const assignResult = await systemActionDispatch({
      type: INTENT_TYPES.ASSIGN_TASK,
      params: {
        targetAgent,
        message: "this must not bypass graph topology",
      },
    }, context);

    // 图是固定管线的定义,不是动态协作的闸:空图不该拦住 agent 自己发起的协作。
    assert.notEqual(wakeResult?.status, SYSTEM_ACTION_STATUS.INVALID_STATE, wakeResult?.error || "");
    assert.notEqual(assignResult?.status, SYSTEM_ACTION_STATUS.INVALID_STATE, assignResult?.error || "");
    assert.ok(heartbeatCalls.length > 0, "wake_agent 应当真的把目标叫醒");
    const staged = await readFile(join(agentWorkspace(targetAgent), "inbox", "contract.json"), "utf8");
    assert.match(staged, /TC-/, "assign_task 应当把工单投进目标 inbox");

    // 但目标必须真实存在——打错名字要在受理时刻拿到结构化拒绝,而不是受理成功后静默失败。
    const unknownResult = await systemActionDispatch({
      type: INTENT_TYPES.ASSIGN_TASK,
      params: { targetAgent: `no-such-agent-${suffix}`, message: "typo target" },
    }, context);
    assert.equal(unknownResult?.status, SYSTEM_ACTION_STATUS.INVALID_STATE);
    assert.match(unknownResult?.error || "", /unknown target agent/);

    // 协作的对象是别人:自指在三个动作上都退化成自递归或空转。评审自指还多一层
    // 结构后果——被审包落 participants/<源>/outbox-<评审cid>/,源与 reviewer 同一个
    // agent 时那正是它本轮的采集 outbox,被审包会被封进它自己的交付。
    const selfResult = await systemActionDispatch({
      type: INTENT_TYPES.ASSIGN_TASK,
      params: { targetAgent: sourceAgent, message: "self target" },
    }, context);
    assert.equal(selfResult?.status, SYSTEM_ACTION_STATUS.INVALID_PARAMS);
    assert.match(selfResult?.error || "", /is the caller itself/);
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
    await rm(agentWorkspace(sourceAgent), { recursive: true, force: true });
    await rm(agentWorkspace(targetAgent), { recursive: true, force: true });
  }
}));
