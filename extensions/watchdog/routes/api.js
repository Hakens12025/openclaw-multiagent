// routes/api.js — runtime, tests, agents, reset

import {
  cfg,
} from "../lib/state.js";
import { getTaskHistoryCount } from "../lib/store/task-history-store.js";
import {
  getDispatchChainSize,
} from "../lib/store/contract-flow-store.js";
import {
  snapshotTrackingSessions,
} from "../lib/store/tracker-store.js";
import { broadcast, getSseClientCount } from "../lib/transport/sse.js";
import { EVENT_TYPE } from "../lib/core/event-types.js";
import { loadGraph, addEdge, removeEdge, detectCycles } from "../lib/agent/agent-graph.js";
import { getRuntimeAgentConfig, listRuntimeAgentIds } from "../lib/agent/agent-identity.js";
import { listResolvedGraphLoops } from "../lib/loop/graph-loop-registry.js";
import { getActiveResolvedLoopSession, listResolvedLoopSessions } from "../lib/loop/loop-session-store.js";
import { executeAdminSurfaceOperation } from "../lib/admin/admin-surface-operations.js";
import {
  buildOperatorPlan,
  executeOperatorPlan,
} from "../lib/operator-runtime.js";
import { writeLocalAgentGuidanceContent } from "../lib/agent/agent-enrollment-guidance.js";
import { syncAllRuntimeWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";
import { register as registerAdminChangeSetRoutes } from "./admin-change-sets.js";
import { register as registerOperatorCatalogRoutes } from "./operator-catalog.js";
import { buildDispatchRuntimeSnapshot } from "../lib/routing/dispatch-runtime-state.js";

export function register(api, logger, { enqueueFn, wakePlanner }) {
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

  // ── Runtime Summary ────────────────────────────────────────────────────────
  api.registerHttpRoute({
    path: "/watchdog/runtime", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      const dispatchRuntimeSnapshot = buildDispatchRuntimeSnapshot();
      const state = {
        trackingSessions: snapshotTrackingSessions(),
        historyCount: getTaskHistoryCount(),
        sseClientCount: getSseClientCount(),
        dispatchChainSize: getDispatchChainSize(),
        dispatchQueue: {
          contractIds: dispatchRuntimeSnapshot.queue,
        },
        dispatchRuntime: {
          targets: Object.fromEntries(
            Object.entries(dispatchRuntimeSnapshot.targets).map(([id, s]) => [id, {
              busy: s.busy,
              healthy: s.healthy,
              dispatching: s.dispatching,
              currentContractId: s.currentContract,
            }]),
          ),
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
  registerAdminSurfacePostRoute("/watchdog/agents/card/tools", "agents.card.tools", {
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
  registerAdminSurfacePostRoute("/watchdog/agent-joins/enable", "agent_joins.enable", {
    mapPayload: (payload) => ({
      ...payload,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/agent-joins/disable", "agent_joins.disable", {
    mapPayload: (payload) => ({
      ...payload,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/agent-joins/delete", "agent_joins.delete", {
    mapPayload: (payload) => ({
      ...payload,
    }),
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
  registerAdminSurfacePostRoute("/watchdog/graph/loop/repair", "graph.loop.repair", {
    mapPayload: (payload) => ({
      ...payload,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/schedules/create", "schedules.create");
  registerAdminSurfacePostRoute("/watchdog/schedules/update", "schedules.update");
  registerAdminSurfacePostRoute("/watchdog/schedules/enable", "schedules.enable", {
    mapPayload: (payload) => ({
      ...payload,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/schedules/disable", "schedules.disable", {
    mapPayload: (payload) => ({
      ...payload,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/schedules/delete", "schedules.delete", {
    mapPayload: (payload) => ({
      ...payload,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/automations/create", "automations.create");
  registerAdminSurfacePostRoute("/watchdog/automations/update", "automations.update");
  registerAdminSurfacePostRoute("/watchdog/automations/enable", "automations.enable", {
    mapPayload: (payload) => ({
      ...payload,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/automations/disable", "automations.disable", {
    mapPayload: (payload) => ({
      ...payload,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/automations/run", "automations.run", {
    mapPayload: (payload) => ({
      ...payload,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/automations/delete", "automations.delete", {
    mapPayload: (payload) => ({
      ...payload,
    }),
    requireExplicitConfirm: true,
  });

  // ── Delete agent ───────────────────────────────────────────────────────────
  registerAdminSurfacePostRoute("/watchdog/agents/delete", "agents.delete", {
    mapPayload: (payload) => ({
      ...payload,
    }),
    requireExplicitConfirm: true,
  });
  registerAdminSurfacePostRoute("/watchdog/agents/hard-delete", "agents.hard_delete", {
    mapPayload: (payload) => ({
      ...payload,
    }),
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
      const graph = await loadGraph();
      const cycles = detectCycles(graph);
      const loops = await listResolvedGraphLoops({ graph });
      const loopSessions = await listResolvedLoopSessions({ loops });
      const activeLoopSession = await getActiveResolvedLoopSession({ loops });
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

  // POST /watchdog/graph/edge — add or delete edge
  api.registerHttpRoute({
    path: "/watchdog/graph/edge", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (!body.from || !body.to) { sendJson(res, 400, { ok: false, error: "from and to required" }); return true; }
        const graph = await addEdge(body.from, body.to, {
          label: body.label, gates: body.gates, metadata: body.metadata,
        });
        const cycles = detectCycles(graph);
        const loops = await listResolvedGraphLoops({ graph });
        await syncAllRuntimeWorkspaceGuidance(api.config, logger);
        broadcast("alert", { type: EVENT_TYPE.GRAPH_UPDATED, action: "edge_added", from: body.from, to: body.to, loops, cycles, ts: Date.now() });
        sendJson(res, 200, { ok: true, graph, loops, cycles });
      } else if (req.method === "DELETE") {
        const body = await readJsonBody(req);
        if (!body.from || !body.to) { sendJson(res, 400, { ok: false, error: "from and to required" }); return true; }
        const graph = await removeEdge(body.from, body.to);
        const cycles = detectCycles(graph);
        const loops = await listResolvedGraphLoops({ graph });
        await syncAllRuntimeWorkspaceGuidance(api.config, logger);
        broadcast("alert", { type: EVENT_TYPE.GRAPH_UPDATED, action: "edge_removed", from: body.from, to: body.to, loops, cycles, ts: Date.now() });
        sendJson(res, 200, { ok: true, graph, loops, cycles });
      } else {
        res.writeHead(405, { "Content-Type": "text/plain" }); res.end("POST or DELETE");
      }
      return true;
    },
  });

  // GET /watchdog/graph/loops — registered LoopSpec + detected cycles
  api.registerHttpRoute({
    path: "/watchdog/graph/loops", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      const graph = await loadGraph();
      const loops = await listResolvedGraphLoops({ graph });
      sendJson(res, 200, {
        loops,
        loopSessions: await listResolvedLoopSessions({ loops }),
        activeLoopSession: await getActiveResolvedLoopSession({ loops }),
        cycles: detectCycles(graph),
      });
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/graph/loop-sessions", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      const graph = await loadGraph();
      const loops = await listResolvedGraphLoops({ graph });
      sendJson(res, 200, {
        activeSession: await getActiveResolvedLoopSession({ loops }),
        sessions: await listResolvedLoopSessions({ loops }),
      });
      return true;
    },
  });
}
