// routes/a2a.js — A2A Protocol Interface (Agent2Agent compatible routes)

import { cfg } from "../lib/state.js";
import {
  readContractCompletionArtifact,
  readContractSnapshotById,
} from "../lib/contracts.js";
import { dispatchAcceptIngressMessage } from "../lib/ingress/dispatch-entry.js";
import { loadCapabilityRegistry } from "../lib/capability/capability-registry.js";
import {
  PENDING_SIGNAL_KINDS,
  registerPendingSignal,
  clearPendingSignal,
} from "../lib/runtime/pending-signal-registry.js";
import { buildGatewayReplyTarget } from "../lib/agent/agent-identity.js";

function resolveA2AIngressKind(source) {
  if (source === "qqbot" || source === "qq") {
    return PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_QQ;
  }
  if (source === "test" || source === "test_inject") {
    return PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_TEST_INJECT;
  }
  return PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_WEBUI;
}

function resolveA2ASignalAgentId(source) {
  const gatewaySource = source === "qqbot" || source === "qq" ? "qq" : "webui";
  return buildGatewayReplyTarget(gatewaySource)?.agentId || null;
}

export function formatA2ATaskSendResponse(result, createdAt = Date.now()) {
  const contractId = typeof result?.contractId === "string" && result.contractId.trim()
    ? result.contractId.trim()
    : null;
  return {
    id: contractId,
    status: result?.ok === false ? "failed" : "submitted",
    createdAt,
    _links: contractId ? { self: `/a2a/tasks/${contractId}` } : {},
  };
}

export function register(api, logger) {

  // GET /a2a/agent.json
  api.registerHttpRoute({
    path: "/a2a/agent.json", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader.replace(/^Bearer\s+/i, "");
      if (cfg.gatewayToken && token !== cfg.gatewayToken) {
        res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Unauthorized" })); return true;
      }
      const { agents, skills } = await loadCapabilityRegistry();
      const systemCard = {
        name: "OpenClaw Multi-Agent System",
        version: "5.0.0",
        description: "Multi-agent collaboration system with task queue, atomic writes, and NASA Punk dashboard",
        url: `http://localhost:${cfg.gatewayPort}`,
        capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
        skills: skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description || "",
        })),
        agents,
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      };
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(systemCard, null, 2));
      return true;
    },
  });

  // POST /a2a/tasks/send — uses unified dispatchAcceptIngressMessage
  api.registerHttpRoute({
    path: "/a2a/tasks/send", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const authHeader = req.headers["authorization"] || "";
      const token = authHeader.replace(/^Bearer\s+/i, "");
      if (cfg.gatewayToken && token !== cfg.gatewayToken) {
        res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Unauthorized" })); return true;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid JSON" })); return true; }

      const message = payload.message || "";
      if (!message || message.length < 2) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "message required (min 2 chars)" })); return true;
      }

      const source = typeof payload.source === "string" ? payload.source : "a2a";
      const ingressKind = resolveA2AIngressKind(source);
      const signalAgentId = resolveA2ASignalAgentId(source);
      const signalRef = `${source}:${signalAgentId || "none"}:${Date.now()}`;
      if (signalAgentId) {
        registerPendingSignal({ agentId: signalAgentId, sourceKind: ingressKind, sourceRef: signalRef });
      }
      let result;
      try {
        result = await dispatchAcceptIngressMessage(message, {
          source,
          replyTo: payload.replyTo,
          ingressDirective: payload,
          api, logger,
        });
      } finally {
        if (signalAgentId) {
          clearPendingSignal({ agentId: signalAgentId, sourceKind: ingressKind, sourceRef: signalRef });
        }
      }

      logger.info(`[a2a] task submitted via A2A: ${result.contractId || "no-contract"}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(formatA2ATaskSendResponse(result)));
      return true;
    },
  });

  // GET /a2a/tasks/:id
  api.registerHttpRoute({
    path: "/a2a/tasks/", auth: "plugin", match: "prefix",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (cfg.gatewayToken && url.searchParams.get("token") !== cfg.gatewayToken) {
        res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Unauthorized" })); return true;
      }
      const pathParts = url.pathname.split("/");
      const taskId = pathParts[pathParts.length - 1];
      if (!taskId || !taskId.startsWith("TC-")) {
        res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid task ID" })); return true;
      }
      const contract = await readContractSnapshotById(taskId);
      if (!contract) {
        res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Task not found" })); return true;
      }

      const STATUS_MAP = { draft: "submitted", pending: "submitted", running: "working", awaiting_input: "input-required", completed: "completed", failed: "failed", abandoned: "failed" };
      let artifact = null;
      if (contract.status === "completed") {
        artifact = await readContractCompletionArtifact(taskId, contract);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: contract.id, status: STATUS_MAP[contract.status] || contract.status,
        task: contract.task, phases: contract.phases,
        createdAt: contract.createdAt, updatedAt: contract.updatedAt || null,
        ...(artifact ? { artifacts: [artifact] } : {}),
      }, null, 2));
      return true;
    },
  });
}
