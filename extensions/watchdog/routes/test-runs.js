import { getTestRunDetails } from "../lib/test-runs.js";
import { executeAdminSurfaceOperation } from "../lib/admin/admin-surface-operations.js";
import { inspectCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";

export function register(api, logger, deps = {}) {
  const { checkAuth } = deps;

  api.registerHttpRoute({
    path: "/watchdog/test-runs",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      const payload = await inspectCliSystemSurface({ surfaceId: "inspect.test_runs" });
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
        const result = await executeAdminSurfaceOperation({
          surfaceId: "test_runs.start",
          payload,
          logger,
          runtimeContext: {
            api,
            enqueue: deps.enqueueFn,
            wakePlanner: deps.wakePlanner,
            originDraftId: payload.originDraftId || null,
            originExecutionId: payload.originExecutionId || null,
            originSurfaceId: payload.originSurfaceId || null,
          },
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
}
