import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph } from "../lib/agent/agent-graph-mutations.js";
import { SYSTEM_ACTION_STATUS } from "../lib/core/runtime-status.js";
import { INTENT_TYPES } from "../lib/protocol-primitives.js";
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

test("systemActionDispatch wake_agent and assign_task cannot bypass missing graph edges", async () => runGlobalTestEnvironmentSerial(async () => {
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

    assert.equal(wakeResult?.status, SYSTEM_ACTION_STATUS.INVALID_STATE);
    assert.match(wakeResult?.error || "", /graph disallows wake_agent/);
    assert.equal(assignResult?.status, SYSTEM_ACTION_STATUS.INVALID_STATE);
    assert.match(assignResult?.error || "", /graph disallows assign_task/);
    assert.equal(heartbeatCalls.length, 0);
    await assert.rejects(
      readFile(join(agentWorkspace(targetAgent), "inbox", "contract.json"), "utf8"),
      /ENOENT/,
    );
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
    await rm(agentWorkspace(sourceAgent), { recursive: true, force: true });
    await rm(agentWorkspace(targetAgent), { recursive: true, force: true });
  }
}));
