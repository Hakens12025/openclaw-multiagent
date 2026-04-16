import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { register as registerApiRoutes } from '../routes/api.js';
import { register as registerA2ARoutes } from '../routes/a2a.js';
import { cfg } from '../lib/state.js';
import { ADMIN_SURFACES } from '../lib/admin/admin-surface-catalog.js';
import { SURFACE_INPUT_FIELDS } from '../lib/admin/admin-surface-input-fields.js';
import { SURFACE_PLAN_HINTS } from '../lib/admin/admin-surface-plan-hints.js';
import { buildAdminSurfaceSubject } from '../lib/admin/admin-surface-subject.js';

function buildRegisteredRoutes() {
  const routes = new Map();
  const api = {
    config: {},
    runtime: {
      system: {
        requestHeartbeatNow() {},
      },
    },
    registerHttpRoute(route) {
      routes.set(route.path, route.handler);
    },
  };
  registerApiRoutes(api, console, {
    enqueueFn: async () => {},
    wakeContractor: async () => {},
  });
  registerA2ARoutes(api, console, {
    enqueueFn: async () => {},
    wakeContractor: async () => {},
  });
  return routes;
}

function buildRequest(path, payload) {
  const req = Readable.from([JSON.stringify(payload)]);
  req.method = 'POST';
  req.url = cfg.gatewayToken
    ? `${path}?token=${encodeURIComponent(cfg.gatewayToken)}`
    : path;
  return req;
}

function buildGetRequest(path) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = cfg.gatewayToken
    ? `${path}?token=${encodeURIComponent(cfg.gatewayToken)}`
    : path;
  return req;
}

function buildResponse() {
  const state = {
    status: null,
    headers: null,
    body: '',
  };
  return {
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(body = '') {
      state.body += body;
    },
    snapshot() {
      return {
        ...state,
        json: state.body ? JSON.parse(state.body) : null,
      };
    },
  };
}

test('runtime.loop.start route rejects legacy alias payload keys', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/runtime/loop/start');
  assert.equal(typeof handler, 'function');

  const req = buildRequest('/watchdog/runtime/loop/start', {
    loopId: 'legacy-loop',
    task: 'legacy payload task',
    entryAgentId: 'researcher',
    source: 'legacy-runtime-loop-start',
  });
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 400);
  assert.match(response.json?.error || '', /missing requestedTask/);
});

test('agents.delete route requires canonical agentId', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/agents/delete');
  assert.equal(typeof handler, 'function');

  const req = buildRequest('/watchdog/agents/delete', {
    id: 'legacy-agent-id',
    explicitConfirm: true,
  });
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 400);
  assert.match(response.json?.error || '', /missing agentId/);
});

test('agents.hard-delete route requires canonical agentId', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/agents/hard-delete');
  assert.equal(typeof handler, 'function');

  const req = buildRequest('/watchdog/agents/hard-delete', {
    id: 'legacy-agent-id',
    explicitConfirm: true,
  });
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 400);
  assert.match(response.json?.error || '', /missing agentId/);
});

test('cli-system surfaces route returns unified surface families', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/cli-system/surfaces');
  assert.equal(typeof handler, 'function');

  const req = buildGetRequest('/watchdog/cli-system/surfaces');
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 200);
  assert.equal(response.json?.counts?.byFamily?.hook > 0, true);
  assert.equal(response.json?.counts?.byFamily?.observe > 0, true);
  assert.equal(Array.isArray(response.json?.surfaces), true);
});

test('schedules.delete route requires canonical scheduleId', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/schedules/delete');
  assert.equal(typeof handler, 'function');

  const req = buildRequest('/watchdog/schedules/delete', {
    id: 'legacy-schedule-id',
  });
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 400);
  assert.match(response.json?.error || '', /missing schedule id/);
});

test('automations.delete route requires canonical automationId', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/automations/delete');
  assert.equal(typeof handler, 'function');

  const req = buildRequest('/watchdog/automations/delete', {
    id: 'legacy-automation-id',
    explicitConfirm: true,
  });
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 400);
  assert.match(response.json?.error || '', /missing automation id/);
});

test('agents.join route requires canonical agentId', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/agents/join');
  assert.equal(typeof handler, 'function');

  const req = buildRequest('/watchdog/agents/join', {
    id: 'legacy-agent-id',
  });
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 400);
  assert.match(response.json?.error || '', /missing agentId/);
});

test('agents.guidance.takeover route requires canonical agentId', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/agents/guidance/takeover');
  assert.equal(typeof handler, 'function');

  const req = buildRequest('/watchdog/agents/guidance/takeover', {
    id: 'legacy-agent-id',
  });
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 400);
  assert.match(response.json?.error || '', /missing agentId/);
});

test('agents.guidance.write route requires canonical agentId', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/agents/guidance/write');
  assert.equal(typeof handler, 'function');

  const req = buildRequest('/watchdog/agents/guidance/write', {
    id: 'legacy-agent-id',
    fileName: 'AGENTS.md',
    content: '# legacy guidance write',
  });
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 400);
  assert.match(response.json?.error || '', /missing agentId/);
});

