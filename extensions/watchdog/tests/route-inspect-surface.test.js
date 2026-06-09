/**
 * route-inspect-surface.test.js — 锁定 batch 1：5 个低风险 read-route 经 inspect surface（P-D.2 续）
 *
 * 背景：HTTP read 视图原本直读 store 函数，与 operator 经 inspect surface 的读路径
 * 并行重复（双读路径）。本次收口为"一条路径"——route 改经 inspectCliSystemSurface：
 *   GET /watchdog/schedules                      → inspect.schedules（透传 {enabled}）
 *   GET /watchdog/agent-joins/registry           → inspect.agent_joins（透传 {enabled,status,protocolType}）
 *   GET /watchdog/system-action-delivery-tickets → inspect.delivery_tickets（透传 {status}）
 *   GET /watchdog/test-runs                       → inspect.test_runs（无参）
 *   GET /watchdog/admin-change-sets (GET 分支)    → inspect.change_sets（无参）
 *
 * 锁定：
 *   ① 经 surface 取的 payload（含 params 透传）与直读 store（同 params）深度等价
 *   ② route handler 的后处理（{generatedAt,...} 包装 / count / 过滤）形状不变
 *   ③ params（enabled/status/protocolType）确实透传进 surface 并生效
 */

import test from "node:test";
import assert from "node:assert/strict";

import { register as registerOperatorCatalogRoutes } from "../routes/operator-catalog.js";
import { register as registerTestRunsRoutes } from "../routes/test-runs.js";
import { register as registerAdminChangeSetRoutes } from "../routes/admin-change-sets.js";
import { register as registerApiRoutes } from "../routes/api.js";

import { inspectCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { validateCliSurface } from "../lib/cli-system/cli-surface-schema.js";
import { getCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";

// 直读源（仅供等价性对照）
import { summarizeScheduleRegistry } from "../lib/schedule/schedule-registry.js";
import { summarizeAgentJoinRegistry } from "../lib/agent/agent-join-registry.js";
import { summarizeSystemActionDeliveryTickets } from "../lib/routing/delivery-system-action-ticket.js";
import { listTestRuns } from "../lib/test-runs.js";
import { listAdminChangeSets } from "../lib/admin/admin-change-sets.js";
// batch 2 直读源
import { summarizeAutomationRuntimeRegistry } from "../lib/automation/automation-runtime.js";
import { listLifecycleWorkItems } from "../lib/contracts.js";
import { getAgentIdentitySnapshot } from "../lib/agent/agent-identity.js";
import { summarizeHarnessDashboard } from "../lib/harness/harness-dashboard.js";
// batch 3 直读源（graph routes）
import { loadGraph, detectCycles } from "../lib/agent/agent-graph.js";
import { listResolvedGraphLoops } from "../lib/loop/graph-loop-registry.js";
import { getActiveResolvedLoopSession, listResolvedLoopSessions } from "../lib/loop/loop-session-store.js";
// batch 4 直读源（runtime route）
import { inspectCliRuntimeState } from "../lib/cli-system/cli-runtime-inspector.js";
import { getSseClientCount } from "../lib/transport/sse.js";
// Batch A 直读源（observe 读路径 + capability route）
import { listTrackingStates } from "../lib/store/tracker-store.js";
import { getRecentTaskHistory } from "../lib/store/task-history-store.js";
import { loadCapabilityRegistry } from "../lib/capability/capability-registry.js";

// ── mock route harness ───────────────────────────────────────────────────────

function buildRouteMap(registerFn) {
  const routes = new Map();
  const api = {
    registerHttpRoute(route) {
      routes.set(route.path, route);
    },
  };
  function sendJson(res, status, payload) {
    res.statusCode = status;
    res.jsonBody = payload;
    res.body = JSON.stringify(payload);
  }
  const logger = { info() {}, warn() {}, error() {} };
  registerFn(api, sendJson, logger);
  return routes;
}

function buildReq(path, query = {}) {
  const url = new URL(path, "http://localhost");
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return { method: "GET", url: `${url.pathname}${url.search}` };
}

function buildRes() {
  const res = {
    statusCode: null,
    jsonBody: null,
    body: null,
    headers: null,
    _chunks: [],
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; return this; },
    end(chunk) { if (chunk !== undefined) this._chunks.push(chunk); return this; },
  };
  return res;
}

async function invokeRoute(routes, path, query = {}) {
  const route = routes.get(path);
  assert.ok(route, `route ${path} 必须已注册`);
  const req = buildReq(path, query);
  const res = buildRes();
  await route.handler(req, res);
  // sendJson 路径 → res.jsonBody；res.end(JSON.stringify) 路径 → 解析 _chunks
  if (res.jsonBody !== null) return res.jsonBody;
  const raw = res._chunks.join("");
  return raw ? JSON.parse(raw) : null;
}

// operator-catalog.register(api, { checkAuth, sendJson })
const operatorCatalogRoutes = buildRouteMap((api, sendJson) => {
  registerOperatorCatalogRoutes(api, { checkAuth: () => true, sendJson });
});

// test-runs.register(api, logger, { checkAuth })
const testRunsRoutes = buildRouteMap((api, _sendJson, logger) => {
  registerTestRunsRoutes(api, logger, { checkAuth: () => true });
});

// admin-change-sets.register(api, logger, { checkAuth, readJsonBody, sendJson, ... })
const adminChangeSetRoutes = buildRouteMap((api, sendJson, logger) => {
  registerAdminChangeSetRoutes(api, logger, {
    checkAuth: () => true,
    readJsonBody: async () => ({}),
    sendJson,
    registerPostActionRoute: () => {},
    emitAlert: () => {},
    buildRuntimeContext: () => ({}),
  });
});

// api.js 自带 checkAuth/sendJson（基于 cfg.gatewayToken）。无 token 配置时 checkAuth 直接放行。
// 这里只注册并取 graph routes（其余 route 一并注册但不调用）。
const apiRoutes = (() => {
  const routes = new Map();
  const api = {
    registerHttpRoute(route) { routes.set(route.path, route); },
    config: {},
  };
  const logger = { info() {}, warn() {}, error() {} };
  registerApiRoutes(api, logger, {});
  return routes;
})();

// ── ① + ② + ③ 逐 route 等价 ──────────────────────────────────────────────────

test("GET /watchdog/schedules 经 inspect.schedules，params {enabled} 透传且形状等价", async () => {
  for (const enabledQuery of [undefined, "true", "false"]) {
    const enabled = enabledQuery === undefined ? null : enabledQuery === "true";
    const direct = await summarizeScheduleRegistry({ enabled });
    const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.schedules", params: { enabled } });
    assert.deepEqual(viaSurface, direct, `surface 与直读应等价 (enabled=${enabledQuery})`);

    const body = await invokeRoute(operatorCatalogRoutes, "/watchdog/schedules",
      enabledQuery === undefined ? {} : { enabled: enabledQuery });
    // route 后处理：{ generatedAt, ...payload }
    const { generatedAt, ...rest } = body;
    assert.ok(Number.isFinite(generatedAt), "应带 generatedAt 包装");
    assert.deepEqual(rest, direct, `HTTP body（去 generatedAt）应与直读 payload 等价 (enabled=${enabledQuery})`);
  }
});

test("GET /watchdog/agent-joins/registry 经 inspect.agent_joins，params {enabled,status,protocolType} 透传", async () => {
  const params = { enabled: null, status: null, protocolType: null };
  const direct = await summarizeAgentJoinRegistry(params);
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.agent_joins", params });
  assert.deepEqual(viaSurface, direct, "surface 与直读应等价");

  const body = await invokeRoute(operatorCatalogRoutes, "/watchdog/agent-joins/registry", {});
  const { generatedAt, ...rest } = body;
  assert.ok(Number.isFinite(generatedAt), "应带 generatedAt 包装");
  assert.deepEqual(rest, direct, "HTTP body（去 generatedAt）应与直读 payload 等价");

  // params 透传生效性：带 status 过滤时，route 行为与直读同 params 一致
  const directReady = await summarizeAgentJoinRegistry({ enabled: null, status: "ready", protocolType: null });
  const bodyReady = await invokeRoute(operatorCatalogRoutes, "/watchdog/agent-joins/registry", { status: "ready" });
  const { generatedAt: _g, ...restReady } = bodyReady;
  assert.deepEqual(restReady, directReady, "status=ready 时 params 应透传并生效");
});

test("GET /watchdog/system-action-delivery-tickets 经 inspect.delivery_tickets，params {status} 透传", async () => {
  const direct = await summarizeSystemActionDeliveryTickets({ status: null });
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.delivery_tickets", params: { status: null } });
  assert.deepEqual(viaSurface, direct, "surface 与直读应等价");

  const body = await invokeRoute(operatorCatalogRoutes, "/watchdog/system-action-delivery-tickets", {});
  const { generatedAt, ...rest } = body;
  assert.ok(Number.isFinite(generatedAt), "应带 generatedAt 包装");
  assert.deepEqual(rest, direct, "HTTP body（去 generatedAt）应与直读 payload 等价");
});

test("GET /watchdog/test-runs 经 inspect.test_runs（无参），形状等价", async () => {
  const direct = listTestRuns();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.test_runs" });
  assert.deepEqual(viaSurface, direct, "surface 与直读应等价");

  // 该 route 用 res.end(JSON.stringify(payload))，无 generatedAt 包装
  const body = await invokeRoute(testRunsRoutes, "/watchdog/test-runs", {});
  assert.deepEqual(body, direct, "HTTP body 应与直读 payload 完全等价（无包装）");
});

test("GET /watchdog/admin-change-sets (GET) 经 inspect.change_sets（无参），count+包装形状等价", async () => {
  const direct = await listAdminChangeSets();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.change_sets" });
  assert.deepEqual(viaSurface, direct, "surface 与直读应等价");

  const body = await invokeRoute(adminChangeSetRoutes, "/watchdog/admin-change-sets", {});
  assert.ok(Number.isFinite(body.generatedAt), "应带 generatedAt 包装");
  assert.equal(body.count, direct.length, "count 应等于 drafts 长度");
  assert.deepEqual(body.drafts, direct, "drafts 数组应与直读等价");
});

// ── 静态护栏：route 文件不再直读已迁移的 store 函数 ───────────────────────────

test("已迁移 route 文件不再直读对应 store 函数（双读路径已收口）", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

  const opCat = await read("../routes/operator-catalog.js");
  assert.doesNotMatch(opCat, /summarizeScheduleRegistry/, "operator-catalog 不应再直读 summarizeScheduleRegistry");
  assert.doesNotMatch(opCat, /summarizeAgentJoinRegistry/, "operator-catalog 不应再直读 summarizeAgentJoinRegistry");
  assert.doesNotMatch(opCat, /summarizeSystemActionDeliveryTickets/, "operator-catalog 不应再直读 summarizeSystemActionDeliveryTickets");
  // batch 2：automations / work-items 已迁，对应 store 直读应归零
  assert.doesNotMatch(opCat, /summarizeAutomationRuntimeRegistry/, "operator-catalog 不应再直读 summarizeAutomationRuntimeRegistry");
  assert.doesNotMatch(opCat, /listLifecycleWorkItems/, "operator-catalog 不应再直读 listLifecycleWorkItems");
  assert.match(opCat, /inspect\.schedules/);
  assert.match(opCat, /inspect\.agent_joins/);
  assert.match(opCat, /inspect\.delivery_tickets/);
  assert.match(opCat, /inspect\.automation_runtime_summary/);
  assert.match(opCat, /inspect\.work_items/);
  // work-items 的后置过滤必须保留在 route
  assert.match(opCat, /isMainViewWorkItem/, "work-items route 必须保留 isMainViewWorkItem 过滤");
  // automations 的 query normalize 必须保留
  assert.match(opCat, /normalizeAutomationStatusQuery/, "automations route 必须保留 normalizeAutomationStatusQuery");

  const testRunsSrc = await read("../routes/test-runs.js");
  assert.doesNotMatch(testRunsSrc, /listTestRuns/, "test-runs route 不应再直读 listTestRuns");
  assert.match(testRunsSrc, /getTestRunDetails/, "getTestRunDetails 应保留（detail route 未迁）");
  assert.match(testRunsSrc, /inspect\.test_runs/);

  const changeSetsSrc = await read("../routes/admin-change-sets.js");
  assert.doesNotMatch(changeSetsSrc, /listAdminChangeSets/, "admin-change-sets route 不应再直读 listAdminChangeSets");
  // mutate/execute 分支保留
  assert.match(changeSetsSrc, /saveAdminChangeSetDraft/, "saveAdminChangeSetDraft 应保留（apply 分支）");
  assert.match(changeSetsSrc, /executeAdminChangeSet/, "executeAdminChangeSet 应保留（apply 分支）");
  assert.match(changeSetsSrc, /inspect\.change_sets/);
});

