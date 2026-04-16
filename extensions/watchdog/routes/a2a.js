// routes/a2a.js — A2A Protocol Interface (Agent2Agent compatible routes)

import { cfg } from "../lib/state.js";
import {
  readContractCompletionArtifact,
  readContractSnapshotById,
} from "../lib/contracts.js";
import { dispatchAcceptIngressMessage } from "../lib/ingress/dispatch-entry.js";
import { loadCapabilityRegistry } from "../lib/capability/capability-registry.js";

export function register(api, logger, { enqueueFn, wakePlanner }) {

  // GET /a2a/agent.json
  api.registerHttpRoute({
    path: "/a2a/agent.json", auth: "plugin", match: "exact",
    handler: async (req, res) => {
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
      if (cfg.hooksToken && token !== cfg.hooksToken) {
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

      const result = await dispatchAcceptIngressMessage(message, {
        source: "a2a",
        replyTo: payload.replyTo,
        ingressDirective: payload,
        api, enqueue: enqueueFn, wakePlanner, logger,
      });

      logger.info(`[a2a] task created via A2A: ${result.contractId || "research"}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: result.contractId || "research",
        status: result.route === "research" ? "researching" : (result.fastTrack ? "pending" : "draft"),
        createdAt: Date.now(),
        _links: result.contractId ? { self: `/a2a/tasks/${result.contractId}` } : {},
      }));
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
        ...(contract.clarification ? { clarification: contract.clarification } : {}),
        ...(artifact ? { artifacts: [artifact] } : {}),
      }, null, 2));
      return true;
    },
  });
}
