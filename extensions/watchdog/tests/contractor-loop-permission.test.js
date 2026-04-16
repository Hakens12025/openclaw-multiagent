import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";

import {
  registerRuntimeAgents,
} from "../lib/agent/agent-identity.js";
import {
  systemActionConsume,
} from "../lib/system-action/system-action-consumer.js";
import {
  SYSTEM_ACTION_STATUS,
} from "../lib/core/runtime-status.js";
import { LOOP_SESSION_STATE_FILE } from "../lib/loop/loop-session-store.js";
import { runtimeAgentConfigs } from "../lib/state.js";
import { runGlobalTestEnvironmentSerial } from "./test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

function createApi() {
  return {
    runtime: {
      system: {
        requestHeartbeatNow() {},
      },
    },
  };
}

async function withContractorAction(action, callback) {
  return runGlobalTestEnvironmentSerial(async () => {
    let originalLoopSessionState = null;
    try {
      originalLoopSessionState = await readFile(LOOP_SESSION_STATE_FILE, "utf8");
    } catch {}

    await unlink(LOOP_SESSION_STATE_FILE).catch(() => {});
    registerRuntimeAgents({
      agents: {
        list: [
          {
            id: "contractor",
            binding: {
              roleRef: "planner",
              workspace: { configured: "~/.openclaw/workspaces/contractor" },
              model: { ref: "demo/contractor" },
            },
          },
        ],
      },
    });

    try {
      await callback(action);
    } finally {
      runtimeAgentConfigs.clear();
      if (originalLoopSessionState == null) {
        await unlink(LOOP_SESSION_STATE_FILE).catch(() => {});
      } else {
        await writeFile(LOOP_SESSION_STATE_FILE, originalLoopSessionState, "utf8");
      }
    }
  });
}

test("legacy contractor start_pipeline payload is rejected as unknown action", async () => {
  await withContractorAction({
    action: "start_pipeline",
    pipeline_id: "research-loop",
    input: {
      task: "对比 React、Vue、Svelte 三个框架的优缺点，写一份报告",
    },
  }, async (action) => {
    const result = await systemActionConsume({
      agentId: "contractor",
      sessionKey: `agent:contractor:test:${Date.now()}`,
      contractData: {
        id: `TC-LOOP-POLICY-${Date.now()}`,
        task: "对比 React、Vue、Svelte 三个框架的优缺点，写一份报告",
        planningContext: {
          activeLoopCandidates: [
            {
              loopId: "research-loop",
              entryAgentId: "researcher",
              nodes: ["researcher", "worker-d", "evaluator"],
            },
          ],
        },
      },
      api: createApi(),
      enqueueFn: () => {},
      wakeContractor: () => Promise.resolve({ ok: true }),
      logger,
      injectedAction: action,
    });

    assert.equal(result.status, SYSTEM_ACTION_STATUS.UNKNOWN_ACTION);
    assert.equal(result.actionType, "start_pipeline");
  });
});

test("ingress loopDispatch metadata does not rescue legacy contractor start_pipeline payload", async () => {
  await withContractorAction({
    action: "start_pipeline",
    pipeline_id: "research-loop",
    input: {
      task: "做一轮研究回路验证",
    },
  }, async (action) => {
    const result = await systemActionConsume({
      agentId: "contractor",
      sessionKey: `agent:contractor:test:${Date.now()}`,
      contractData: {
        id: `TC-EXPLICIT-LOOP-${Date.now()}`,
        task: "做一轮研究回路验证",
        planningContext: {
          loopDispatch: {
            requested: true,
            loopId: "research-loop",
          },
          activeLoopCandidates: [
            {
              loopId: "research-loop",
              entryAgentId: "researcher",
              nodes: ["researcher", "worker-d", "evaluator"],
            },
          ],
        },
      },
      api: createApi(),
      enqueueFn: () => {},
      wakeContractor: () => Promise.resolve({ ok: true }),
      logger,
      injectedAction: action,
    });

    assert.equal(result.status, SYSTEM_ACTION_STATUS.UNKNOWN_ACTION);
    assert.equal(result.actionType, "start_pipeline");
  });
});