// ── batch 2：3 个中风险 route ────────────────────────────────────────────────

test("GET /watchdog/automations 经 inspect.automation_runtime_summary，normalize + params 透传等价", async () => {
  // 默认（无 query）
  const direct = await summarizeAutomationRuntimeRegistry({ enabled: null, status: null });
  const viaSurface = await inspectCliSystemSurface({
    surfaceId: "inspect.automation_runtime_summary",
    params: { enabled: null, status: null },
  });
  assert.deepEqual(viaSurface, direct, "surface 与直读应等价");

  const body = await invokeRoute(operatorCatalogRoutes, "/watchdog/automations", {});
  const { generatedAt, ...rest } = body;
  assert.ok(Number.isFinite(generatedAt), "应带 generatedAt 包装");
  assert.deepEqual(rest, direct, "HTTP body（去 generatedAt）应与直读 payload 等价");

  // status query 经 normalizeAutomationStatusQuery 归一（大小写/trim）后透传：
  // route 收到 "Running" → normalize 成 "running"，与直读 status:"running" 等价
  const directRunning = await summarizeAutomationRuntimeRegistry({ enabled: null, status: "running" });
  const bodyRunning = await invokeRoute(operatorCatalogRoutes, "/watchdog/automations", { status: "Running" });
  const { generatedAt: _g, ...restRunning } = bodyRunning;
  assert.deepEqual(restRunning, directRunning, "status=Running 经 normalize 后应与 status:running 直读等价");

  // enabled=true 透传
  const directEnabled = await summarizeAutomationRuntimeRegistry({ enabled: true, status: null });
  const bodyEnabled = await invokeRoute(operatorCatalogRoutes, "/watchdog/automations", { enabled: "true" });
  const { generatedAt: _g2, ...restEnabled } = bodyEnabled;
  assert.deepEqual(restEnabled, directEnabled, "enabled=true 应透传并生效");
});

