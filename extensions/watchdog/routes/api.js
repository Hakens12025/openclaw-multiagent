// routes/api.js — runtime, tests, agents, reset

import {
  cfg,
} from "../lib/state.js";
import { broadcast, getSseClientCount } from "../lib/transport/sse.js";
import { bootLedger } from "../lib/core/boot-ledger.js";
import { EVENT_TYPE } from "../lib/core/event-types.js";
import { detectCycles } from "../lib/agent/agent-graph.js";
import { getRuntimeAgentConfig, listRuntimeAgentIds } from "../lib/agent/agent-identity.js";
import { getCliSystemSurface, inspectCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";
import { executeAdminSurfaceOperation } from "../lib/admin/operations/admin-surface-operations.js";
import {
  buildOperatorPlan,
  executeOperatorPlan,
} from "../lib/operator/operator-runtime.js";
import {
  buildVizMasterPlan,
  executeVizMasterPlan,
  verifyVizMasterPlan,
} from "../lib/viz/viz-master-runtime.js";
import { writeLocalAgentGuidanceContent } from "../lib/agent/agent-enrollment-guidance.js";
import { syncAllRuntimeWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";
import { register as registerAdminChangeSetRoutes } from "./admin-change-sets.js";
import { register as registerControlPlaneRoutes } from "./control-plane.js";
import { register as registerOperatorCatalogRoutes } from "./operator-catalog.js";
import { register as registerTestRunsRoutes } from "./test-runs.js";
import { terminalizeContractForTestRunner } from "../lib/formal-runtime/test-runner-terminalize.js";
import { revealFileInFinder } from "../lib/agent/agent-reveal-file.js";

export function register(api, logger, deps) {
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
        if (result.ok === false) {
          // 平台不支持 reveal（非 darwin/linux/win32）→ 501 优雅降级，不当异常
          sendJson(res, 501, { ok: false, error: result.reason });
          return true;
        }
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
      // trackingSessions 保留:formal-runtime 判定面在读(health-gateway E-GW-005 形状断言 +
      // suite-concurrent 并发探针 + infra 采样),是 live 内存态,树账替代不了轮询窗口。
      const state = {
        trackingSessions: runtimeState.trackingSessions,
        sseClientCount: getSseClientCount(),
        bootDeps: bootLedger.summary(), // RX-02:网关进程真实封账态,health gateway 层消费

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
  registerAdminSurfacePostRoute("/watchdog/graph/group/compose", "graph.group.compose", {
    mapPayload: (payload) => ({
      ...payload,
      agents: payload.agents ?? payload.agentsText ?? payload.members,
    }),
  });
  registerAdminSurfacePostRoute("/watchdog/skills/create", "skills.create");
  registerAdminSurfacePostRoute("/watchdog/schedules/create", "schedules.create");
  registerAdminSurfacePostRoute("/watchdog/schedules/update", "schedules.update");
  registerAdminSurfacePostRoute("/watchdog/schedules/enable", "schedules.enable");
  registerAdminSurfacePostRoute("/watchdog/schedules/disable", "schedules.disable");
  registerAdminSurfacePostRoute("/watchdog/schedules/delete", "schedules.delete", {
    requireExplicitConfirm: true,
  });
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

  // ── Knowledge bases ─────────────────────────────────────────────────────────
  registerAdminSurfacePostRoute("/watchdog/knowledge/add", "apply.knowledge_add");
  registerAdminSurfacePostRoute("/watchdog/knowledge/reindex", "apply.knowledge_reindex");
  registerAdminSurfacePostRoute("/watchdog/knowledge/remove", "apply.knowledge_remove", {
    requireExplicitConfirm: true,
  });
  registerAdminSurfacePostRoute("/watchdog/knowledge/configure", "apply.knowledge_configure");
  registerAdminSurfacePostRoute("/watchdog/knowledge/eval-set/save", "apply.knowledge_eval_set_save");
  registerAdminSurfacePostRoute("/watchdog/knowledge/eval-set/remove", "apply.knowledge_eval_set_remove");
  registerAdminSurfacePostRoute("/watchdog/knowledge/eval-run", "apply.knowledge_eval_run");
  registerAdminSurfacePostRoute("/watchdog/knowledge/eval-faithfulness", "apply.knowledge_eval_faithfulness");

  // ── Charts (非真值控制面,viz-master 拥有 chart 面) ─────────────────────────
  registerAdminSurfacePostRoute("/watchdog/charts/create", "apply.chart_create");
  registerAdminSurfacePostRoute("/watchdog/charts/move", "apply.chart_move");
  registerAdminSurfacePostRoute("/watchdog/charts/delete", "apply.chart_delete", {
    requireExplicitConfirm: true,
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
    // C2 — only the human-approved execute carries explicitConfirm; absent ⇒ destructive steps refused.
    explicitConfirm: payload.explicitConfirm === true,
    logger,
    onAlert: emitAlert,
    runtimeContext: buildAdminSurfaceRuntimeContext("operator.execute"),
  }));

  // ── Runtime Viz-Master (chart-only meta-agent，镜像 operator plan/execute) ──
  registerPostActionRoute("/watchdog/viz/plan", async (payload) => buildVizMasterPlan({
    message: payload.message,
    history: payload.history,
    currentPlan: payload.currentPlan,
    logger,
  }));

  registerPostActionRoute("/watchdog/viz/execute", async (payload) => executeVizMasterPlan({
    plan: payload.plan,
    dryRun: payload.dryRun === true,
    explicitConfirm: payload.explicitConfirm === true,
    logger,
    onAlert: emitAlert,
    runtimeContext: buildAdminSurfaceRuntimeContext("viz-master.execute"),
  }));

  // 防伪对照 accept stage: read+LLM only (3 synthetic controls through the same plan channel,
  // code-judged) — ZERO writes, controls are never persisted.
  registerPostActionRoute("/watchdog/viz/verify", async (payload) => verifyVizMasterPlan({
    plan: payload.plan,
    logger,
  }));

  // ── Agent Graph ─────────────────────────────────────────────────────────────

  // GET /watchdog/graph — full graph with detected cycles
  api.registerHttpRoute({
    path: "/watchdog/graph", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      // graph 经 CLI-system inspect surface 读取，不直读 store（收口旁路）。
      // detectCycles 是纯拓扑算法，留在 route —— cycles 是前端识环的唯一真值来源。
      const graph = await inspectCliSystemSurface({ surfaceId: "inspect.agent_graph" });
      const cycles = detectCycles(graph);
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
      });
      return true;
    },
  });
}
