import {
  attachAdminChangeSetVerification,
  getAdminChangeSetDetails,
  listAdminChangeSets,
  saveAdminChangeSetDraft,
} from "../lib/admin/admin-change-sets.js";
import {
  executeAdminChangeSet,
  previewAdminChangeSetExecution,
} from "../lib/admin/admin-change-set-executor.js";

export function register(api, logger, {
  checkAuth,
  readJsonBody,
  sendJson,
  registerPostActionRoute,
  emitAlert,
  buildRuntimeContext,
}) {
  api.registerHttpRoute({
    path: "/watchdog/admin-change-sets",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        if (req.method === "GET") {
          const drafts = await listAdminChangeSets();
          sendJson(res, 200, {
            generatedAt: Date.now(),
            count: drafts.length,
            drafts,
          });
          return true;
        }
        if (req.method === "POST") {
          const payload = await readJsonBody(req);
          const draft = await saveAdminChangeSetDraft(payload);
          sendJson(res, 200, { ok: true, draft });
          return true;
        }
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("GET or POST only");
      } catch (error) {
        sendJson(res, req.method === "POST" ? 400 : 500, { ok: false, error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/admin-change-sets/detail",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      try {
        const url = new URL(req.url, "http://localhost");
        const id = url.searchParams.get("id");
        const draft = await getAdminChangeSetDetails(id);
        if (!draft) {
          sendJson(res, 404, { ok: false, error: "draft not found" });
          return true;
        }
        sendJson(res, 200, { ok: true, draft });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return true;
    },
  });

  api.registerHttpRoute({
    path: "/watchdog/admin-change-sets/verification",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (!checkAuth(req, res)) return true;
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("POST only");
        return true;
      }
      try {
        const payload = await readJsonBody(req);
        const result = await attachAdminChangeSetVerification(payload);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return true;
    },
  });

  // Active preview endpoint used by dashboard/operator surfaces before execution.
  api.registerHttpRoute({
    path: "/watchdog/admin-change-sets/preview",
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
        const result = await previewAdminChangeSetExecution({
          id: url.searchParams.get("id"),
        });
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message });
      }
      return true;
    },
  });

  registerPostActionRoute("/watchdog/admin-change-sets/execute", async (payload) => {
    return executeAdminChangeSet({
      id: payload.id,
      dryRun: payload.dryRun === true,
      startVerification: payload.startVerification === true,
      explicitConfirm: payload.explicitConfirm === true,
      logger,
      onAlert: emitAlert,
      runtimeContext: buildRuntimeContext(),
    });
  });
}
