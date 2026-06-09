// routes/dashboard.js — Dashboard HTML/CSS/JS serving + SSE stream

import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OC, cfg } from "../lib/state.js";
import { addSseClient, buildProgressPayload, removeSseClient } from "../lib/transport/sse.js";
import { inspectCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";

const DASHBOARD_DIR = join(import.meta.dirname || join(OC, "extensions", "watchdog", "routes"), "..");
const DASHBOARD_NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "no-store, must-revalidate",
});
const DASHBOARD_BUILD_ID = String(Date.now());

function isDashboardFrontendResource(filename) {
  return (/^dashboard.*\.(?:js|css)$/u.test(filename) || filename === "protocol-registry.js")
    && !filename.endsWith(".test.js");
}

function getDashboardResourceContentType(filename) {
  if (filename.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filename.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function getDashboardResourceVersion(filename) {
  try {
    const stat = statSync(join(DASHBOARD_DIR, filename));
    return `${stat.mtimeMs.toFixed(0)}-${stat.size}`;
  } catch {
    return DASHBOARD_BUILD_ID;
  }
}

function appendDashboardResourceVersion(pathname) {
  const filename = String(pathname || "").replace(/^\/watchdog\//u, "");
  if (!isDashboardFrontendResource(filename)) return pathname;
  return `${pathname}?v=${encodeURIComponent(getDashboardResourceVersion(filename))}`;
}

function versionDashboardHtml(html) {
  const buildId = encodeURIComponent(DASHBOARD_BUILD_ID);
  return String(html || "")
    .replaceAll(/(href|src)="(\/watchdog\/(?:dashboard[^"]*\.(?:js|css)|protocol-registry\.js))"/gu, (_match, attr, src) => (
      `${attr}="${appendDashboardResourceVersion(src)}"`
    ))
    .replace(/<body(\s[^>]*)?>/u, (match, attrs = "") => {
      if (/\bdata-dashboard-build=/u.test(attrs)) return match;
      return `<body${attrs} data-dashboard-build="${buildId}">`;
    });
}

function versionDashboardModuleImports(content) {
  return String(content || "").replaceAll(
    /(from\s+["']\.\/)(dashboard[^"']*\.js|protocol-registry\.js)(["'])/gu,
    (match, prefix, filename, suffix) => {
      if (!isDashboardFrontendResource(filename)) return match;
      return `${prefix}${filename}?v=${encodeURIComponent(getDashboardResourceVersion(filename))}${suffix}`;
    },
  );
}

function versionDashboardResource(filename, content) {
  if (filename.endsWith(".js")) return versionDashboardModuleImports(content);
  return content;
}

async function getDashboardFile(filename) {
  try { return await readFile(join(DASHBOARD_DIR, filename), "utf8"); }
  catch { return null; }
}

function listDashboardFrontendResources() {
  try {
    return readdirSync(DASHBOARD_DIR)
      .filter(isDashboardFrontendResource)
      .sort();
  } catch {
    return [];
  }
}

function registerDashboardResourceRoute(api, filename) {
  api.registerHttpRoute({
    path: `/watchdog/${filename}`, auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const content = await getDashboardFile(filename);
      if (!content) { res.writeHead(404); res.end("Not Found"); return true; }
      res.writeHead(200, {
        "Content-Type": getDashboardResourceContentType(filename),
        ...DASHBOARD_NO_STORE_HEADERS,
      });
      res.end(versionDashboardResource(filename, content));
      return true;
    },
  });
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
      // tracking / history 初始快照经 CLI-system inspect surface 读取，不直读 store（收口观测读旁路）。
      // buildProgressPayload + SSE 推流逻辑（transport）原样保留。
      for (const trackingState of await inspectCliSystemSurface({ surfaceId: "inspect.tracking_states" })) {
        const payload = buildProgressPayload(trackingState);
        if (payload.mainViewVisible === false) continue;
        res.write(`event: track_start\ndata: ${JSON.stringify(payload)}\n\n`);
      }
      for (const h of await inspectCliSystemSurface({ surfaceId: "inspect.recent_task_history", params: { limit: 10 } })) {
        if (h?.mainViewVisible === false) continue;
        res.write(`event: track_end\ndata: ${JSON.stringify(h)}\n\n`);
      }
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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...DASHBOARD_NO_STORE_HEADERS }); res.end(versionDashboardHtml(html)); return true;
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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...DASHBOARD_NO_STORE_HEADERS }); res.end(html); return true;
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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...DASHBOARD_NO_STORE_HEADERS }); res.end(html); return true;
    },
  });

  for (const resourceFile of listDashboardFrontendResources()) {
    registerDashboardResourceRoute(api, resourceFile);
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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...DASHBOARD_NO_STORE_HEADERS }); res.end(html); return true;
    },
  });

  // Workflow page (workflow-view to avoid conflict with future /watchdog/workflow* APIs)
  api.registerHttpRoute({
    path: "/watchdog/workflow-view", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
        res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return true;
      }
      const html = await getDashboardFile("workflow.html");
      if (!html) { res.writeHead(404); res.end("Not Found"); return true; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...DASHBOARD_NO_STORE_HEADERS }); res.end(versionDashboardHtml(html)); return true;
    },
  });

  // Knowledge page (knowledge-view to avoid conflict with /watchdog/knowledge/* apply routes)
  api.registerHttpRoute({
    path: "/watchdog/knowledge-view", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
        res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return true;
      }
      const html = await getDashboardFile("knowledge.html");
      if (!html) { res.writeHead(404); res.end("Not Found"); return true; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...DASHBOARD_NO_STORE_HEADERS }); res.end(versionDashboardHtml(html)); return true;
    },
  });

  // Charts page (charts-view to avoid conflict with /watchdog/charts/* apply routes)
  api.registerHttpRoute({
    path: "/watchdog/charts-view", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
        res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return true;
      }
      const html = await getDashboardFile("charts.html");
      if (!html) { res.writeHead(404); res.end("Not Found"); return true; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...DASHBOARD_NO_STORE_HEADERS }); res.end(versionDashboardHtml(html)); return true;
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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...DASHBOARD_NO_STORE_HEADERS }); res.end(html); return true;
    },
  });

  // ⑤ Operator control plane page (control-plane-view to avoid conflict with /watchdog/control-plane/* API)
  api.registerHttpRoute({
    path: "/watchdog/control-plane-view", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
        res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return true;
      }
      const html = await getDashboardFile("control-plane.html");
      if (!html) { res.writeHead(404); res.end("Not Found"); return true; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...DASHBOARD_NO_STORE_HEADERS }); res.end(html); return true;
    },
  });

}