// route 内 isMainViewWorkItem 是私有函数，这里复刻其逻辑做过滤对照
function isMainViewWorkItemMirror(workItem) {
  if (!workItem || typeof workItem !== "object") return false;
  if (workItem.mainViewVisible === false) return false;
  const assignee = typeof workItem.assignee === "string" ? workItem.assignee.trim() : "";
  if (assignee && getAgentIdentitySnapshot(assignee).mainViewVisible === false) {
    return false;
  }
  return true;
}

test("GET /watchdog/work-items 经 inspect.work_items 取全量，route 保留 isMainViewWorkItem 过滤", async () => {
  const direct = await listLifecycleWorkItems();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.work_items" });
  // surface 返回全量，与直读全量等价
  assert.deepEqual(viaSurface, direct, "surface 应返回全量，与直读等价");

  // route 后处理 = 全量过滤后的数组（无包装）
  const body = await invokeRoute(operatorCatalogRoutes, "/watchdog/work-items", {});
  assert.ok(Array.isArray(body), "HTTP body 应是数组");
  const expected = direct.filter((item) => isMainViewWorkItemMirror(item));
  assert.deepEqual(body, expected, "HTTP body 应为 isMainViewWorkItem 过滤后的全量数组");
  // 过滤确实在 route 生效：body 长度 <= 全量
  assert.ok(body.length <= viaSurface.length, "过滤后长度不应超过全量");
});

test("GET /watchdog/harness：summarizeHarnessDashboard 内部经 inspect surface 后输出等价", async () => {
  // facade 内部已收口（automation summary 经 inspect.automation_runtime_summary）。
  // 端到端：summarizeHarnessDashboard() 输出应稳定可用（与直读 store 时代结构一致）。
  const payload = await summarizeHarnessDashboard();
  assert.ok(payload && typeof payload === "object", "summarizeHarnessDashboard 应返回对象");
  // 经 route 取与直接调 facade 应一致（route 仅透传 facade 输出）
  // 注：facade 内含 generatedAt=Date.now()，每次调用必然不同，比较时剔除
  const body = await invokeRoute(operatorCatalogRoutes, "/watchdog/harness", {});
  const { generatedAt: _bodyTs, ...bodyRest } = body;
  const { generatedAt: _payloadTs, ...payloadRest } = payload;
  assert.ok(Number.isFinite(body.generatedAt) && Number.isFinite(payload.generatedAt), "facade 应带 generatedAt 时间戳");
  assert.deepEqual(bodyRest, payloadRest, "route /watchdog/harness 应原样返回 facade 输出（去 generatedAt）");

  // 幂等：facade 两次调用结构一致（surface 路径稳定，去时间戳）
  const payload2 = await summarizeHarnessDashboard();
  const { generatedAt: _payload2Ts, ...payload2Rest } = payload2;
  assert.deepEqual(payload2Rest, payloadRest, "facade 经 surface 后应稳定幂等（去 generatedAt）");
});

