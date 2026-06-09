// tests/io-delivery-a2a-auth-unified.test.js
// TDD: Bug fix for routes/a2a.js:77 vs 124
// Both POST /a2a/tasks/send and GET /a2a/tasks/:id must use the same token (gatewayToken).

import { test } from "node:test";
import assert from "node:assert/strict";

// Build a minimal mock HTTP request / response
function makeReq({ method = "GET", url = "/", headers = {}, body = "" } = {}) {
  const chunks = body ? [body] : [];
  const req = {
    method,
    url,
    headers,
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => i < chunks.length
          ? { value: chunks[i++], done: false }
          : { value: undefined, done: true },
      };
    },
  };
  return req;
}

function makeRes() {
  const res = {
    _statusCode: null,
    _headers: {},
    _body: "",
    writeHead(code, headers) {
      this._statusCode = code;
      this._headers = { ...this._headers, ...headers };
    },
    end(body = "") {
      this._body += body;
    },
  };
  return res;
}

// Capture registered handlers via a fake api object
function makeApi() {
  const routes = {};
  return {
    routes,
    registerHttpRoute({ path, handler }) {
      routes[path] = handler;
    },
  };
}

test("a2a POST /tasks/send uses gatewayToken (not hooksToken)", async (t) => {
  t.mock.module("/Users/hakens/.openclaw/extensions/watchdog/lib/state.js", {
    namedExports: {
      cfg: {
        gatewayPort: 18789,
        hooksToken: "hooks-secret",
        gatewayToken: "gateway-secret",
      },
    },
  });

  t.mock.module("/Users/hakens/.openclaw/extensions/watchdog/lib/contracts.js", {
    namedExports: {
      readContractCompletionArtifact: async () => null,
      readContractSnapshotById: async () => null,
    },
  });

  t.mock.module("/Users/hakens/.openclaw/extensions/watchdog/lib/ingress/dispatch-entry.js", {
    namedExports: {
      dispatchAcceptIngressMessage: async () => ({ ok: true, contractId: "TC-test-001" }),
    },
  });

  t.mock.module("/Users/hakens/.openclaw/extensions/watchdog/lib/capability/capability-registry.js", {
    namedExports: {
      loadCapabilityRegistry: async () => ({ agents: [], skills: [] }),
    },
  });

  t.mock.module("/Users/hakens/.openclaw/extensions/watchdog/lib/runtime/pending-signal-registry.js", {
    namedExports: {
      PENDING_SIGNAL_KINDS: { CHANNEL_INGRESS_WEBUI: "webui", CHANNEL_INGRESS_QQ: "qq", CHANNEL_INGRESS_TEST_INJECT: "test" },
      registerPendingSignal: () => {},
      clearPendingSignal: () => {},
    },
  });

  t.mock.module("/Users/hakens/.openclaw/extensions/watchdog/lib/agent/agent-identity.js", {
    namedExports: {
      buildGatewayReplyTarget: () => ({ agentId: "controller-agent" }),
    },
  });

  const { register } = await import("/Users/hakens/.openclaw/extensions/watchdog/routes/a2a.js");

  const api = makeApi();
  register(api, { info: () => {}, warn: () => {}, error: () => {} });

  const postHandler = api.routes["/a2a/tasks/send"];
  assert.ok(postHandler, "POST /a2a/tasks/send handler not registered");

  // Send request with hooksToken — should be REJECTED (401) if we fixed to gatewayToken
  const reqWithHooksToken = makeReq({
    method: "POST",
    url: "/a2a/tasks/send",
    headers: { authorization: "Bearer hooks-secret" },
    body: JSON.stringify({ message: "hello world" }),
  });
  const resHooks = makeRes();
  await postHandler(reqWithHooksToken, resHooks);
  assert.equal(
    resHooks._statusCode,
    401,
    `POST /a2a/tasks/send should reject hooksToken after fix (got ${resHooks._statusCode})`,
  );

  // Send request with gatewayToken — should be ACCEPTED (200)
  const reqWithGatewayToken = makeReq({
    method: "POST",
    url: "/a2a/tasks/send",
    headers: { authorization: "Bearer gateway-secret" },
    body: JSON.stringify({ message: "hello world" }),
  });
  const resGateway = makeRes();
  await postHandler(reqWithGatewayToken, resGateway);
  assert.equal(
    resGateway._statusCode,
    200,
    `POST /a2a/tasks/send should accept gatewayToken after fix (got ${resGateway._statusCode})`,
  );
});

test("a2a GET /a2a/tasks/:id uses gatewayToken (already correct, must stay)", async (t) => {
  t.mock.module("/Users/hakens/.openclaw/extensions/watchdog/lib/state.js", {
    namedExports: {
      cfg: {
        gatewayPort: 18789,
        hooksToken: "hooks-secret",
        gatewayToken: "gateway-secret",
      },
    },
  });

  t.mock.module("/Users/hakens/.openclaw/extensions/watchdog/lib/contracts.js", {
    namedExports: {
      readContractCompletionArtifact: async () => null,
      readContractSnapshotById: async () => null,
    },
  });

  t.mock.module("/Users/hakens/.openclaw/extensions/watchdog/lib/ingress/dispatch-entry.js", {
    namedExports: {
      dispatchAcceptIngressMessage: async () => ({ ok: true, contractId: "TC-test-001" }),
    },
  });

  t.mock.module("/Users/hakens/.openclaw/extensions/watchdog/lib/capability/capability-registry.js", {
    namedExports: {
      loadCapabilityRegistry: async () => ({ agents: [], skills: [] }),
    },
  });

  t.mock.module("/Users/hakens/.openclaw/extensions/watchdog/lib/runtime/pending-signal-registry.js", {
    namedExports: {
      PENDING_SIGNAL_KINDS: { CHANNEL_INGRESS_WEBUI: "webui", CHANNEL_INGRESS_QQ: "qq", CHANNEL_INGRESS_TEST_INJECT: "test" },
      registerPendingSignal: () => {},
      clearPendingSignal: () => {},
    },
  });

  t.mock.module("/Users/hakens/.openclaw/extensions/watchdog/lib/agent/agent-identity.js", {
    namedExports: {
      buildGatewayReplyTarget: () => ({ agentId: "controller-agent" }),
    },
  });

  const { register } = await import("/Users/hakens/.openclaw/extensions/watchdog/routes/a2a.js");

  const api = makeApi();
  register(api, { info: () => {}, warn: () => {}, error: () => {} });

  const getHandler = api.routes["/a2a/tasks/"];
  assert.ok(getHandler, "GET /a2a/tasks/ handler not registered");

  // GET with wrong token — should be 401
  const reqBad = makeReq({
    method: "GET",
    url: "/a2a/tasks/TC-0001?token=wrong-token",
    headers: {},
  });
  const resBad = makeRes();
  await getHandler(reqBad, resBad);
  assert.equal(resBad._statusCode, 401, `Expected 401 for bad token on GET (got ${resBad._statusCode})`);

  // GET with correct gatewayToken — should NOT be 401
  const reqGood = makeReq({
    method: "GET",
    url: "/a2a/tasks/TC-0001?token=gateway-secret",
    headers: {},
  });
  const resGood = makeRes();
  await getHandler(reqGood, resGood);
  // It will 404 (task not found) but NOT 401
  assert.notEqual(resGood._statusCode, 401, `GET should accept gatewayToken`);
});
