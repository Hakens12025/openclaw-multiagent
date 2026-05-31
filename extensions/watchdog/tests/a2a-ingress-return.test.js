import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

const dispatchCalls = [];

mock.module("../lib/state.js", {
  namedExports: {
    cfg: {
      hooksToken: "",
      gatewayToken: "",
      gatewayPort: 19777,
    },
  },
});

mock.module("../lib/contracts.js", {
  namedExports: {
    readContractCompletionArtifact: async () => null,
    readContractSnapshotById: async () => null,
  },
});

mock.module("../lib/capability/capability-registry.js", {
  namedExports: {
    loadCapabilityRegistry: async () => ({ agents: [], skills: [] }),
  },
});

mock.module("../lib/ingress/dispatch-entry.js", {
  namedExports: {
    dispatchAcceptIngressMessage: async (message, options = {}) => {
      dispatchCalls.push({ message, options });
      return { ok: true, contractId: "TC-A2A-INGRESS" };
    },
  },
});

mock.module("../lib/agent/agent-identity.js", {
  namedExports: {
    isBridgeAgent: () => false,
    resolveGatewayAgentIdForSource: (source) => (
      source === "qq" || source === "qqbot" ? "agent-for-kksl" : "controller"
    ),
    buildGatewayReplyTarget: (source) => {
      if (source === "qq") {
        return { agentId: "agent-for-kksl", sessionKey: "agent:agent-for-kksl:main" };
      }
      return { agentId: "controller", sessionKey: "agent:controller:main" };
    },
  },
});

mock.module("../lib/runtime/pending-signal-registry.js", {
  namedExports: {
    PENDING_SIGNAL_KINDS: Object.freeze({
      CHANNEL_INGRESS_WEBUI: "channel_ingress:webui",
      CHANNEL_INGRESS_QQ: "channel_ingress:qq",
      CHANNEL_INGRESS_TEST_INJECT: "channel_ingress:test_inject",
    }),
    registerPendingSignal: (entry) => pendingSignals.push({ op: "register", ...entry }),
    clearPendingSignal: (entry) => pendingSignals.push({ op: "clear", ...entry }),
  },
});

const pendingSignals = [];

const { formatA2ATaskSendResponse, register } = await import("../routes/a2a.js");

function buildRoutes() {
  const routes = new Map();
  register({
    registerHttpRoute(route) {
      routes.set(route.path, route.handler);
    },
  }, { info() {}, warn() {}, error() {} }, {
    enqueueFn: async () => {},
    wakePlanner: async () => {},
  });
  return routes;
}

function buildPostRequest(payload) {
  return Object.assign(Readable.from([JSON.stringify(payload)]), {
    method: "POST",
    url: "/a2a/tasks/send",
    headers: {},
  });
}

function buildResponse() {
  const state = {
    status: null,
    body: "",
  };
  return {
    writeHead(status) {
      state.status = status;
    },
    end(body = "") {
      state.body += body;
    },
    snapshot() {
      return {
        status: state.status,
        json: state.body ? JSON.parse(state.body) : null,
      };
    },
  };
}

test("a2a send marks source gateway as pending instead of payload reply agent", async () => {
  pendingSignals.length = 0;
  dispatchCalls.length = 0;
  const routes = buildRoutes();
  const handler = routes.get("/a2a/tasks/send");

  const req = buildPostRequest({
    source: "qqbot",
    message: "external ingress",
    replyTo: {
      agentId: "worker",
      sessionKey: "agent:worker:main",
    },
  });
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    id: "TC-A2A-INGRESS",
    status: "submitted",
    createdAt: response.json.createdAt,
    _links: { self: "/a2a/tasks/TC-A2A-INGRESS" },
  });
  assert.deepEqual(
    pendingSignals.map(({ op, agentId, sourceKind }) => ({ op, agentId, sourceKind })),
    [
      { op: "register", agentId: "agent-for-kksl", sourceKind: "channel_ingress:qq" },
      { op: "clear", agentId: "agent-for-kksl", sourceKind: "channel_ingress:qq" },
    ],
  );
  assert.equal(dispatchCalls.length, 1);
  assert.equal(dispatchCalls[0].options.source, "qqbot");
  assert.equal(dispatchCalls[0].options.replyTo.agentId, "worker");
});

test("a2a task send response uses canonical submitted or failed status", () => {
  assert.deepEqual(formatA2ATaskSendResponse({ ok: true, contractId: "TC-OK" }, 123), {
    id: "TC-OK",
    status: "submitted",
    createdAt: 123,
    _links: { self: "/a2a/tasks/TC-OK" },
  });
  assert.deepEqual(formatA2ATaskSendResponse({ ok: false, contractId: "TC-FAIL" }, 456), {
    id: "TC-FAIL",
    status: "failed",
    createdAt: 456,
    _links: { self: "/a2a/tasks/TC-FAIL" },
  });
});
