// routes/api.js — runtime, tests, agents, reset

import {
  cfg,
} from "../lib/state.js";
import { broadcast, getSseClientCount } from "../lib/transport/sse.js";
import { EVENT_TYPE } from "../lib/core/event-types.js";
import { detectCycles } from "../lib/agent/agent-graph.js";
import { getRuntimeAgentConfig, listRuntimeAgentIds } from "../lib/agent/agent-identity.js";
import { getCliSystemSurface, inspectCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { executeAdminSurfaceOperation } from "../lib/admin/admin-surface-operations.js";
import {
  buildOperatorPlan,
  executeOperatorPlan,
} from "../lib/operator-runtime.js";
import { writeLocalAgentGuidanceContent } from "../lib/agent/agent-enrollment-guidance.js";
import { syncAllRuntimeWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";
import { register as registerAdminChangeSetRoutes } from "./admin-change-sets.js";
import { register as registerControlPlaneRoutes } from "./control-plane.js";
import { register as registerOperatorCatalogRoutes } from "./operator-catalog.js";
import { register as registerTestRunsRoutes } from "./test-runs.js";
import { terminalizeContractForTestRunner } from "../lib/test-runner-terminalize.js";
import { revealFileInFinder } from "../lib/agent/agent-reveal-file.js";

export function register(api, logger, deps) {
  const { enqueueFn, wakePlanner } = deps;
  const { gatewayToken } = cfg;
  const JSON_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "http://localhost:18789",
  };

  function checkAuth(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
      res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return false;
    }
    return true;
  }

  async function readJsonBody(req) {
    let body = "";
    for await (const chunk of req) body += chunk;
    return body ? JSON.parse(body) : {};
  }

  function sendJson(res, status, payload) {
    res.writeHead(status, JSON_HEADERS);
    res.end(JSON.stringify(payload));
  }

  function emitAlert(payload) {
    if (payload?.type) {
      broadcast("alert", payload);
    }
  }

  function registerPostActionRoute(path, action, {
    invalidMethodMessage = "POST only",
    requireExplicitConfirm = false,
  } = {}) {
    api.registerHttpRoute({
      path,
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (!checkAuth(req, res)) return true;
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "text/plain" });
          res.end(invalidMethodMessage);
          return true;
        }
        try {
          const payload = await readJsonBody(req);
          if (requireExplicitConfirm && payload.explicitConfirm !== true) {
            throw new Error("explicit confirmation required");
          }
          const result = await action(payload);
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error.message });
        }
        return true;
      },
    });
  }

  function buildAdminSurfaceRuntimeContext(surfaceId) {
    return {
      api,
      enqueue: enqueueFn,
      wakePlanner,
      originDraftId: null,
      originSurfaceId: surfaceId,
    };
  }

  function registerAdminSurfacePostRoute(path, surfaceId, {
    requireExplicitConfirm = false,
    mapPayload = (payload) => payload,
  } = {}) {
    registerPostActionRoute(path, async (payload) => executeAdminSurfaceOperation({
      surfaceId,
      payload: mapPayload(payload),
      logger,
      onAlert: emitAlert,
      runtimeContext: buildAdminSurfaceRuntimeContext(surfaceId),
    }), {
      requireExplicitConfirm,
    });
  }

  function buildChangeSetRuntimeContext() {
    return {
      api,
      enqueue: enqueueFn,
      wakePlanner,
    };
  }

  // ── Test Inject ─────────────────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/watchdog/tests/inject", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      if (req.method !== "POST") { res.writeHead(405, { "Content-Type": "text/plain" }); res.end("POST only"); return true; }
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const payload = JSON.parse(body);
        const { message, source } = payload;
        if (!message) throw new Error("missing message");
        logger.info(`[watchdog] TEST-INJECT: ${message.slice(0, 80)} (source=${source})`);
        const result = await executeAdminSurfaceOperation({
          surfaceId: "test.inject",
          payload,
          logger,
          onAlert: emitAlert,
          runtimeContext: buildAdminSurfaceRuntimeContext("test.inject"),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return true;
    },
  });

  // ── Reveal File（macOS Finder 定位，严格白名单 + execFile）──────────────────
  api.registerHttpRoute({
    path: "/watchdog/reveal-file", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("POST only");
        return true;
      }
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid JSON body" });
        return true;
      }
      const path = typeof payload?.path === "string" ? payload.path.trim() : "";
      if (!path) {
        sendJson(res, 400, { ok: false, error: "path required" });
        return true;
      }
      try {
        const result = await revealFileInFinder(path);
        sendJson(res, 200, { ok: true, resolvedPath: result.resolvedPath });
      } catch (error) {
        // 白名单外 / .. 逃逸 → 403；其它（open 失败等）→ 400
        const status = error?.message === "path not allowed" ? 403 : 400;
        sendJson(res, status, { ok: false, error: error.message });
      }
      return true;
    },
  });

  // ── Inspect Surface（前端只读观测 HTTP 面，只放行 inspect 家族）─────────────
  // query: surface（必填）+ 透传其余 query 作 params（如 agentId/sessionId）。
  // 红线：不允许经此调 apply/admin —— 取到 surface 后校验 family==="inspect"，否则 403。
  api.registerHttpRoute({
    path: "/watchdog/inspect", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      const url = new URL(req.url, "http://localhost");
      const surfaceId = (url.searchParams.get("surface") || "").trim();
      if (!surfaceId) {
        sendJson(res, 400, { error: "surface required" });
        return true;
      }
      const surface = getCliSystemSurface(surfaceId);
      if (!surface) {
        sendJson(res, 403, { error: `unknown surface: ${surfaceId}` });
        return true;
      }
      if (surface.family !== "inspect") {
        sendJson(res, 403, { error: `surface is not inspect family: ${surfaceId}` });
        return true;
      }
      // 透传除 surface/token 外的其余 query 作 params（agentId/sessionId/limit…）。
      const params = {};
      for (const [key, value] of url.searchParams.entries()) {
        if (key === "surface" || key === "token") continue;
        params[key] = value;
      }
      try {
        const data = await inspectCliSystemSurface({ surfaceId, params });
        sendJson(res, 200, data);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  registerPostActionRoute("/watchdog/tests/terminalize", async (payload) => terminalizeContractForTestRunner({
    ...payload,
    source: payload.source || "test_runner",
    reason: payload.reason || "test_terminalize",
    logger,
    api,
  }));

  registerOperatorCatalogRoutes(api, {
    checkAuth,
    sendJson,
  });

  registerAdminChangeSetRoutes(api, logger, {
    checkAuth,
    readJsonBody,
    sendJson,
    registerPostActionRoute,
    emitAlert,
    buildRuntimeContext: buildChangeSetRuntimeContext,
  });

  registerControlPlaneRoutes(api, logger, {
    checkAuth,
    readJsonBody,
    sendJson,
  });

  registerTestRunsRoutes(api, logger, { ...deps, checkAuth });

  // ── Runtime Summary ────────────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/watchdog/runtime", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      // dispatch runtime + tracking + history/chain 计数经 CLI-system inspect surface 读取，
      // 不直读 store（收口旁路）。sseClientCount 是 transport 连接计数（非 store），留在 route。
      const runtimeState = await inspectCliSystemSurface({ surfaceId: "inspect.runtime_state" });
      const dispatchRuntimeSnapshot = runtimeState.dispatchRuntime || {};
      const dispatchQueueEntries = Array.isArray(dispatchRuntimeSnapshot.queue)
        ? dispatchRuntimeSnapshot.queue
        : [];
      const state = {
        trackingSessions: runtimeState.trackingSessions,
        historyCount: runtimeState.historyCount,
        sseClientCount: getSseClientCount(),
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
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(state, null, 2));
      return true;
    },
  });

  // ── Agent defaults / profile / capability mutation routes ─────────────────
  registerAdminSurfacePostRoute("/watchdog/agents/create", "agents.create");
  registerAdminSurfacePostRoute("/watchdog/agents/join", "agents.join", {
    mapPayload: (payload) => ({
      ...payload,
      agentId: payload.agentId,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/agents/guidance/takeover", "agents.guidance.takeover", {
    mapPayload: (payload) => ({
      ...payload,
      agentId: payload.agentId,
    }),
  });
  registerPostActionRoute("/watchdog/agents/guidance/write", async (payload) => writeLocalAgentGuidanceContent({
    payload: {
      ...payload,
      agentId: payload.agentId,
      fileName: payload.fileName ?? payload.file,
    },
    logger,
    onAlert: emitAlert,
  }));
  registerAdminSurfacePostRoute("/watchdog/agents/defaults/model", "agents.defaults.model");
  registerAdminSurfacePostRoute("/watchdog/agents/defaults/heartbeat", "agents.defaults.heartbeat");
  registerAdminSurfacePostRoute("/watchdog/agents/defaults/skills", "agents.defaults.skills", {
    mapPayload: (payload) => ({
      ...payload,
      skills: payload.skills ?? payload.skillsText,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/agents/model", "agents.model");
  registerAdminSurfacePostRoute("/watchdog/agents/heartbeat", "agents.heartbeat");
  registerAdminSurfacePostRoute("/watchdog/agents/constraints", "agents.constraints");
  registerAdminSurfacePostRoute("/watchdog/agents/name", "agents.name");
  registerAdminSurfacePostRoute("/watchdog/agents/description", "agents.description");
  registerAdminSurfacePostRoute("/watchdog/agents/tools", "agents.tools", {
    mapPayload: (payload) => ({
      ...payload,
      tools: payload.tools ?? payload.toolsText,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/agents/card/formats", "agents.card.formats", {
    mapPayload: (payload) => ({
      ...payload,
      inputFormats: payload.inputFormats ?? payload.inputFormatsText,
      outputFormats: payload.outputFormats ?? payload.outputFormatsText,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/agents/role", "agents.role");
  registerAdminSurfacePostRoute("/watchdog/agents/skills", "agents.skills", {
    mapPayload: (payload) => ({
      ...payload,
      skills: payload.skills ?? payload.skillsText,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/agent-joins/create", "agent_joins.create");
  registerAdminSurfacePostRoute("/watchdog/agent-joins/update", "agent_joins.update");
  registerAdminSurfacePostRoute("/watchdog/agent-joins/enable", "agent_joins.enable");
  registerAdminSurfacePostRoute("/watchdog/agent-joins/disable", "agent_joins.disable");
  registerAdminSurfacePostRoute("/watchdog/agent-joins/delete", "agent_joins.delete", {
    requireExplicitConfirm: true,
  });
  registerAdminSurfacePostRoute("/watchdog/graph/edge/add", "graph.edge.add");
  registerAdminSurfacePostRoute("/watchdog/graph/edge/delete", "graph.edge.delete");
  registerAdminSurfacePostRoute("/watchdog/graph/loop/compose", "graph.loop.compose", {
    mapPayload: (payload) => ({
      ...payload,
      agents: payload.agents ?? payload.agentsText,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/graph/group/compose", "graph.group.compose", {
    mapPayload: (payload) => ({
      ...payload,
      agents: payload.agents ?? payload.agentsText ?? payload.members,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/graph/loop/delete", "graph.loop.delete");
  registerAdminSurfacePostRoute("/watchdog/graph/loop/repair", "graph.loop.repair");
  registerAdminSurfacePostRoute("/watchdog/skills/create", "skills.create");
  registerAdminSurfacePostRoute("/watchdog/schedules/create", "schedules.create");
  registerAdminSurfacePostRoute("/watchdog/schedules/update", "schedules.update");
  registerAdminSurfacePostRoute("/watchdog/schedules/enable", "schedules.enable");
  registerAdminSurfacePostRoute("/watchdog/schedules/disable", "schedules.disable");
  registerAdminSurfacePostRoute("/watchdog/schedules/delete", "schedules.delete");
  registerAdminSurfacePostRoute("/watchdog/automations/create", "automations.create");
  registerAdminSurfacePostRoute("/watchdog/automations/update", "automations.update");
  registerAdminSurfacePostRoute("/watchdog/automations/enable", "automations.enable");
  registerAdminSurfacePostRoute("/watchdog/automations/disable", "automations.disable");
  registerAdminSurfacePostRoute("/watchdog/automations/run", "automations.run");
  registerAdminSurfacePostRoute("/watchdog/automations/governance", "automations.governance");
  registerAdminSurfacePostRoute("/watchdog/automations/delete", "automations.delete", {
    requireExplicitConfirm: true,
  });

  // ── Delete agent ───────────────────────────────────────────────────────────
  registerAdminSurfacePostRoute("/watchdog/agents/delete", "agents.delete", {
    requireExplicitConfirm: true,
  });
  registerAdminSurfacePostRoute("/watchdog/agents/hard-delete", "agents.hard_delete", {
    requireExplicitConfirm: true,
  });

  // ── Reset ──────────────────────────────────────────────────────────────────
  registerAdminSurfacePostRoute("/watchdog/reset", "runtime.reset", {
    requireExplicitConfirm: true,
  });
  registerAdminSurfacePostRoute("/watchdog/runtime/loop/start", "runtime.loop.start", {
    mapPayload: (payload) => ({
      ...payload,
      loopId: payload.loopId,
      startAgent: payload.startAgent,
      requestedTask: payload.requestedTask,
      requestedSource: payload.requestedSource,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/runtime/loop/interrupt", "runtime.loop.interrupt");
  registerAdminSurfacePostRoute("/watchdog/runtime/loop/resume", "runtime.loop.resume", {
    mapPayload: (payload) => ({
      ...payload,
      loopId: payload.loopId,
      startStage: payload.startStage,
    }),
  });

  // ── Runtime Operator ───────────────────────────────────────────────────────
  registerPostActionRoute("/watchdog/operator/plan", async (payload) => buildOperatorPlan({
    message: payload.message,
    history: payload.history,
    currentPlan: payload.currentPlan,
    logger,
  }));

  registerPostActionRoute("/watchdog/operator/execute", async (payload) => executeOperatorPlan({
    plan: payload.plan,
    dryRun: payload.dryRun === true,
    logger,
    onAlert: emitAlert,
    runtimeContext: buildAdminSurfaceRuntimeContext("operator.execute"),
  }));

  // ── Agent Graph ─────────────────────────────────────────────────────────────

  // GET /watchdog/graph — full graph with detected cycles
  api.registerHttpRoute({
    path: "/watchdog/graph", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      // graph / loops / loop-sessions / active-session 经 CLI-system inspect surface 读取，
      // 不直读 store（收口旁路）。detectCycles 是纯拓扑算法，留在 route。
      const graph = await inspectCliSystemSurface({ surfaceId: "inspect.agent_graph" });
      const cycles = detectCycles(graph);
      const loops = await inspectCliSystemSurface({ surfaceId: "inspect.graph_loops", params: { graph } });
      const loopSessions = await inspectCliSystemSurface({ surfaceId: "inspect.loop_sessions", params: { loops } });
      const activeLoopSession = await inspectCliSystemSurface({ surfaceId: "inspect.active_loop_session", params: { loops } });
      const nodes = listRuntimeAgentIds().map((id) => {
        const runtimeConfig = getRuntimeAgentConfig(id);
        return {
          id,
          role: runtimeConfig?.role || "agent",
          model: runtimeConfig?.model || null,
        };
      });
      sendJson(res, 200, {
        nodes,
        edges: graph.edges,
        cycles,
        loops,
        loopSessions,
        activeLoopSession,
      });
      return true;
    },
  });

  // GET /watchdog/graph/loops — registered LoopSpec + detected cycles
  api.registerHttpRoute({
    path: "/watchdog/graph/loops", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      // graph / loops / loop-sessions / active-session 经 CLI-system inspect surface 读取（收口旁路）。
      const graph = await inspectCliSystemSurface({ surfaceId: "inspect.agent_graph" });
      const loops = await inspectCliSystemSurface({ surfaceId: "inspect.graph_loops", params: { graph } });
      sendJson(res, 200, {
        loops,
        loopSessions: await inspectCliSystemSurface({ surfaceId: "inspect.loop_sessions", params: { loops } }),
        activeLoopSession: await inspectCliSystemSurface({ surfaceId: "inspect.active_loop_session", params: { loops } }),
        cycles: detectCycles(graph),
      });
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/graph/loop-sessions", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      // graph / loops / active-session / sessions 经 CLI-system inspect surface 读取（收口旁路）。
      const graph = await inspectCliSystemSurface({ surfaceId: "inspect.agent_graph" });
      const loops = await inspectCliSystemSurface({ surfaceId: "inspect.graph_loops", params: { graph } });
      sendJson(res, 200, {
        activeSession: await inspectCliSystemSurface({ surfaceId: "inspect.active_loop_session", params: { loops } }),
        sessions: await inspectCliSystemSurface({ surfaceId: "inspect.loop_sessions", params: { loops } }),
      });
      return true;
    },
  });
}
