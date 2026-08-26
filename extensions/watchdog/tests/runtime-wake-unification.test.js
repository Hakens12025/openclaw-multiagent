import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { cfg, runtimeAgentConfigs } from "../lib/state.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { runtimeWakeAgentDetailed } from "../lib/transport/runtime-wake-transport.js";
import {
  WAKE_SEMANTIC_TYPE,
  buildRuntimeWakeEnvelope,
  isInternalWakeSemanticType,
} from "../lib/transport/runtime-wake-envelope.js";

const WATCHDOG_ROOT = fileURLToPath(new URL("..", import.meta.url));

// 注册本文件测试所需的 agent，使其满足门控条件:
// registered=true, plane="runtime", autoWakeEligible=true
registerRuntimeAgents({
  agents: {
    list: [
      { id: "planner", binding: { roleRef: "planner" } },
      { id: "controller", binding: { roleRef: "agent" } },
      { id: "worker-a", binding: { roleRef: "executor" } },
    ],
  },
});

after(() => {
  runtimeAgentConfigs.clear();
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to resolve server address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test("runtimeWakeAgentDetailed prefers hooks launch over heartbeat when hooks transport succeeds", async (t) => {
  const requests = [];
  const heartbeatCalls = [];
  const previousGatewayPort = cfg.gatewayPort;
  const previousHooksToken = cfg.hooksToken;

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: JSON.parse(body),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, runId: "run-123" }));
  });

  const port = await listen(server);
  cfg.gatewayPort = port;
  cfg.hooksToken = "test-hooks-token";

  t.after(async () => {
    cfg.gatewayPort = previousGatewayPort;
    cfg.hooksToken = previousHooksToken;
    await close(server);
  });

  const result = await runtimeWakeAgentDetailed(
    "planner",
    "wake for dispatch",
    {
      runtime: {
        system: {
          requestHeartbeatNow(payload) {
            heartbeatCalls.push(payload);
          },
        },
      },
    },
    { info() {}, warn() {}, error() {} },
    { sessionKey: "agent:planner:main" },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/hooks/agent");
  assert.equal(requests[0].headers.authorization, "Bearer test-hooks-token");
  // 言面收口 P0(备忘录156 四层②):载荷带 runtime:<agentId> 归属名 + next-heartbeat
  // (回执不再无归属、不再强拍醒 default agent;守卫 tests/wake-receipt-attribution.test.js)。
  assert.deepEqual(requests[0].body, {
    message: "wake for dispatch",
    agentId: "planner",
    name: "runtime:planner",
    wakeMode: "next-heartbeat",
    sessionKey: "agent:planner:main",
  });
  assert.equal(heartbeatCalls.length, 0);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "hooks");
  assert.equal(result.runId, "run-123");
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.hookError, null);
});

