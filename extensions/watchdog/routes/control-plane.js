// routes/control-plane.js — ⑤ Operator control plane HTTP surface.
// Exposes the structure-snapshot (rollback foundation) + structure-share-code (portable
// scoped codes) modules over HTTP. Token-auth like admin-change-sets. No new admin surface —
// snapshot/rollback are control-plane composite ops (re-write 4 truths via 4 writers), not a
// single templated surface; share codes are read/transform-only.

import {
  captureStructureSnapshot,
  restoreStructureSnapshot,
  verifyAgainstSnapshot,
  listStructureSnapshots,
  projectStructureAfter,
} from "../lib/control-plane/structure-snapshot.js";
import {
  exportStructureCode,
  decodeStructureCode,
  estimateCodeSize,
  SHARE_LEVELS,
} from "../lib/control-plane/structure-share-code.js";

export function register(api, logger, { checkAuth, readJsonBody, sendJson }) {
  function route(path, methods, run) {
    api.registerHttpRoute({
      path,
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        if (!checkAuth(req, res)) return true;
        if (!methods.includes(req.method)) {
          res.writeHead(405, { "Content-Type": "text/plain" });
          res.end(`${methods.join(" or ")} only`);
          return true;
        }
        try {
          const payload = req.method === "POST" ? (await readJsonBody(req)) || {} : null;
          const url = new URL(req.url, "http://localhost");
          await run({ req, res, payload, query: url.searchParams });
        } catch (error) {
          sendJson(res, req.method === "POST" ? 400 : 500, { ok: false, error: error.message });
        }
        return true;
      },
    });
  }

  // ── Structure snapshots (local rollback foundation) ──
  route("/watchdog/control-plane/snapshot", ["GET", "POST"], async ({ req, res, payload }) => {
    if (req.method === "GET") {
      sendJson(res, 200, { ok: true, snapshots: await listStructureSnapshots() });
      return;
    }
    const snap = await captureStructureSnapshot({
      label: payload.label, reason: payload.reason, sourceDraftId: payload.sourceDraftId,
    });
    logger?.info?.(`[watchdog] control-plane snapshot captured: ${snap.id}`);
    sendJson(res, 200, { ok: true, snapshot: snap });
  });

  route("/watchdog/control-plane/rollback", ["POST"], async ({ res, payload }) => {
    if (!payload.snapshotId) { sendJson(res, 400, { ok: false, error: "snapshotId required" }); return; }
    const result = await restoreStructureSnapshot(payload.snapshotId, { expectHash: payload.expectHash || null });
    logger?.info?.(`[watchdog] control-plane rollback ${payload.snapshotId}: ok=${result.ok}`);
    sendJson(res, result.ok ? 200 : 409, result);
  });

  route("/watchdog/control-plane/verify", ["POST"], async ({ res, payload }) => {
    if (!payload.snapshotId) { sendJson(res, 400, { ok: false, error: "snapshotId required" }); return; }
    sendJson(res, 200, await verifyAgainstSnapshot(payload.snapshotId));
  });

  // ── Proposal preview (reverse use of snapshot: project post-apply structure, non-destructive) ──
  route("/watchdog/control-plane/preview", ["POST"], async ({ res, payload }) => {
    if (!payload.surfaceId) { sendJson(res, 400, { ok: false, error: "surfaceId required" }); return; }
    sendJson(res, 200, { ok: true, preview: await projectStructureAfter({ surfaceId: payload.surfaceId, payload: payload.payload }) });
  });

  // ── Structure share codes (portable, scoped, compressed) ──
  route("/watchdog/control-plane/share/export", ["POST"], async ({ res, payload }) => {
    const level = payload.level || SHARE_LEVELS.STRUCTURE;
    const result = await exportStructureCode({ level });
    sendJson(res, result.ok ? 200 : 422, result); // 422 when secret-scan blocks
  });

  route("/watchdog/control-plane/share/estimate", ["GET"], async ({ res, query }) => {
    sendJson(res, 200, await estimateCodeSize({ level: query.get("level") || SHARE_LEVELS.STRUCTURE }));
  });

  route("/watchdog/control-plane/share/decode", ["POST"], async ({ res, payload }) => {
    if (!payload.code) { sendJson(res, 400, { ok: false, error: "code required" }); return; }
    sendJson(res, 200, decodeStructureCode(payload.code));
  });
}