test("harness-dashboard.js facade 内部不再直读 summarizeAutomationRuntimeRegistry（lib 层收口）", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/harness/harness-dashboard.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /summarizeAutomationRuntimeRegistry/, "harness-dashboard 不应再直读 summarizeAutomationRuntimeRegistry");
  assert.match(src, /inspectCliSystemSurface/, "harness-dashboard 应经 inspectCliSystemSurface 读 automation summary");
  assert.match(src, /inspect\.automation_runtime_summary/, "应引用 inspect.automation_runtime_summary");
});

// ── batch 3：3 个 graph route + 新 surface inspect.active_loop_session ──────────

test("inspect.active_loop_session surface 存在且合规", () => {
  const surface = getCliSystemSurface("inspect.active_loop_session");
  assert.ok(surface, "inspect.active_loop_session 必须可经 getCliSystemSurface 取到");
  assert.equal(surface.family, "inspect");
  assert.equal(surface.status, "active");
  assert.equal(surface.source, "runtime_inspect");
  assert.equal(surface.operatorExecutable, false);
  assert.equal(surface.displayId, "control:inspect.active_loop_session");
  const { ok, problems } = validateCliSurface(surface);
  assert.equal(ok, true, `inspect.active_loop_session 必须通过冻结 schema: ${problems.join("; ")}`);
});

test("inspect.active_loop_session 行为等价于 getActiveResolvedLoopSession（透传 {loops}）", async () => {
  const graph = await loadGraph();
  const loops = await listResolvedGraphLoops({ graph });
  const direct = await getActiveResolvedLoopSession({ loops });
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.active_loop_session", params: { loops } });
  assert.deepEqual(viaSurface, direct, "surface 与直读应等价（同 loops 参数）");

  // loops=null 兜底等价
  const directNull = await getActiveResolvedLoopSession({ loops: null });
  const viaNull = await inspectCliSystemSurface({ surfaceId: "inspect.active_loop_session" });
  assert.deepEqual(viaNull, directNull, "loops 缺省时仍等价");
});

// 直读组合：复刻 route 原本的多源拼装逻辑（迁移前形状），用于逐字段对照
async function directGraphPayload() {
  const graph = await loadGraph();
  const cycles = detectCycles(graph);
  const loops = await listResolvedGraphLoops({ graph });
  const loopSessions = await listResolvedLoopSessions({ loops });
  const activeLoopSession = await getActiveResolvedLoopSession({ loops });
  return { edges: graph.edges, cycles, loops, loopSessions, activeLoopSession };
}

test("GET /watchdog/graph 经 surface 组合，与直读组合逐字段等价", async () => {
  const expected = await directGraphPayload();
  const body = await invokeRoute(apiRoutes, "/watchdog/graph", {});
  // nodes 来自 runtime agent config（非 store 旁路，不在等价范围；只断言存在）
  assert.ok(Array.isArray(body.nodes), "nodes 应是数组");
  // 逐字段等价（edges/cycles/loops/loopSessions/activeLoopSession）
  assert.deepEqual(body.edges, expected.edges, "edges 应等价");
  assert.deepEqual(body.cycles, expected.cycles, "cycles 应等价（detectCycles 纯算法保留）");
  assert.deepEqual(body.loops, expected.loops, "loops 应等价");
  assert.deepEqual(body.loopSessions, expected.loopSessions, "loopSessions 应等价");
  assert.deepEqual(body.activeLoopSession, expected.activeLoopSession, "activeLoopSession 应等价");
});

test("GET /watchdog/graph/loops 经 surface 组合，与直读组合逐字段等价", async () => {
  const expected = await directGraphPayload();
  const body = await invokeRoute(apiRoutes, "/watchdog/graph/loops", {});
  assert.deepEqual(body.loops, expected.loops, "loops 应等价");
  assert.deepEqual(body.loopSessions, expected.loopSessions, "loopSessions 应等价");
  assert.deepEqual(body.activeLoopSession, expected.activeLoopSession, "activeLoopSession 应等价");
  assert.deepEqual(body.cycles, expected.cycles, "cycles 应等价");
});

test("GET /watchdog/graph/loop-sessions 经 surface 组合，与直读组合逐字段等价", async () => {
  const expected = await directGraphPayload();
  const body = await invokeRoute(apiRoutes, "/watchdog/graph/loop-sessions", {});
  assert.deepEqual(body.activeSession, expected.activeLoopSession, "activeSession 应等价");
  assert.deepEqual(body.sessions, expected.loopSessions, "sessions 应等价");
});

