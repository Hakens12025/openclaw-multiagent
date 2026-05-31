import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { register as registerApiRoutes } from '../routes/api.js';
import { formatA2ATaskSendResponse, register as registerA2ARoutes } from '../routes/a2a.js';
import { loadGraph } from '../lib/agent/agent-graph.js';
import { saveGraph } from '../lib/agent/agent-graph-mutations.js';
import { cfg, CONTRACTS_DIR, runtimeAgentConfigs } from '../lib/state.js';
import { getContractPath, persistContractById, readContractSnapshotById } from '../lib/contracts.js';
import { clearContractStore } from '../lib/store/contract-store.js';
import { clearTaskHistory } from '../lib/store/task-history-store.js';
import { ADMIN_SURFACES } from '../lib/admin/admin-surface-catalog.js';
import { SURFACE_INPUT_FIELDS } from '../lib/admin/admin-surface-input-fields.js';
import { SURFACE_PLAN_HINTS } from '../lib/admin/admin-surface-plan-hints.js';
import { buildAdminSurfaceSubject } from '../lib/admin/admin-surface-subject.js';
import {
  clearAllPendingSignals,
  hasPendingSignal,
} from '../lib/runtime/pending-signal-registry.js';
import {
  claimDispatchTargetContract,
  clearDispatchQueue,
  releaseDispatchTargetContract,
  syncDispatchTargets,
} from '../lib/routing/dispatch-runtime-state.js';
import { runGlobalTestEnvironmentSerial } from '../lib/formal-runtime/test-locks.js';
import {
  dispatchOutgoingStateMap,
  dispatchTargetStateMap,
} from '../lib/state-collections.js';
import {
  clearTrackingStore,
  getTrackingState,
  rememberTrackingState,
} from '../lib/store/tracker-store.js';
import { CONTRACT_STATUS, TRACKING_STATUS } from '../lib/core/runtime-status.js';

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

function restoreRuntimeAgentConfigs(snapshot) {
  runtimeAgentConfigs.clear();
  for (const [agentId, config] of snapshot.entries()) {
    runtimeAgentConfigs.set(agentId, config);
  }
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

test('a2a tasks/send does not register payload-selected reply agent as actionable ingress target', async () => runGlobalTestEnvironmentSerial(async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/a2a/tasks/send');
  assert.equal(typeof handler, 'function');

  const prefix = 'TC-';
  await mkdir(CONTRACTS_DIR, { recursive: true });
  const before = new Set(await readdir(CONTRACTS_DIR));
  const originalGraph = await loadGraph();
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    clearAllPendingSignals();
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set('controller', {
      id: 'controller',
      role: 'bridge',
      gateway: true,
      ingressSource: 'webui',
      specialized: false,
      protected: true,
      skills: ['system-action'],
    });
    runtimeAgentConfigs.set('worker', {
      id: 'worker',
      role: 'executor',
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });
    runtimeAgentConfigs.set('planner', {
      id: 'planner',
      role: 'planner',
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: false,
      skills: [],
    });

    await saveGraph({
      edges: [
        { from: 'controller', to: 'planner', label: 'ingress' },
      ],
    });
    await syncDispatchTargets(['planner'], null);
    await claimDispatchTargetContract({
      contractId: 'TC-BUSY-PLANNER',
      agentId: 'planner',
      logger: null,
    });

    const req = buildRequest('/a2a/tasks/send', {
      message: 'external payload reply target must not become actionable',
      replyTo: {
        agentId: 'worker',
        sessionKey: 'agent:worker:main',
      },
    });
    req.headers = cfg.hooksToken
      ? { authorization: `Bearer ${cfg.hooksToken}` }
      : {};
    const res = buildResponse();

    const requestPromise = handler(req, res);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hasPendingSignal('worker'), false);
    assert.equal(hasPendingSignal('controller'), true);

    await requestPromise;
    const response = res.snapshot();

    assert.equal(response.status, 200);
    assert.equal(response.json?.status, 'submitted');
    assert.equal(hasPendingSignal('worker'), false);
    assert.equal(hasPendingSignal('controller'), false);

    const after = new Set(await readdir(CONTRACTS_DIR));
    const created = [...after].find((name) => !before.has(name) && name.startsWith(prefix));
    assert.ok(created, 'expected a2a route to create a contract snapshot');
    const contractPath = join(CONTRACTS_DIR, created);
    const persisted = JSON.parse(await readFile(contractPath, 'utf8'));
    assert.equal(persisted.dispatchOwnerAgentId, 'controller');
    assert.equal(persisted.assignee, 'planner');
    await rm(contractPath, { force: true });
  } finally {
    await releaseDispatchTargetContract({ agentId: 'planner', logger: null }).catch(() => {});
    await clearDispatchQueue(null).catch(() => {});
    clearAllPendingSignals();
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await saveGraph(originalGraph);
  }
}));

