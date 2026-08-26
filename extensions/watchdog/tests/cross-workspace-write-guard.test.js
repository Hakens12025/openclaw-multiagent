import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import * as beforeToolCallHook from "../hooks/before-tool-call.js";
import { createTrackingState } from "../lib/session/session-bootstrap.js";
import { agentWorkspace, runtimeAgentConfigs } from "../lib/state.js";
import { clearTrackingStore, rememberTrackingState } from "../lib/store/tracker-store.js";
import { registerTestAgent } from "./helpers/register-agent.js";

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

function assertPositiveAgentVisibleBlockReason(blockReason) {
  assert.doesNotMatch(
    blockReason || "",
    /未配置|缺少|未包含|不在|已关闭|非敏感|已拦截|不要|不得|不能/u,
  );
}

test.afterEach(() => {
  runtimeAgentConfigs.clear();
  clearTrackingStore();
});

function setupWorkerSession({ agentId, contractOutput }) {
  const sessionKey = `agent:${agentId}:contract:test`;
  registerTestAgent(agentId);
  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-cross-ws-guard",
    assignee: agentId,
    output: contractOutput ?? join(agentWorkspace(agentId), "output", "TC-cross-ws-guard.md"),
    status: "running",
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);
  return { sessionKey };
}

function buildHandler() {
  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  return getHandler("before_tool_call");
}

test("write into another agent's workspace is blocked with a positive relative-path hint", async () => {
  const agentId = `worker-cross-ws-${Date.now()}`;
  const { sessionKey } = setupWorkerSession({ agentId });
  const handler = buildHandler();

  const foreignPath = join(process.env.HOME, ".openclaw", "workspaces", "planner", "outbox", "notes.md");
  const result = await handler(
    { toolName: "write", params: { file_path: foreignPath, content: "hello" } },
    { agentId, sessionKey },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /工作区/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
  assert.doesNotMatch(
    result?.blockReason || "",
    /\/Users\//u,
    "cross-workspace guard should keep absolute paths out of the agent-visible reason",
  );
});

test("edit into another agent's workspace is blocked too", async () => {
  const agentId = `worker-cross-ws-edit-${Date.now()}`;
  const { sessionKey } = setupWorkerSession({ agentId });
  const handler = buildHandler();

  const result = await handler(
    {
      toolName: "edit",
      params: {
        file_path: join(process.env.HOME, ".openclaw", "workspaces", "reviewer1", "inbox", "contract.json"),
        new_string: "x",
      },
    },
    { agentId, sessionKey },
  );

  assert.equal(result?.block, true);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
});

test("write inside the agent's own workspace stays allowed", async () => {
  const agentId = `worker-own-ws-${Date.now()}`;
  const { sessionKey } = setupWorkerSession({ agentId });
  const handler = buildHandler();

  const result = await handler(
    { toolName: "write", params: { file_path: "outbox/draft.md", content: "hello" } },
    { agentId, sessionKey },
  );

  assert.equal(result?.block, undefined);
});

test("writing the declared contract.output is allowed even when it lives in another agent's workspace", async () => {
  const agentId = `worker-contract-out-${Date.now()}`;
  const contractOutput = join(
    process.env.HOME, ".openclaw", "workspaces", "controller", "output", "TC-cross-ws-guard.md",
  );
  const { sessionKey } = setupWorkerSession({ agentId, contractOutput });
  const handler = buildHandler();

  const result = await handler(
    { toolName: "write", params: { file_path: contractOutput, content: "# 交付\n内容足够长的合法产物。" } },
    { agentId, sessionKey },
  );

  assert.equal(result?.block, undefined);
});

test("writes outside the workspaces tree (external project files) stay allowed for executors", async () => {
  const agentId = `worker-external-${Date.now()}`;
  const { sessionKey } = setupWorkerSession({ agentId });
  const handler = buildHandler();

  const result = await handler(
    {
      toolName: "write",
      params: { file_path: "/Users/hakens/some-external-project/main.js", content: "console.log(1);" },
    },
    { agentId, sessionKey },
  );

  assert.equal(result?.block, undefined);
});
