import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as beforeToolCallHook from "../hooks/before-tool-call.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { agentWorkspace, runtimeAgentConfigs } from "../lib/state.js";
import { clearTrackingStore, rememberTrackingState } from "../lib/store/tracker-store.js";
import { CONTROL_PLANE_PATHS } from "../lib/control-plane/control-plane-paths.js";

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

test("stale contract session without active contract truth blocks tools after runtime cleanup", async () => {
  const agentId = `worker-stale-contract-session-${Date.now()}`;
  const contractId = `TC-stale-contract-session-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:${contractId}`;
  const contractOutput = join(CONTROL_PLANE_PATHS.outputDir, `${contractId}.md`);
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "write",
      params: {
        file_path: contractOutput,
        content: JSON.stringify({
          status: "running",
          tool: "read",
          error: "当前工作区等价别名。",
        }),
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /contract session/u);
  assert.match(result?.blockReason || "", /等待 runtime/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
});

test("contract session without tracker still requires own inbox contract read first", async () => {
  const agentId = `worker-path-guard-session-fallback-${Date.now()}`;
  const contractId = `TC-session-fallback-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:${contractId}`;
  const contractPath = getContractPath(contractId);
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  try {
    await persistContractSnapshot(contractPath, {
      id: contractId,
      task: "say hello",
      assignee: agentId,
      output: join(CONTROL_PLANE_PATHS.outputDir, `${contractId}.md`),
      status: "running",
    }, logger);

    const { api, getHandler } = createHookApi();
    beforeToolCallHook.register(api, logger);
    const handler = getHandler("before_tool_call");

    const result = await handler(
      {
        toolName: "read",
        params: {
          path: "SOUL.md",
        },
      },
      {
        agentId,
        sessionKey,
      },
    );

    assert.equal(result?.block, true);
    assert.match(result?.blockReason || "", /inbox\/contract\.json/u);
    assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
  } finally {
    await rm(contractPath, { force: true });
    await rm(agentWorkspace(agentId), { recursive: true, force: true });
  }
});

test("contract session without tracker still blocks contract.output reads before materialization", async () => {
  const agentId = `worker-path-guard-output-fallback-${Date.now()}`;
  const contractId = `TC-output-fallback-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:${contractId}`;
  const contractPath = getContractPath(contractId);
  const contractOutput = join(CONTROL_PLANE_PATHS.outputDir, `${contractId}.md`);
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  try {
    await persistContractSnapshot(contractPath, {
      id: contractId,
      task: "say hello",
      assignee: agentId,
      output: contractOutput,
      status: "running",
    }, logger);

    const trackingState = createTrackingState({
      sessionKey,
      agentId,
      parentSession: null,
    });
    trackingState.toolCallTotal = 1;
    trackingState.ownInboxContractReadAt = Date.now();
    trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
    rememberTrackingState(sessionKey, trackingState);

    const { api, getHandler } = createHookApi();
    beforeToolCallHook.register(api, logger);
    const handler = getHandler("before_tool_call");

    const result = await handler(
      {
        toolName: "read",
        params: {
          path: contractOutput,
        },
      },
      {
        agentId,
        sessionKey,
      },
    );

    assert.equal(result?.block, true);
    assert.match(result?.blockReason || "", /contract\.output/u);
    assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
  } finally {
    await rm(contractPath, { force: true });
    await rm(agentWorkspace(agentId), { recursive: true, force: true });
  }
});

test("planner relative inbox reads are allowed by before_tool_call path guard", async () => {
  const contractId = `TC-planner-relative-${Date.now()}`;
  const contractPath = getContractPath(contractId);
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
    await persistContractSnapshot(contractPath, {
      id: contractId,
      task: "plan this",
      assignee: "planner",
      output: join(CONTROL_PLANE_PATHS.outputDir, `${contractId}.md`),
      status: "running",
    }, logger);

    const result = await handler(
      {
        toolName: "read",
        params: {
          path: "inbox/contract.json",
        },
      },
      {
        agentId: "planner",
        sessionKey: `agent:planner:contract:${contractId}`,
      },
    );

    assert.equal(result?.block, undefined);
  } finally {
    await rm(contractPath, { force: true });
  }
});