test("routes/api.js 三个 graph GET route 不再直读 store（detectCycles 纯算法保留）", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../routes/api.js", import.meta.url), "utf8");
  // loadGraph / listResolvedLoopSessions / getActiveResolvedLoopSession 已归零
  assert.doesNotMatch(src, /loadGraph/, "api.js 不应再直读 loadGraph（graph GET 已收口）");
  assert.doesNotMatch(src, /listResolvedLoopSessions/, "api.js 不应再直读 listResolvedLoopSessions");
  assert.doesNotMatch(src, /getActiveResolvedLoopSession/, "api.js 不应再直读 getActiveResolvedLoopSession");
  // Batch B：bare /watchdog/graph/edge 死重复写路由已删除，addEdge/removeEdge 不再直读
  assert.doesNotMatch(src, /addEdge/, "api.js 不应再直读 addEdge（死重复 edge mutate 路由已删）");
  assert.doesNotMatch(src, /removeEdge/, "api.js 不应再直读 removeEdge（死重复 edge mutate 路由已删）");
  assert.doesNotMatch(src, /path: "\/watchdog\/graph\/edge"/, "bare /watchdog/graph/edge 路由应已删除");
  // listResolvedGraphLoops 已归零：3 个 graph GET route 经 inspect.graph_loops，
  // 死 edge mutate 路由（其最后一个直读消费者）删除后，该 import 成孤儿被一并清除。
  assert.doesNotMatch(src, /listResolvedGraphLoops/, "listResolvedGraphLoops import 应已清除（孤儿）");
  // detectCycles 纯算法保留（3 个 graph GET route 仍用）
  assert.match(src, /detectCycles/, "detectCycles 应保留（纯拓扑算法）");
  // 改为经 inspect surface
  assert.match(src, /inspect\.agent_graph/);
  assert.match(src, /inspect\.graph_loops/);
  assert.match(src, /inspect\.loop_sessions/);
  assert.match(src, /inspect\.active_loop_session/);
});

// ── batch 4（最后）：/watchdog/runtime + 新 surface inspect.runtime_state ───────

test("inspect.runtime_state surface 存在且合规", () => {
  const surface = getCliSystemSurface("inspect.runtime_state");
  assert.ok(surface, "inspect.runtime_state 必须可经 getCliSystemSurface 取到");
  assert.equal(surface.family, "inspect");
  assert.equal(surface.status, "active");
  assert.equal(surface.source, "runtime_inspect");
  assert.equal(surface.operatorExecutable, false);
  assert.equal(surface.displayId, "control:inspect.runtime_state");
  const { ok, problems } = validateCliSurface(surface);
  assert.equal(ok, true, `inspect.runtime_state 必须通过冻结 schema: ${problems.join("; ")}`);
});

// dispatchRuntime.ts 是 Date.now() 时间戳 — 比较前剔除
function stripRuntimeTs(runtimeState) {
  const clone = JSON.parse(JSON.stringify(runtimeState || {}));
  if (clone.dispatchRuntime && typeof clone.dispatchRuntime === "object") {
    delete clone.dispatchRuntime.ts;
  }
  return clone;
}

test("inspect.runtime_state 行为等价于 inspectCliRuntimeState（复用，剔 ts）", async () => {
  const direct = inspectCliRuntimeState();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.runtime_state" });
  // dispatchRuntime/trackingSessions/historyCount/dispatchChainSize 四源齐全
  assert.ok("dispatchRuntime" in viaSurface, "应含 dispatchRuntime");
  assert.ok("trackingSessions" in viaSurface, "应含 trackingSessions");
  assert.ok("historyCount" in viaSurface, "应含 historyCount（已纳入 inspector）");
  assert.ok("dispatchChainSize" in viaSurface, "应含 dispatchChainSize（已纳入 inspector）");
  assert.deepEqual(stripRuntimeTs(viaSurface), stripRuntimeTs(direct), "surface 与直读应等价（剔 dispatchRuntime.ts）");
});

// 复刻 /watchdog/runtime 原本的多源拼装（迁移前形状），逐字段对照
function buildRuntimeBodyFrom(runtimeState, sseClientCount) {
  const dispatchRuntimeSnapshot = runtimeState.dispatchRuntime || {};
  const dispatchQueueEntries = Array.isArray(dispatchRuntimeSnapshot.queue)
    ? dispatchRuntimeSnapshot.queue
    : [];
  return {
    trackingSessions: runtimeState.trackingSessions,
    historyCount: runtimeState.historyCount,
    sseClientCount,
    dispatchChainSize: runtimeState.dispatchChainSize,
    dispatchQueue: {
      entries: dispatchQueueEntries,
      contractIds: dispatchQueueEntries
        .map((entry) => typeof entry === "string" ? entry : entry?.contractId)
        .filter((contractId) => typeof contractId === "string" && contractId.trim()),
    },
    dispatchRuntime: {
      targets: dispatchRuntimeSnapshot.targets,
      outgoingBySource: dispatchRuntimeSnapshot.outgoingBySource,
      contractFlow: dispatchRuntimeSnapshot.contractFlow,
      ts: dispatchRuntimeSnapshot.ts,
    },
  };
}

