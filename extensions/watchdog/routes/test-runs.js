import { cfg } from "../lib/state.js";
import { getTestRunDetails, listTestRuns, startTestRun } from "../lib/test-runs.js";

export function register(api, logger, deps = {}) {
  const { gatewayToken } = cfg;

  function checkAuth(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return false;
    }
    return true;
  }

  api.registerHttpRoute({
    path: "/watchdog/test-runs",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      const payload = listTestRuns();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/test-runs/detail",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      const url = new URL(req.url, "http://localhost");
      const runId = url.searchParams.get("id");
      if (!runId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing id" }));
        return true;
      }
      const detail = getTestRunDetails(runId);
      if (!detail) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "run not found" }));
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(detail));
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/test-runs/start",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("POST only");
        return true;
      }

      let body = "";
      for await (const chunk of req) body += chunk;

      try {
        const payload = body ? JSON.parse(body) : {};
        const run = startTestRun({
          presetId: payload.presetId,
          cleanMode: payload.cleanMode || "session-clean",
          originDraftId: payload.originDraftId || null,
          originExecutionId: payload.originExecutionId || null,
          originSurfaceId: payload.originSurfaceId || null,
          runtimeContext: {
            api,
            enqueue: typeof deps.enqueue === "function" ? deps.enqueue : deps.enqueueFn,
            wakePlanner: deps.wakePlanner,
          },
        }, logger);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, run }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return true;
    },
  });
}