test("contract-backed session requires own inbox contract read as the first tool call", async () => {
  const agentId = `worker-path-guard-first-step-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-first-step",
    assignee: agentId,
    output: join(agentWorkspace(agentId), "output", "TC-first-step.md"),
    status: "running",
  };
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "web_search",
      params: {
        query: "现在几点了",
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /inbox\/contract\.json/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
  assert.doesNotMatch(
    result?.blockReason || "",
    new RegExp(join(agentWorkspace(agentId), "inbox", "contract.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"),
    "first-step guard should keep the agent instruction on the relative inbox path",
  );
});

test("contract-backed session cannot read contract.output before it exists", async () => {
  const agentId = `worker-path-guard-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  const contractOutput = join(agentWorkspace(agentId), "output", "TC-read-guard.md");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-read-guard",
    assignee: agentId,
    output: contractOutput,
    status: "running",
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "read",
      params: {
        path: "output/TC-read-guard.md",
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /contract\.output/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
  // outbox 统一(f7769b5): hint 不再向 agent 暴露中央 output/alias 路径，只引导写 outbox/。
});

test("contract-backed session blocks output basename variants that probe current contract.output", async () => {
  const agentId = `worker-path-guard-output-variant-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  const contractOutput = join(CONTROL_PLANE_PATHS.outputDir, "TC-output-variant.md");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-output-variant",
    assignee: agentId,
    output: contractOutput,
    status: "running",
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "read",
      params: {
        path: "/control-plane/output/TC-output-variant.md",
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /contract\.output/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
});

test("contract-backed session cannot read another agent inbox as contract truth", async () => {
  const agentId = `worker-path-guard-inbox-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-read-guard-inbox",
    assignee: agentId,
    output: join(agentWorkspace(agentId), "output", "TC-read-guard-inbox.md"),
    status: "running",
  };
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "read",
      params: {
        path: join(process.env.HOME, ".openclaw", "workspaces", "controller", "inbox", "contract.json"),
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /inbox\/contract\.json/u);
  assert.doesNotMatch(result?.blockReason || "", /不要读取其他 agent/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
  assert.doesNotMatch(
    result?.blockReason || "",
    new RegExp(join(agentWorkspace(agentId), "inbox", "contract.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"),
    "other-inbox guard should keep the agent instruction on the relative inbox path",
  );
});

test("contract-backed session may read contract.output after it exists", async () => {
  const agentId = `worker-path-guard-existing-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  const workspaceDir = agentWorkspace(agentId);
  const contractOutput = join(workspaceDir, "output", "TC-existing-output.md");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  await mkdir(join(workspaceDir, "output"), { recursive: true });
  await writeFile(contractOutput, "ready", "utf8");

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-existing-output",
    assignee: agentId,
    output: contractOutput,
    status: "running",
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  try {
    const result = await handler(
      {
        toolName: "read",
        params: {
          path: "output/TC-existing-output.md",
        },
      },
      {
        agentId,
        sessionKey,
      },
    );

    assert.equal(result?.block, undefined);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("web_search is blocked when gateway has no Brave API key", async () => {
  const originalBraveApiKey = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;

  try {
    const agentId = `worker-path-guard-web-${Date.now()}`;
    const sessionKey = `agent:${agentId}:contract:test`;
    registerRuntimeAgents({
      agents: {
        list: [
          {
            id: agentId,
            role: "executor",
            workspace: `~/.openclaw/workspaces/${agentId}`,
            model: { primary: "demo/worker" },
          },
        ],
      },
    });

    const trackingState = createTrackingState({
      sessionKey,
      agentId,
      parentSession: null,
    });
    trackingState.contract = {
      id: "TC-web-search-unavailable",
      assignee: agentId,
      output: join(agentWorkspace(agentId), "output", "TC-web-search-unavailable.md"),
      status: "running",
    };
    trackingState.toolCallTotal = 1;
    trackingState.ownInboxContractReadAt = Date.now();
    trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
    rememberTrackingState(sessionKey, trackingState);

    const { api, getHandler } = createHookApi();
    beforeToolCallHook.register(api, logger);
    const handler = getHandler("before_tool_call");

    const result = await handler(
      {
        toolName: "web_search",
        params: {
          query: "现在几点了",
        },
      },
      {
        agentId,
        sessionKey,
      },
    );

    assert.equal(result?.block, true);
    assert.match(result?.blockReason || "", /web_search/u);
    assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
  } finally {
    if (typeof originalBraveApiKey === "string") {
      process.env.BRAVE_API_KEY = originalBraveApiKey;
    } else {
      delete process.env.BRAVE_API_KEY;
    }
  }
});

test("contract-backed sessions allow remote fetch tools after reading their own contract", async () => {
  const agentId = `worker-contract-fetch-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  const contractOutput = join(agentWorkspace(agentId), "output", "TC-contract-fetch.md");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-contract-fetch",
    assignee: agentId,
    output: contractOutput,
    status: "running",
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "web_fetch",
      params: {
        url: "https://example.com",
        maxChars: 400,
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, undefined);
});

test("contract-backed session blocks repeated rereads of inbox contract and points back to output", async () => {
  const agentId = `worker-contract-reread-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  const contractOutput = join(agentWorkspace(agentId), "output", "TC-contract-reread.md");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-contract-reread",
    assignee: agentId,
    output: contractOutput,
    status: "running",
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "read",
      params: {
        path: "inbox/contract.json",
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /已读取/u);
  assert.doesNotMatch(result?.blockReason || "", /不要再读取/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
  // outbox 统一(f7769b5): reread guard 不再暴露中央 output/alias 路径，引导写 outbox/。
});

test("contract-backed session still allows the first successful inbox read after earlier blocked attempts", async () => {
  const agentId = `worker-contract-recovery-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  const contractOutput = join(agentWorkspace(agentId), "output", "TC-contract-recovery.md");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-contract-recovery",
    assignee: agentId,
    output: contractOutput,
    status: "running",
  };
  trackingState.toolCallTotal = 1;
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "read",
      params: {
        path: "inbox/contract.json",
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, undefined);
});

test("contract-backed session cannot rewrite its own inbox contract truth", async () => {
  const agentId = `worker-inbox-contract-immutable-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  const contractOutput = join(agentWorkspace(agentId), "output", "TC-inbox-contract-immutable.md");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-inbox-contract-immutable",
    assignee: agentId,
    output: contractOutput,
    status: "running",
  };
  trackingState.ownInboxContractReadAt = Date.now();
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "write",
      params: {
        path: "inbox/contract.json",
        content: JSON.stringify(trackingState.contract, null, 2),
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /contract truth/u);
  assert.match(result?.blockReason || "", /runtime 管理/u);
  assert.match(result?.blockReason || "", /outbox/u);
  assert.doesNotMatch(result?.blockReason || "", /任务产物请写入 outbox\/runtime_result\.json/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
});

test("contract-backed session cannot edit contract.output before it exists", async () => {
  const agentId = `worker-edit-output-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  const contractOutput = join(agentWorkspace(agentId), "output", "TC-edit-output.md");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-edit-output",
    assignee: agentId,
    output: contractOutput,
    status: "running",
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "edit",
      params: {
        path: contractOutput,
        oldText: "old",
        newText: "new",
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /文件生成前/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
  // outbox 统一(f7769b5): edit guard 不再暴露中央 output/alias 路径，引导写 outbox/。
});

test("contract-backed session blocks runtime_result writes outside the current workspace outbox", async () => {
  const agentId = `worker-stage-result-path-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-stage-result-path",
    assignee: agentId,
    output: join(agentWorkspace(agentId), "output", "TC-stage-result-path.md"),
    status: "running",
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "write",
      params: {
        file_path: join(process.env.HOME, ".openclaw", "workspaces", "controller", "outbox", "runtime_result.json"),
        content: "{\"status\":\"success\"}",
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /outbox\/runtime_result\.json/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
  assert.doesNotMatch(
    result?.blockReason || "",
    new RegExp(join(agentWorkspace(agentId), "outbox", "runtime_result.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"),
    "runtime_result path guard should keep the instruction on the relative outbox path",
  );
});

test("contract-backed session blocks tool-error payload writes into contract.output", async () => {
  const agentId = `worker-output-payload-guard-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  const contractOutput = join(agentWorkspace(agentId), "output", "TC-output-payload-guard.md");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-output-payload-guard",
    assignee: agentId,
    output: contractOutput,
    status: "running",
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "write",
      params: {
        file_path: contractOutput,
        content: JSON.stringify({
          status: "error",
          tool: "write",
          error: "[LOOP DETECTED] runtime 已关闭本轮工具通道；请用普通文本给出最终结果。",
        }),
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /contract\.output/u);
  assert.match(result?.blockReason || "", /工具错误|控制载荷/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
});

test("contract-backed session blocks path residue writes into contract.output", async () => {
  const agentId = `worker-output-path-residue-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  const contractOutput = join(agentWorkspace(agentId), "output", "TC-output-path-residue.md");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-output-path-residue",
    assignee: agentId,
    output: contractOutput,
    status: "running",
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "write",
      params: {
        file_path: contractOutput,
        content: "output/",
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /contract\.output/u);
  assert.match(result?.blockReason || "", /路径残渣|控制载荷/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
});

test("contract-backed session blocks writes to managed guidance docs", async () => {
  const agentId = `planner-managed-guidance-write-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:test`;
  const contractOutput = join(CONTROL_PLANE_PATHS.outputDir, "TC-managed-guidance-write.md");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "planner",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/planner" },
        },
      ],
    },
  });

  const trackingState = createTrackingState({
    sessionKey,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    id: "TC-managed-guidance-write",
    assignee: agentId,
    output: contractOutput,
    status: "running",
  };
  trackingState.toolCallTotal = 1;
  trackingState.ownInboxContractReadAt = Date.now();
  trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
  rememberTrackingState(sessionKey, trackingState);

  const { api, getHandler } = createHookApi();
  beforeToolCallHook.register(api, logger);
  const handler = getHandler("before_tool_call");

  const result = await handler(
    {
      toolName: "write",
      params: {
        file_path: "AGENTS.md",
        content: "stage plan residue",
      },
    },
    {
      agentId,
      sessionKey,
    },
  );

  assert.equal(result?.block, true);
  assert.match(result?.blockReason || "", /managed guidance/u);
  assert.match(result?.blockReason || "", /outbox/u);
  assert.doesNotMatch(result?.blockReason || "", /任务产物请写入 outbox\/runtime_result\.json/u);
  assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
});

test("contract session fallback blocks tool-error payload writes into contract.output", async () => {
  const agentId = `worker-output-payload-fallback-${Date.now()}`;
  const contractId = `TC-output-payload-fallback-${Date.now()}`;
  const sessionKey = `agent:${agentId}:contract:${contractId}`;
  const contractPath = getContractPath(contractId);
  const contractOutput = join(CONTROL_PLANE_PATHS.outputDir, `${contractId}.md`);
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: agentId,
          role: "executor",
          workspace: `~/.openclaw/workspaces/${agentId}`,
          model: { primary: "demo/worker" },
        },
      ],
    },
  });

  try {
    await persistContractSnapshot(contractPath, {
      id: contractId,
      task: "say hello",
      assignee: agentId,
      output: contractOutput,
      status: "running",
    }, logger);

    const trackingState = createTrackingState({
      sessionKey,
      agentId,
      parentSession: null,
    });
    trackingState.toolCallTotal = 1;
    trackingState.ownInboxContractReadAt = Date.now();
    trackingState.toolCalls.push({ tool: "read", label: "阅读: contract.json", ts: Date.now() });
    rememberTrackingState(sessionKey, trackingState);

    const { api, getHandler } = createHookApi();
    beforeToolCallHook.register(api, logger);
    const handler = getHandler("before_tool_call");

    const result = await handler(
      {
        toolName: "write",
        params: {
          path: contractOutput,
          file_path: contractOutput,
          content: JSON.stringify({
            status: "error",
            tool: "read",
            error: "runtime 语义：contract.output 是本轮输出路径；文件生成前请把最终产物写入该路径",
          }),
        },
      },
      {
        agentId,
        sessionKey,
      },
    );

    assert.equal(result?.block, true);
    assert.match(result?.blockReason || "", /contract\.output/u);
    assert.match(result?.blockReason || "", /工具错误|控制载荷/u);
    assertPositiveAgentVisibleBlockReason(result?.blockReason || "");
  } finally {
    await rm(contractPath, { force: true });
    await rm(agentWorkspace(agentId), { recursive: true, force: true });
  }
});
