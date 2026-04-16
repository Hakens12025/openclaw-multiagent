import { listLifecycleWorkItems } from "../lib/contracts.js";
import { summarizeLocalAgentDiscovery } from "../lib/agent/agent-enrollment-discovery.js";
import {
  readLocalAgentGuidancePreview,
} from "../lib/agent/agent-enrollment-guidance.js";
import { buildOperatorSnapshot } from "../lib/operator/operator-snapshot.js";
import { summarizeCliSystemSurfaces } from "../lib/cli-system/cli-surface-registry.js";
import { summarizeAgentJoinRegistry } from "../lib/agent/agent-join-registry.js";
import { summarizeScheduleRegistry } from "../lib/schedule/schedule-registry.js";
import { summarizeAutomationRuntimeRegistry } from "../lib/automation/automation-runtime.js";
import { summarizeHarnessDashboard } from "../lib/harness/harness-dashboard.js";
import {
  listAgentRegistry,
  listModelRegistry,
  listSkillRegistry,
  loadCapabilityRegistry,
  readAgentDefaultsRegistry,
} from "../lib/capability/capability-registry.js";
import { summarizeAdminSurfaces } from "../lib/admin/admin-surface-registry.js";
import { summarizeSystemActionDeliveryTickets } from "../lib/routing/delivery-system-action-ticket.js";

export function register(api, {
  checkAuth,
  sendJson,
}) {
  api.registerHttpRoute({
    path: "/watchdog/cli-system/surfaces",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        const url = new URL(req.url, "http://localhost");
        const payload = summarizeCliSystemSurfaces({
          id: url.searchParams.get("id"),
          family: url.searchParams.get("family"),
          status: url.searchParams.get("status"),
          source: url.searchParams.get("source"),
          ...(url.searchParams.has("operatorExecutable")
            ? { operatorExecutable: url.searchParams.get("operatorExecutable") === "true" }
            : {}),
        }, {
          includeTemplates: url.searchParams.get("includeTemplates"),
        });
        sendJson(res, 200, {
          generatedAt: Date.now(),
          ...payload,
        });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/operator-snapshot",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("GET only");
        return true;
      }
      try {
        const url = new URL(req.url, "http://localhost");
        const snapshot = await buildOperatorSnapshot({
          listLimit: url.searchParams.get("limit"),
        });
        sendJson(res, 200, snapshot);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/work-items",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        const workItems = await listLifecycleWorkItems();
        sendJson(res, 200, workItems);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/agents/discovery",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        const url = new URL(req.url, "http://localhost");
        const payload = await summarizeLocalAgentDiscovery({
          includeLocalWorkspace: url.searchParams.get("includeLocalWorkspace") === "true",
        });
        sendJson(res, 200, {
          generatedAt: Date.now(),
          ...payload,
        });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/agents/guidance/read",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("GET only");
        return true;
      }
      try {
        const url = new URL(req.url, "http://localhost");
        const payload = await readLocalAgentGuidancePreview({
          agentId: url.searchParams.get("agentId"),
          fileName: url.searchParams.get("file"),
        });
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/agent-joins/registry",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        const url = new URL(req.url, "http://localhost");
        const enabled = url.searchParams.has("enabled")
          ? url.searchParams.get("enabled") === "true"
          : null;
        const payload = await summarizeAgentJoinRegistry({
          enabled,
          status: url.searchParams.get("status"),
          protocolType: url.searchParams.get("protocolType"),
        });
        sendJson(res, 200, {
          generatedAt: Date.now(),
          ...payload,
        });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/system-action-delivery-tickets",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        const url = new URL(req.url, "http://localhost");
        const payload = await summarizeSystemActionDeliveryTickets({
          status: url.searchParams.get("status"),
        });
        sendJson(res, 200, {
          generatedAt: Date.now(),
          ...payload,
        });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/schedules",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        const url = new URL(req.url, "http://localhost");
        const enabled = url.searchParams.has("enabled")
          ? url.searchParams.get("enabled") === "true"
          : null;
        const payload = await summarizeScheduleRegistry({ enabled });
        sendJson(res, 200, {
          generatedAt: Date.now(),
          ...payload,
        });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/automations",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        const url = new URL(req.url, "http://localhost");
        const enabled = url.searchParams.has("enabled")
          ? url.searchParams.get("enabled") === "true"
          : null;
        const status = normalizeAutomationStatusQuery(url.searchParams.get("status"));
        const payload = await summarizeAutomationRuntimeRegistry({ enabled, status });
        sendJson(res, 200, {
          generatedAt: Date.now(),
          ...payload,
        });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/agents",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        const agents = await listAgentRegistry();
        sendJson(res, 200, agents);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/harness",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("GET only");
        return true;
      }
      try {
        const payload = await summarizeHarnessDashboard();
        sendJson(res, 200, payload);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/agents/defaults",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("GET only");
        return true;
      }
      try {
        const defaults = await readAgentDefaultsRegistry();
        sendJson(res, 200, defaults);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/capability-registry",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("GET only");
        return true;
      }
      try {
        const registry = await loadCapabilityRegistry();
        sendJson(res, 200, {
          generatedAt: Date.now(),
          ...registry,
        });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/skills",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        const skills = await listSkillRegistry();
        sendJson(res, 200, skills);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/admin-surfaces",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        const url = new URL(req.url, "http://localhost");
        const payload = summarizeAdminSurfaces({
          id: url.searchParams.get("id"),
          stage: url.searchParams.get("stage"),
          risk: url.searchParams.get("risk"),
          status: url.searchParams.get("status"),
          operatorPhase: url.searchParams.get("operatorPhase"),
        }, {
          includeTemplates: url.searchParams.get("includeTemplates"),
        });
        sendJson(res, 200, {
          generatedAt: Date.now(),
          ...payload,
        });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/models",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        const models = await listModelRegistry();
        sendJson(res, 200, models);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return true;
    },
  });
}

function normalizeAutomationStatusQuery(value) {
  const normalized = typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : null;
  return normalized || null;
}