test("runtimeWakeAgentDetailed falls back to heartbeat when hooks launch fails", async (t) => {
  const heartbeatCalls = [];
  const previousGatewayPort = cfg.gatewayPort;
  const previousHooksToken = cfg.hooksToken;

  const server = http.createServer(async (_req, res) => {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("unavailable");
  });

  const port = await listen(server);
  cfg.gatewayPort = port;
  cfg.hooksToken = "test-hooks-token";

  t.after(async () => {
    cfg.gatewayPort = previousGatewayPort;
    cfg.hooksToken = previousHooksToken;
    await close(server);
  });

  const result = await runtimeWakeAgentDetailed(
    "planner",
    "wake for dispatch",
    {
      runtime: {
        system: {
          requestHeartbeatNow(payload) {
            heartbeatCalls.push(payload);
          },
        },
      },
    },
    { info() {}, warn() {}, error() {} },
    { sessionKey: "agent:planner:main" },
  );

  assert.equal(heartbeatCalls.length, 1);
  assert.deepEqual(heartbeatCalls[0], {
    reason: "wake for dispatch",
    agentId: "planner",
    sessionKey: "agent:planner:main",
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "heartbeat");
  assert.equal(result.fallbackUsed, true);
  assert.match(result.hookError, /HTTP 503/);
});

test("runtimeWakeAgentDetailed uses neutral current-session wake text when no explicit reason is provided", async () => {
  const heartbeatCalls = [];
  const previousHooksToken = cfg.hooksToken;
  cfg.hooksToken = "";

  try {
    const result = await runtimeWakeAgentDetailed(
      "planner",
      null,
      {
        runtime: {
          system: {
            requestHeartbeatNow(payload) {
              heartbeatCalls.push(payload);
            },
          },
        },
      },
      { info() {}, warn() {}, error() {} },
      { sessionKey: "agent:planner:main" },
    );

    assert.equal(heartbeatCalls.length, 1);
    assert.equal(
      heartbeatCalls[0]?.reason,
      "按当前会话继续处理。",
    );
    assert.doesNotMatch(heartbeatCalls[0]?.reason || "", /inbox\//);
    assert.equal(result.ok, true);
    assert.equal(result.mode, "heartbeat");
  } finally {
    cfg.hooksToken = previousHooksToken;
  }
});

test("runtimeWakeAgentDetailed builds a typed wakeEnvelope from semantic options", async () => {
  const heartbeatCalls = [];
  const previousHooksToken = cfg.hooksToken;
  cfg.hooksToken = "";

  try {
    await runtimeWakeAgentDetailed(
      "planner",
      null,
      {
        runtime: {
          system: {
            requestHeartbeatNow(payload) {
              heartbeatCalls.push(payload);
            },
          },
        },
      },
      { info() {}, warn() {}, error() {} },
      {
        sessionKey: "agent:planner:main",
        wakeSemantic: WAKE_SEMANTIC_TYPE.SYSTEM_ACTION_WAKE_AGENT,
        sourceAgentId: "controller",
        actionType: "wake_agent",
      },
    );

    assert.equal(heartbeatCalls.length, 1);
    assert.equal(heartbeatCalls[0]?.wakeEnvelope?.semanticType, WAKE_SEMANTIC_TYPE.SYSTEM_ACTION_WAKE_AGENT);
    assert.equal(heartbeatCalls[0]?.wakeEnvelope?.sourceAgentId, "controller");
    assert.equal(heartbeatCalls[0]?.wakeEnvelope?.actionType, "wake_agent");
  } finally {
    cfg.hooksToken = previousHooksToken;
  }
});

test("every runtime-owned semantic type is classified as internal wake (GENERIC excluded)", () => {
  for (const type of [
    WAKE_SEMANTIC_TYPE.EXECUTION_CONTRACT,
    WAKE_SEMANTIC_TYPE.DIRECT_REQUEST_RESUME,
    WAKE_SEMANTIC_TYPE.SYSTEM_ACTION_WAKE_AGENT,
    WAKE_SEMANTIC_TYPE.ASSIGN_TASK_DISPATCH,
    WAKE_SEMANTIC_TYPE.TERMINAL_DELIVERY_READY,
    WAKE_SEMANTIC_TYPE.SYSTEM_ACTION_DELIVERY_RESUME,
    WAKE_SEMANTIC_TYPE.HEARTBEAT_POLL,
  ]) {
    assert.equal(isInternalWakeSemanticType(type), true, `${type} should be internal`);
  }
  assert.equal(isInternalWakeSemanticType(WAKE_SEMANTIC_TYPE.GENERIC), false);
});

test("hooks dispatch forwards wakeEnvelope when caller passes one", async (t) => {
  const requests = [];
  const previousGatewayPort = cfg.gatewayPort;
  const previousHooksToken = cfg.hooksToken;

  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ body: JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, runId: "r-envelope" }));
  });

  const port = await listen(server);
  cfg.gatewayPort = port;
  cfg.hooksToken = "test";

  t.after(async () => {
    cfg.gatewayPort = previousGatewayPort;
    cfg.hooksToken = previousHooksToken;
    await close(server);
  });

  const envelope = buildRuntimeWakeEnvelope({
    semanticType: WAKE_SEMANTIC_TYPE.EXECUTION_CONTRACT,
    targetAgentId: "worker-a",
    contractId: "TC-unification",
  });

  await runtimeWakeAgentDetailed(
    "worker-a",
    envelope.renderText,
    { runtime: { system: { requestHeartbeatNow() {} } } },
    { info() {}, warn() {}, error() {} },
    { sessionKey: "agent:worker-a:main", wakeEnvelope: envelope },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.wakeEnvelope.semanticType, WAKE_SEMANTIC_TYPE.EXECUTION_CONTRACT);
  assert.equal(requests[0].body.wakeEnvelope.contractId, "TC-unification");
  assert.equal(requests[0].body.wakeEnvelope.targetAgentId, "worker-a");
});

test("heartbeat fallback forwards wakeEnvelope when caller passes one", async () => {
  const heartbeatCalls = [];
  const previousHooksToken = cfg.hooksToken;
  cfg.hooksToken = "";

  try {
    const envelope = buildRuntimeWakeEnvelope({
      semanticType: WAKE_SEMANTIC_TYPE.DIRECT_REQUEST_RESUME,
      targetAgentId: "controller",
      envelopeId: "env-42",
    });
    await runtimeWakeAgentDetailed(
      "controller",
      envelope.renderText,
      {
        runtime: {
          system: {
            requestHeartbeatNow(payload) { heartbeatCalls.push(payload); },
          },
        },
      },
      { info() {}, warn() {}, error() {} },
      { sessionKey: "agent:controller:main", wakeEnvelope: envelope },
    );
    assert.equal(heartbeatCalls.length, 1);
    assert.equal(heartbeatCalls[0].wakeEnvelope.semanticType, WAKE_SEMANTIC_TYPE.DIRECT_REQUEST_RESUME);
    assert.equal(heartbeatCalls[0].wakeEnvelope.envelopeId, "env-42");
  } finally {
    cfg.hooksToken = previousHooksToken;
  }
});

test("isRuntimeWakeMessage helper was removed (string-matcher retirement)", async () => {
  const transportSource = await readFile(
    join(WATCHDOG_ROOT, "lib", "transport", "runtime-wake-transport.js"),
    "utf8",
  );
  assert.doesNotMatch(transportSource, /isRuntimeWakeMessage/);
  assert.doesNotMatch(transportSource, /INTERNAL_WAKE_PATTERNS/);
});

test("runtime wake source files no longer retain legacy wake prompt wording", async () => {
  const files = [
    join(WATCHDOG_ROOT, "lib", "transport", "runtime-wake-transport.js"),
    join(WATCHDOG_ROOT, "lib", "routing", "delivery", "delivery-system-action-transport.js"),
    join(WATCHDOG_ROOT, "tests", "runtime-diagnosis.js"),
  ];
  const legacyPatterns = [
    /\^system_action wakeup\\b/i,
    /\^delivery ready:\\s\*DL-/i,
    /system_action delivery wake retry failed/i,
    /system_action delivery wake failed/i,
  ];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    for (const pattern of legacyPatterns) {
      assert.doesNotMatch(content, pattern);
    }
  }
});
