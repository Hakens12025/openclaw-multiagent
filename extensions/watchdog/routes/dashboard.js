// routes/dashboard.js — Dashboard HTML/CSS/JS serving + SSE stream

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OC, cfg } from "../lib/state.js";
import { addSseClient, buildProgressPayload, removeSseClient } from "../lib/transport/sse.js";
import { listTrackingStates } from "../lib/store/tracker-store.js";
import { getRecentTaskHistory } from "../lib/store/task-history-store.js";

const DASHBOARD_DIR = join(import.meta.dirname || join(OC, "extensions", "watchdog", "routes"), "..");

async function getDashboardFile(filename) {
  try { return await readFile(join(DASHBOARD_DIR, filename), "utf8"); }
  catch { return null; }
}

export function register(api) {
  const { gatewayToken } = cfg;

  // SSE stream
  api.registerHttpRoute({
    path: "/watchdog/stream", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
        res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return true;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "http://localhost:18789",
      });
      for (const trackingState of listTrackingStates()) {
        res.write(`event: track_start\ndata: ${JSON.stringify(buildProgressPayload(trackingState))}\n\n`);
      }
      for (const h of getRecentTaskHistory(10)) res.write(`event: track_end\ndata: ${JSON.stringify(h)}\n\n`);
      res.write(`event: connected\ndata: {}\n\n`);
      addSseClient(res);
      const hb = setInterval(() => {
        try { res.write("event: heartbeat\ndata: {}\n\n"); }
        catch { clearInterval(hb); removeSseClient(res); }
      }, 25000);
      req.on("close", () => { clearInterval(hb); removeSseClient(res); });
      return true;
    },
  });

  // Dashboard HTML
  api.registerHttpRoute({
    path: "/watchdog/progress", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
        res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return true;
      }
      const html = await getDashboardFile("dashboard.html");
      if (!html) { res.writeHead(404); res.end("Not Found"); return true; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); return true;
    },
  });

  // Harness standalone page
  api.registerHttpRoute({
    path: "/watchdog/harness-view", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
        res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return true;
      }
      const html = await getDashboardFile("harness.html");
      if (!html) { res.writeHead(404); res.end("Not Found"); return true; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); return true;
    },
  });

  // Devtools standalone page
  api.registerHttpRoute({
    path: "/watchdog/devtools", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
        res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return true;
      }
      const html = await getDashboardFile("devtools.html");
      if (!html) { res.writeHead(404); res.end("Not Found"); return true; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); return true;
    },
  });

  // Dashboard CSS files
  for (const cssFile of [
    "dashboard.css",
    "dashboard-home.css",
    "dashboard-agents.css",
    "dashboard-harness.css",
    "dashboard-devtools.css",
    "dashboard-subpage.css",
    "dashboard-coming-soon.css",
    "dashboard-operator-ui.css",
    "dashboard-graph.css",
  ]) {
    api.registerHttpRoute({
      path: `/watchdog/${cssFile}`, auth: "plugin", match: "exact",
      handler: async (req, res) => {
        const css = await getDashboardFile(cssFile);
        if (!css) { res.writeHead(404); res.end("Not Found"); return true; }
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }); res.end(css); return true;
      },
    });
  }

  // Agents page (agents-view to avoid conflict with /watchdog/agents API)
  api.registerHttpRoute({
    path: "/watchdog/agents-view", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
        res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return true;
      }
      const html = await getDashboardFile("agents.html");
      if (!html) { res.writeHead(404); res.end("Not Found"); return true; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); return true;
    },
  });

  // Work items page (work-items-view to avoid conflict with /watchdog/work-items API)
  api.registerHttpRoute({
    path: "/watchdog/work-items-view", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
        res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return true;
      }
      const html = await getDashboardFile("work-items.html");
      if (!html) { res.writeHead(404); res.end("Not Found"); return true; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); return true;
    },
  });

  // Dashboard JS files
  for (const jsFile of [
    "dashboard-bus.js",
    "dashboard-i18n.js",
    "dashboard-common.js",
    "dashboard-agents.js",
    "dashboard-nav.js",
    "dashboard-subpage-init.js",
    "dashboard.js",
    "dashboard-svg.js",
    "dashboard-drag.js",
    "dashboard-ux.js",
    "dashboard-pipeline.js",
    "dashboard-init.js",
    "dashboard-devtools.js",
    "dashboard-devtools-test-runs.js",
    "dashboard-devtools-management.js",
    "dashboard-devtools-change-sets.js",
    "dashboard-harness.js",
    "dashboard-harness-shared.js",
    "dashboard-harness-atlas.js",
    "dashboard-harness-placement.js",
    "dashboard-harness-runs.js",
    "dashboard-graph.js",
    "dashboard-operator.js",
  ]) {
    api.registerHttpRoute({
      path: `/watchdog/${jsFile}`, auth: "plugin", match: "exact",
      handler: async (req, res) => {
        const js = await getDashboardFile(jsFile);
        if (!js) { res.writeHead(404); res.end("Not Found"); return true; }
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" }); res.end(js); return true;
      },
    });
  }
}
