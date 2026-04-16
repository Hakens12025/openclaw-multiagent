import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { loadGraph, saveGraph } from "../lib/agent/agent-graph.js";
import { SYSTEM_ACTION_STATUS } from "../lib/core/runtime-status.js";
import { INTENT_TYPES } from "../lib/protocol-primitives.js";
import { agentWorkspace } from "../lib/state.js";
import { systemActionDispatch } from "../lib/system-action/system-action-runtime.js";
import { runGlobalTestEnvironmentSerial } from "./test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("systemActionDispatch wake_agent ignores legacy context payload and only requests wake", async () => runGlobalTestEnvironmentSerial(async () => {
  const suffix = `${Date.now()}`;
  const sourceAgent = `wake-context-source-${suffix}`;
  const targetAgent = `wake-context-target-${suffix}`;
  const originalGraph = await loadGraph();
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
    await saveGraph(originalGraph);
    await rm(agentWorkspace(sourceAgent), { recursive: true, force: true });
    await rm(agentWorkspace(targetAgent), { recursive: true, force: true });
  }
}));