// dispatchRuntime.ts 来自 buildDispatchRuntimeSnapshot（每次 Date.now()）— 比较前剔除
function stripBodyTs(body) {
  const clone = JSON.parse(JSON.stringify(body || {}));
  if (clone.dispatchRuntime && typeof clone.dispatchRuntime === "object") {
    delete clone.dispatchRuntime.ts;
  }
  return clone;
}

test("GET /watchdog/runtime 经 inspect.runtime_state 组合，与直读组合逐字段等价（剔 ts，sseClientCount 留 transport）", async () => {
  const expected = buildRuntimeBodyFrom(inspectCliRuntimeState(), getSseClientCount());
  const body = await invokeRoute(apiRoutes, "/watchdog/runtime", {});

  // 嵌套结构逐字段等价（剔除 dispatchRuntime.ts 时间戳）
  assert.deepEqual(stripBodyTs(body), stripBodyTs(expected), "HTTP body 应与直读组合逐字段等价（剔 ts）");
  // sseClientCount 是 transport 计数，仍在 body 里（类型正确）
  assert.equal(typeof body.sseClientCount, "number", "sseClientCount（transport）应保留为数字");
  // ts 字段存在（来自 dispatch snapshot），只是值随时间变
  assert.ok("ts" in body.dispatchRuntime, "dispatchRuntime.ts 字段应保留");
});

test("routes/api.js /watchdog/runtime 不再直读 store（保留 getSseClientCount transport）", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../routes/api.js", import.meta.url), "utf8");
  // 4 个 store 读已归零
  assert.doesNotMatch(src, /buildDispatchRuntimeSnapshot/, "api.js 不应再直读 buildDispatchRuntimeSnapshot");
  assert.doesNotMatch(src, /snapshotTrackingSessions/, "api.js 不应再直读 snapshotTrackingSessions");
  assert.doesNotMatch(src, /getTaskHistoryCount/, "api.js 不应再直读 getTaskHistoryCount");
  assert.doesNotMatch(src, /getDispatchChainSize/, "api.js 不应再直读 getDispatchChainSize");
  // getSseClientCount 是 transport 连接计数，保留直取
  assert.match(src, /getSseClientCount/, "getSseClientCount（transport）应保留直取");
  // 改为经 inspect surface
  assert.match(src, /inspect\.runtime_state/, "应引用 inspect.runtime_state");
});

test("inspect.runtime_state 复用 cli-runtime-inspector（不造重复真值源）", async () => {
  const { readFile } = await import("node:fs/promises");
  // 1) inspector 把 4 源纳入（含新增 history/chain）
  const inspectorSrc = await readFile(new URL("../lib/cli-system/cli-runtime-inspector.js", import.meta.url), "utf8");
  assert.match(inspectorSrc, /getTaskHistoryCount/, "cli-runtime-inspector 应纳入 getTaskHistoryCount");
  assert.match(inspectorSrc, /getDispatchChainSize/, "cli-runtime-inspector 应纳入 getDispatchChainSize");
  // 2) inspect.runtime_state 的 source 复用 inspectCliRuntimeState，而非重造
  const surfaceInspectorSrc = await readFile(new URL("../lib/cli-system/cli-surface-inspector.js", import.meta.url), "utf8");
  assert.match(surfaceInspectorSrc, /inspectCliRuntimeState/, "inspect.runtime_state 应复用 inspectCliRuntimeState");
});

// ── Batch A：observe 读路径（SSE）+ capability route 收口 → inspect surface ──────

const BATCH_A_SURFACES = [
  "inspect.tracking_states",
  "inspect.recent_task_history",
  "inspect.capability_registry",
];

for (const id of BATCH_A_SURFACES) {
  test(`${id} surface 存在且合规`, () => {
    const surface = getCliSystemSurface(id);
    assert.ok(surface, `${id} 必须可经 getCliSystemSurface 取到`);
    assert.equal(surface.family, "inspect");
    assert.equal(surface.status, "active");
    assert.equal(surface.source, "runtime_inspect");
    assert.equal(surface.operatorExecutable, false);
    assert.equal(surface.displayId, `control:${id}`);
    const { ok, problems } = validateCliSurface(surface);
    assert.equal(ok, true, `${id} 必须通过冻结 schema: ${problems.join("; ")}`);
  });
}

