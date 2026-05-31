import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";

import { register as registerApiRoutes } from "../routes/api.js";
import { cfg, CONTRACTS_DIR, runtimeAgentConfigs } from "../lib/state.js";
import { ADMIN_SURFACES } from "../lib/admin/admin-surface-catalog.js";
import { SURFACE_INPUT_FIELDS } from "../lib/admin/admin-surface-input-fields.js";
import { SURFACE_PLAN_HINTS } from "../lib/admin/admin-surface-plan-hints.js";
import { buildAdminSurfaceSubject } from "../lib/admin/admin-surface-subject.js";
import { CONTRACT_STATUS, TRACKING_STATUS } from "../lib/core/runtime-status.js";
import { clearContractStore } from "../lib/store/contract-store.js";
import { clearTaskHistory } from "../lib/store/task-history-store.js";
import {
  clearTrackingStore,
  rememberTrackingState,
} from "../lib/store/tracker-store.js";

function buildRegisteredRoutes() {
  const routes = new Map();
  const api = {
    registerHttpRoute(route) {
      routes.set(route.path, route.handler);
    },
  };
  const logger = {
    info() {},
    warn() {},
    error() {},
  };

  registerApiRoutes(api, logger, {
    enqueueFn() {},
    wakePlanner() {},
  });
  return routes;
}

function buildGetRequest(path) {
  const req = Readable.from([]);
  req.method = "GET";
  req.url = cfg.gatewayToken
    ? `${path}?token=${encodeURIComponent(cfg.gatewayToken)}`
    : path;
  return req;
}

function buildResponse() {
  const state = {
    status: null,
    body: "",
    headers: null,
  };
  return {
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(chunk = "") {
      state.body += chunk;
    },
    snapshot() {
      let json = null;
      try {
        json = state.body ? JSON.parse(state.body) : null;
      } catch {
        json = null;
      }
      return { ...state, json };
    },
  };
}

test("control operator routes expose canonical cli-system and agent tools surfaces", async () => {
  const routes = buildRegisteredRoutes();

  assert.equal(typeof routes.get("/watchdog/cli-system/surfaces"), "function");
  assert.equal(typeof routes.get("/watchdog/agents/tools"), "function");
  assert.equal(routes.has("/watchdog/agents/card/tools"), false);

  const req = buildGetRequest("/watchdog/cli-system/surfaces");
  const res = buildResponse();
  await routes.get("/watchdog/cli-system/surfaces")(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 200);
  assert.equal(response.json?.counts?.byFamily?.hook > 0, true);
  assert.equal(response.json?.counts?.byFamily?.observe > 0, true);
  assert.equal(response.json?.counts?.byFamily?.apply > 0, true);
  assert.equal(Array.isArray(response.json?.surfaces), true);
});

test("operator catalog work-items route hides control-plane actors", async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get("/watchdog/work-items");
  assert.equal(typeof handler, "function");

  clearTrackingStore();
  clearTaskHistory();
  clearContractStore();
  await rm(CONTRACTS_DIR, { recursive: true, force: true });
  await mkdir(CONTRACTS_DIR, { recursive: true });

  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);
  const now = Date.now();

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set("operator", {
      id: "operator",
      role: "agent",
      plane: "control_plane",
      mainViewVisible: false,
    });
    runtimeAgentConfigs.set("worker-a", {
      id: "worker-a",
      role: "agent",
      mainViewVisible: true,
    });

    rememberTrackingState("agent:operator:contract:TC-HIDDEN-CONTROL", {
      sessionKey: "agent:operator:contract:TC-HIDDEN-CONTROL",
      agentId: "operator",
      status: TRACKING_STATUS.RUNNING,
      startMs: now,
      contract: {
        id: "TC-HIDDEN-CONTROL",
        task: "operator control work",
        assignee: "operator",
        status: CONTRACT_STATUS.RUNNING,
        createdAt: now,
        updatedAt: now,
      },
    });
    rememberTrackingState("agent:worker-a:contract:TC-VISIBLE-RUNTIME", {
      sessionKey: "agent:worker-a:contract:TC-VISIBLE-RUNTIME",
      agentId: "worker-a",
      status: TRACKING_STATUS.RUNNING,
      startMs: now,
      contract: {
        id: "TC-VISIBLE-RUNTIME",
        task: "runtime work",
        assignee: "worker-a",
        status: CONTRACT_STATUS.RUNNING,
        createdAt: now,
        updatedAt: now,
      },
    });

    const req = buildGetRequest("/watchdog/work-items");
    const res = buildResponse();

    await handler(req, res);
    const response = res.snapshot();

    assert.equal(response.status, 200);
    assert.deepEqual(response.json.map((item) => item.id), ["TC-VISIBLE-RUNTIME"]);
  } finally {
    clearTrackingStore();
    clearTaskHistory();
    clearContractStore();
    runtimeAgentConfigs.clear();
    for (const [agentId, config] of originalRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(agentId, config);
    }
  }
});

test("runtime admin surfaces no longer expose workspace migration compatibility routes", async () => {
  const routes = buildRegisteredRoutes();

  assert.equal(routes.has("/watchdog/runtime/workspace-migration"), false);
  assert.equal(routes.has("/watchdog/runtime/workspace-migration/apply"), false);

  const runtimeReadSurface = ADMIN_SURFACES.find((surface) => surface.id === "runtime.read");
  assert.ok(runtimeReadSurface, "expected runtime.read surface");
  assert.equal(runtimeReadSurface.path, "/watchdog/runtime");
  assert.equal(ADMIN_SURFACES.some((surface) => surface.id === "debug.read"), false);

  assert.deepEqual(buildAdminSurfaceSubject("runtime.read"), {
    kind: "runtime",
    scope: "global",
    selectorKey: null,
    aspect: "summary",
  });
  assert.equal(SURFACE_PLAN_HINTS["runtime.read"]?.apiChecks?.includes("GET /watchdog/runtime"), true);
  assert.equal("runtime.workspace_migration.inspect" in SURFACE_PLAN_HINTS, false);
  assert.equal("runtime.workspace_migration.apply" in SURFACE_PLAN_HINTS, false);
  assert.equal("runtime.workspace_migration.apply" in SURFACE_INPUT_FIELDS, false);
});
