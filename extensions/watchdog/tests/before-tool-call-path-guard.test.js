import test from "node:test";
import assert from "node:assert/strict";

import * as beforeToolCallHook from "../hooks/before-tool-call.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { runtimeAgentConfigs } from "../lib/state.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

function createHookApi() {
  const handlers = new Map();
  return {
    api: {
      on(eventName, handler) {
        handlers.set(eventName, handler);
      },
    },
    getHandler(eventName) {
      const handler = handlers.get(eventName);
      assert.equal(typeof handler, "function", `missing handler for ${eventName}`);
      return handler;
    },
  };
}

test("planner relative inbox reads are allowed by before_tool_call path guard", async () => {
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: "planner",
          role: "planner",
          workspace: "~/.openclaw/workspaces/planner",
          model: { primary: "demo/planner" },
        },
      ],
    },
  });

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  try {
    const result = await handler(
      {
        toolName: "read",
        params: {
          path: "inbox/contract.json",
        },
      },
      {
        agentId: "planner",
        sessionKey: "agent:planner:contract:test",
      },
    );

    assert.equal(result?.block, undefined);
  } finally {
    runtimeAgentConfigs.clear();
  }
});