test('a2a task send response uses canonical submitted status only', () => {
  const response = formatA2ATaskSendResponse({
    contractId: 'TC-A2A-CANONICAL',
    unexpectedDetail: 'ignored',
    arbitraryFlag: true,
  }, 12345);

  assert.deepEqual(response, {
    id: 'TC-A2A-CANONICAL',
    status: 'submitted',
    createdAt: 12345,
    _links: { self: '/a2a/tasks/TC-A2A-CANONICAL' },
  });
});

test('a2a task detail does not expose internal clarification text', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/a2a/tasks/');
  assert.equal(typeof handler, 'function');

  const contractId = `TC-A2A-CLARIFICATION-${Date.now()}`;
  const contractPath = getContractPath(contractId);

  try {
    await persistContractById({
      id: contractId,
      task: 'needs input',
      assignee: 'planner',
      status: CONTRACT_STATUS.AWAITING_INPUT,
      output: `/tmp/${contractId}.md`,
      clarification: 'runtime_result write failed; please inspect contract.output',
      phases: ['run'],
      total: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, console);

    const req = buildGetRequest(`/a2a/tasks/${contractId}`);
    const res = buildResponse();

    await handler(req, res);
    const response = res.snapshot();

    assert.equal(response.status, 200);
    assert.equal(response.json?.status, 'input-required');
    assert.equal('clarification' in response.json, false);
    assert.doesNotMatch(JSON.stringify(response.json), /runtime_result|contract\.output/);
  } finally {
    await rm(contractPath, { force: true });
    clearContractStore();
  }
});

test('operator catalog exposes canonical work-items route without legacy contracts route', async () => {
  const routes = buildRegisteredRoutes();

  assert.equal(typeof routes.get('/watchdog/work-items'), 'function');
  assert.equal(routes.has('/watchdog/contracts'), false);
});

test('operator catalog work-items route hides control-layer work items', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/work-items');
  assert.equal(typeof handler, 'function');

  clearTrackingStore();
  clearTaskHistory();
  clearContractStore();
  await rm(CONTRACTS_DIR, { recursive: true, force: true });
  await mkdir(CONTRACTS_DIR, { recursive: true });

  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);
  const now = Date.now();

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set('operator', {
      id: 'operator',
      role: 'agent',
      plane: 'control_plane',
      mainViewVisible: false,
    });
    runtimeAgentConfigs.set('worker-a', {
      id: 'worker-a',
      role: 'agent',
      mainViewVisible: true,
    });

    rememberTrackingState('agent:operator:contract:TC-HIDDEN-CONTROL', {
      sessionKey: 'agent:operator:contract:TC-HIDDEN-CONTROL',
      agentId: 'operator',
      status: TRACKING_STATUS.RUNNING,
      startMs: now,
      contract: {
        id: 'TC-HIDDEN-CONTROL',
        task: 'operator control work',
        assignee: 'operator',
        status: CONTRACT_STATUS.RUNNING,
        createdAt: now,
        updatedAt: now,
      },
    });
    rememberTrackingState('agent:worker-a:contract:TC-VISIBLE-RUNTIME', {
      sessionKey: 'agent:worker-a:contract:TC-VISIBLE-RUNTIME',
      agentId: 'worker-a',
      status: TRACKING_STATUS.RUNNING,
      startMs: now,
      contract: {
        id: 'TC-VISIBLE-RUNTIME',
        task: 'runtime work',
        assignee: 'worker-a',
        status: CONTRACT_STATUS.RUNNING,
        createdAt: now,
        updatedAt: now,
      },
    });

    const req = buildGetRequest('/watchdog/work-items');
    const res = buildResponse();

    await handler(req, res);
    const response = res.snapshot();

    assert.equal(response.status, 200);
    assert.deepEqual(response.json.map((item) => item.id), ['TC-VISIBLE-RUNTIME']);
  } finally {
    clearTrackingStore();
    clearTaskHistory();
    clearContractStore();
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
  }
});