test("inspect.tracking_states 行为等价于 listTrackingStates（无参）", async () => {
  const direct = listTrackingStates();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.tracking_states" });
  assert.ok(Array.isArray(viaSurface), "应返回数组");
  assert.deepEqual(viaSurface, direct, "surface 与直读应等价");
});

test("inspect.recent_task_history 行为等价于 getRecentTaskHistory（透传 limit，默认 10）", async () => {
  // 默认 limit（与 SSE 原 getRecentTaskHistory(10) 一致）
  const direct10 = getRecentTaskHistory(10);
  const viaDefault = await inspectCliSystemSurface({ surfaceId: "inspect.recent_task_history", params: { limit: 10 } });
  assert.deepEqual(viaDefault, direct10, "limit=10 应等价");
  // wrapper 缺省 limit 也应是 10
  const viaNoParam = await inspectCliSystemSurface({ surfaceId: "inspect.recent_task_history" });
  assert.deepEqual(viaNoParam, getRecentTaskHistory(10), "缺省 params 时 limit 默认 10，与原 SSE 行为一致");
  // 透传其它 limit 生效
  const direct3 = getRecentTaskHistory(3);
  const via3 = await inspectCliSystemSurface({ surfaceId: "inspect.recent_task_history", params: { limit: 3 } });
  assert.deepEqual(via3, direct3, "limit=3 应透传并生效");
});

test("inspect.capability_registry 行为等价于 loadCapabilityRegistry（无参）", async () => {
  const direct = await loadCapabilityRegistry();
  const viaSurface = await inspectCliSystemSurface({ surfaceId: "inspect.capability_registry" });
  assert.deepEqual(viaSurface, direct, "surface 与直读应等价（组装快照）");
});

// SSE 流难端到端测（长连接/心跳），故锁"读经 surface 等价" + dashboard.js 静态护栏
test("routes/dashboard.js SSE 不再直读 tracker/history store（读路径经 surface，推/transport 保留）", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../routes/dashboard.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /listTrackingStates/, "dashboard 不应再直读 listTrackingStates");
  assert.doesNotMatch(src, /getRecentTaskHistory/, "dashboard 不应再直读 getRecentTaskHistory");
  // 读路径经 inspect surface
  assert.match(src, /inspect\.tracking_states/, "应引用 inspect.tracking_states");
  assert.match(src, /inspect\.recent_task_history/, "应引用 inspect.recent_task_history");
  // 推流/transport 保留（buildProgressPayload + SSE write）
  assert.match(src, /buildProgressPayload/, "buildProgressPayload 推流逻辑应保留");
  assert.match(src, /event: track_start/, "SSE track_start 推送应保留");
  assert.match(src, /event: track_end/, "SSE track_end 推送应保留");
});

test("routes/operator-catalog.js /watchdog/capability-registry 经 surface，包装等价；a2a.js 不动", async () => {
  // 经 route 取（buildRouteMap 已注册 operatorCatalogRoutes）
  const direct = await loadCapabilityRegistry();
  const body = await invokeRoute(operatorCatalogRoutes, "/watchdog/capability-registry", {});
  // 后处理：{ generatedAt, ...registry }
  const { generatedAt, ...rest } = body;
  assert.ok(Number.isFinite(generatedAt), "应带 generatedAt 包装");
  assert.deepEqual(rest, direct, "HTTP body（去 generatedAt）应与直读 registry 等价");

  const { readFile } = await import("node:fs/promises");
  const opCatSrc = await readFile(new URL("../routes/operator-catalog.js", import.meta.url), "utf8");
  assert.doesNotMatch(opCatSrc, /loadCapabilityRegistry/, "operator-catalog route 不应再直读 loadCapabilityRegistry");
  assert.match(opCatSrc, /inspect\.capability_registry/, "应引用 inspect.capability_registry");
  // 仍保留 capability-registry 的其它 import（listAgentRegistry 等）
  assert.match(opCatSrc, /listAgentRegistry/, "listAgentRegistry 应保留");

  // a2a.js 协议边界判合法，不动 — 仍直接 import/用 loadCapabilityRegistry
  const a2aSrc = await readFile(new URL("../routes/a2a.js", import.meta.url), "utf8");
  assert.match(a2aSrc, /loadCapabilityRegistry/, "a2a.js 应保留 loadCapabilityRegistry（协议边界合法直读，不迁）");
});
