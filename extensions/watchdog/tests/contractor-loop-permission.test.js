import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";

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
import { LOOP_SESSION_STATE_FILE } from "../lib/loop/loop-session-store.js";
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

test("system action reply target preserves live QQ metadata from the current contract", () => {
  const replyTo = {
    agentId: "agent-for-kksl",
    sessionKey: "agent:agent-for-kksl:main",
    channel: "qqbot",
    target: "c2c:live-user",
    messageId: "msg-1",
    replyToId: "msg-1",
    accountId: "default",
  };

  assert.deepEqual(
    buildSystemActionReplyTarget({
      agentId: "agent-for-kksl",
      sessionKey: "agent:agent-for-kksl:contract:TC-QQ-ACTION",
      contractData: { replyTo },
    }),
    replyTo,
  );
});

test("system action reply target does not synthesize QQ delivery target from agent identity", () => {
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);
  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("agent-for-kksl", {
      id: "agent-for-kksl",
      role: "bridge",
      gateway: true,
      ingressSource: "qq",
    });

    assert.deepEqual(
      buildSystemActionReplyTarget({
        agentId: "agent-for-kksl",
        sessionKey: "agent:agent-for-kksl:contract:TC-QQ-ACTION",
        contractData: { id: "TC-QQ-ACTION" },
      }),
      {
        agentId: "agent-for-kksl",
        sessionKey: "agent:agent-for-kksl:contract:TC-QQ-ACTION",
      },
    );
  } finally {
    runtimeAgentConfigs.clear();
    for (const [agentId, config] of originalRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(agentId, config);
    }
  }
});
