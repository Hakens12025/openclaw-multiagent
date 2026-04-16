import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { cfg } from "../lib/state.js";
import { runtimeWakeAgentDetailed } from "../lib/transport/runtime-wake-transport.js";

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
  assert.deepEqual(requests[0].body, {
    message: "wake for dispatch",
    agentId: "planner",
    wakeMode: "now",
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