test('tests terminalize route is runtime-owned and clears contract tracking state', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/tests/terminalize');
  assert.equal(typeof handler, 'function');

  const contractId = `TC-ROUTE-TERMINALIZE-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const sessionKey = `agent:planner:contract:${contractId}`;
  const originalRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set('planner', {
      id: 'planner',
      role: 'planner',
      gateway: false,
      ingressSource: null,
      specialized: false,
      protected: true,
      skills: [],
    });
    await persistContractById({
      id: contractId,
      task: 'route terminalize task',
      assignee: 'planner',
      status: CONTRACT_STATUS.RUNNING,
      output: `/tmp/${contractId}.md`,
      phases: ['run'],
      total: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, console);
    dispatchTargetStateMap.set('planner', {
      busy: true,
      healthy: true,
      dispatching: false,
      lastSeen: Date.now(),
      currentContract: contractId,
      queue: [],
    });
    rememberTrackingState(sessionKey, {
      sessionKey,
      agentId: 'planner',
      status: TRACKING_STATUS.RUNNING,
      contract: {
        id: contractId,
        status: CONTRACT_STATUS.RUNNING,
        assignee: 'planner',
      },
    });

    const req = buildRequest('/watchdog/tests/terminalize', {
      contractId,
      status: CONTRACT_STATUS.FAILED,
      reason: 'case_timeout',
      summary: 'case timed out',
    });
    const res = buildResponse();

    await handler(req, res);
    const response = res.snapshot();

    assert.equal(response.status, 200);
    assert.equal(response.json?.ok, true);
    assert.equal(response.json?.contractId, contractId);
    assert.equal(getTrackingState(sessionKey), null);

    const persisted = await readContractSnapshotById(contractId);
    assert.equal(persisted.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.terminalOutcome?.reason, 'case_timeout');
    assert.equal(dispatchTargetStateMap.get('planner')?.currentContract, null);
  } finally {
    clearTrackingStore();
    dispatchTargetStateMap.clear();
    restoreRuntimeAgentConfigs(originalRuntimeConfigs);
    await rm(contractPath, { force: true });
  }
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
  assert.equal(Array.isArray(response.json.dispatchQueue.entries), true);
  assert.equal(Array.isArray(response.json.dispatchQueue.contractIds), true);
  assert.equal(
    response.json.dispatchQueue.contractIds.every((contractId) => typeof contractId === 'string'),
    true,
  );
  assert.equal('activeSessions' in response.json, false);
  assert.equal('debug' in response.json, false);
  assert.equal('runtimeQueue' in response.json, false);
  assert.equal('workerRuntime' in response.json, false);
  assert.equal('taskQueue' in response.json, false);
  assert.equal('workerPool' in response.json, false);
});

test('runtime route includes dispatch target queue lanes on initial load', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/runtime');
  const agentId = `runtime-queue-api-${Date.now()}`;
  dispatchTargetStateMap.set(agentId, {
    busy: false,
    healthy: true,
    dispatching: false,
    currentContract: null,
    lastSeen: 123,
    queue: [{ contractId: 'TC-INCOMING-API', fromAgent: 'planner', targetAgent: agentId }],
  });

  try {
    const res = buildResponse();
    await handler(buildGetRequest('/watchdog/runtime'), res);
    const response = res.snapshot();
    const target = response.json?.dispatchRuntime?.targets?.[agentId];

    assert.equal(response.status, 200);
    assert.deepEqual(response.json?.dispatchQueue?.entries, [{
      contractId: 'TC-INCOMING-API',
      fromAgent: 'planner',
      targetAgent: agentId,
    }]);
    assert.deepEqual(response.json?.dispatchQueue?.contractIds, ['TC-INCOMING-API']);
    assert.equal(target?.lastSeen, 123);
    assert.deepEqual(target?.queue, [{
      contractId: 'TC-INCOMING-API',
      fromAgent: 'planner',
      targetAgent: agentId,
    }]);
    assert.equal('outgoingQueue' in target, false);
  } finally {
    dispatchTargetStateMap.delete(agentId);
  }
});

test('runtime route includes canonical outgoingBySource lanes on initial load', async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get('/watchdog/runtime');
  const sourceAgentId = `runtime-outgoing-api-${Date.now()}`;
  dispatchOutgoingStateMap.set(sourceAgentId, {
    outgoingQueue: [{ contractId: 'TC-CANONICAL-OUTGOING-API', targetAgent: 'worker2', status: 'ready' }],
  });

  try {
    const res = buildResponse();
    await handler(buildGetRequest('/watchdog/runtime'), res);
    const response = res.snapshot();

    assert.equal(response.status, 200);
    assert.deepEqual(response.json?.dispatchRuntime?.outgoingBySource?.[sourceAgentId], [{
      contractId: 'TC-CANONICAL-OUTGOING-API',
      fromAgent: sourceAgentId,
      targetAgent: 'worker2',
      status: 'ready',
    }]);
  } finally {
    dispatchOutgoingStateMap.delete(sourceAgentId);
  }
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

test('test run start surface declares runtime reset side effects', () => {
  const surface = ADMIN_SURFACES.find((entry) => entry.id === 'test_runs.start');
  assert.ok(surface, 'expected test_runs.start surface');
  assert.notEqual(surface.risk, 'safe');

  const hints = SURFACE_PLAN_HINTS['test_runs.start'];
  assert.ok(hints, 'expected test_runs.start hints');
  assert.equal(hints.writes.some((entry) => /runtime reset/i.test(entry)), true);
  assert.equal(hints.writes.some((entry) => /contracts/i.test(entry)), true);
  assert.equal(hints.writes.some((entry) => /mailbox/i.test(entry)), true);
  assert.equal(hints.expectedSignals.includes('alert:qq_notify'), true);
});