test('a2a tasks/send requires canonical message field', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/a2a/tasks/send');
  assert.equal(typeof handler, 'function');

  const req = buildRequest('/a2a/tasks/send', {
    task: 'legacy a2a task payload',
  });
  req.headers = cfg.hooksToken
    ? { authorization: `Bearer ${cfg.hooksToken}` }
    : {};
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 400);
  assert.match(response.json?.error || '', /message required/);
});

test('operator catalog exposes canonical work-items route without legacy contracts route', async () => {
  const routes = buildRegisteredRoutes();

  assert.equal(typeof routes.get('/watchdog/work-items'), 'function');
  assert.equal(routes.has('/watchdog/contracts'), false);
});

test('runtime route exposes canonical runtime fields without legacy debug aliases', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/runtime');
  assert.equal(typeof handler, 'function');
  assert.equal(routes.has('/watchdog/debug'), false);

  const req = {
    method: 'GET',
    url: cfg.gatewayToken
      ? `/watchdog/runtime?token=${encodeURIComponent(cfg.gatewayToken)}`
      : '/watchdog/runtime',
  };
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 200);
  assert.ok(response.json, 'expected debug payload');
  assert.equal('trackingSessions' in response.json, true);
  assert.equal('dispatchQueue' in response.json, true);
  assert.equal('dispatchRuntime' in response.json, true);
  assert.equal('activeSessions' in response.json, false);
  assert.equal('debug' in response.json, false);
  assert.equal('runtimeQueue' in response.json, false);
  assert.equal('workerRuntime' in response.json, false);
  assert.equal('taskQueue' in response.json, false);
  assert.equal('workerPool' in response.json, false);
});

test('test inject route is exposed only through canonical test path', async () => {
  const routes = buildRegisteredRoutes();

  assert.equal(typeof routes.get('/watchdog/tests/inject'), 'function');
  assert.equal(routes.has('/watchdog/test-inject'), false);
});

test('admin surface catalog uses work_items.list as the canonical lifecycle surface', async () => {
  const workItemsSurface = ADMIN_SURFACES.find((surface) => surface.id === 'work_items.list');
  assert.ok(workItemsSurface, 'expected work_items.list surface');
  assert.equal(workItemsSurface.path, '/watchdog/work-items');

  const legacyContractsSurface = ADMIN_SURFACES.find((surface) => surface.id === 'contracts.list');
  assert.equal(legacyContractsSurface, undefined);

  assert.deepEqual(buildAdminSurfaceSubject('work_items.list'), {
    kind: 'work_item',
    scope: 'catalog',
    selectorKey: null,
    aspect: 'registry',
  });
  assert.equal(SURFACE_PLAN_HINTS['work_items.list']?.apiChecks?.includes('GET /watchdog/work-items'), true);
  assert.equal('contracts.list' in SURFACE_PLAN_HINTS, false);
});

test('admin surface catalog exposes canonical hard-delete surface', async () => {
  const hardDeleteSurface = ADMIN_SURFACES.find((surface) => surface.id === 'agents.hard_delete');
  assert.ok(hardDeleteSurface, 'expected agents.hard_delete surface');
  assert.equal(hardDeleteSurface.path, '/watchdog/agents/hard-delete');
  assert.equal(hardDeleteSurface.risk, 'destructive');
  assert.equal(hardDeleteSurface.confirmation, 'explicit');

  assert.equal(
    SURFACE_PLAN_HINTS['agents.hard_delete']?.apiChecks?.includes('POST /watchdog/agents/hard-delete'),
    true,
  );
});

test('agents.hard_delete input fields accept discovered local workspace residue ids', () => {
  const fields = SURFACE_INPUT_FIELDS['agents.hard_delete'];
  assert.ok(Array.isArray(fields), 'expected hard delete input fields');
  assert.equal(fields[0]?.key, 'agentId');
  assert.equal(fields[0]?.type, 'text');
  assert.match(fields[0]?.description || '', /local workspace residue/i);
});

test('runtime admin surfaces no longer expose workspace migration compatibility routes', async () => {
  const routes = buildRegisteredRoutes();

  assert.equal(routes.has('/watchdog/runtime/workspace-migration'), false);
  assert.equal(routes.has('/watchdog/runtime/workspace-migration/apply'), false);

  const runtimeReadSurface = ADMIN_SURFACES.find((surface) => surface.id === 'runtime.read');
  assert.ok(runtimeReadSurface, 'expected runtime.read surface');
  assert.equal(runtimeReadSurface.path, '/watchdog/runtime');

  const debugSurface = ADMIN_SURFACES.find((surface) => surface.id === 'debug.read');
  assert.equal(debugSurface, undefined);

  assert.deepEqual(buildAdminSurfaceSubject('runtime.read'), {
    kind: 'runtime',
    scope: 'global',
    selectorKey: null,
    aspect: 'summary',
  });
  assert.equal(
    SURFACE_PLAN_HINTS['runtime.read']?.apiChecks?.includes('GET /watchdog/runtime'),
    true,
  );
  assert.equal('runtime.workspace_migration.inspect' in SURFACE_PLAN_HINTS, false);
  assert.equal('runtime.workspace_migration.apply' in SURFACE_PLAN_HINTS, false);
});

test('test inject surface uses canonical route path', () => {
  const injectSurface = ADMIN_SURFACES.find((surface) => surface.id === 'test.inject');
  assert.ok(injectSurface, 'expected test.inject surface');
  assert.equal(injectSurface.path, '/watchdog/tests/inject');
});
