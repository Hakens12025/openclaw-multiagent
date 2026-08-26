// tests/system-action-legacy-payload-rejection.test.js
// 原名 contractor-loop-permission.test.js。2026-08-18 loop 退役时确认:本文件用例
// 没有一条属于回路本体,loopId / pipeline_id 只是【被拒载荷】的输入数据。
// 2026-08-19 归位:回件目标那两条已拆去 system-action-reply-target.test.js ——
// 混装两类保护本身就说明位置不对。本文件此后单守一件事:
//   legacy start_pipeline 族载荷必须被判 UNKNOWN_ACTION,且 ingress 元数据不得救活它。
import test from "node:test";
import assert from "node:assert/strict";

import {
  registerRuntimeAgents,
} from "../lib/agent/agent-identity.js";
import {
  buildSystemActionReplyTarget,
  systemActionConsume,
} from "../lib/system-action/system-action-consumer.js";
import {
  SYSTEM_ACTION_STATUS,
} from "../lib/core/runtime-status.js";
import { runtimeAgentConfigs } from "../lib/state.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

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
      wakeContractor: () => Promise.resolve({ ok: true }),
      logger,
      injectedAction: action,
    });

    assert.equal(result.status, SYSTEM_ACTION_STATUS.UNKNOWN_ACTION);
    assert.equal(result.actionType, "start_pipeline");
  });
});
