// routes/dashboard.js — 前端壳服务 + SSE stream（批4 转正:2026-08-25）
// 旧 9 页(dashboard/ MPA + 版本字符串改写 hack)已随批4 整删;新 SPA(ui/)转正:
//   /watchdog/      新 SPA 壳(原 /watchdog/next 同物,token 鉴权)
//   /watchdog/next  兼容别名
//   /watchdog/ui/*  静态直发(资源无密,数据面各自验 token)
//   /watchdog/progress → 302 /watchdog/(老书签友好)
// SSE /watchdog/stream 原样保留。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OC, cfg } from "../lib/state.js";
import { addSseClient, buildProgressPayload, removeSseClient } from "../lib/transport/sse.js";
import { inspectCliSystemSurface } from "../lib/cli-system/cli-surface-registry.js";

const ROOT_DIR = join(import.meta.dirname || join(OC, "extensions", "watchdog", "routes"), "..");
const UI_DIR = join(ROOT_DIR, "ui");
const NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "no-store, must-revalidate",
});

function getUiResourceContentType(filename) {
  if (filename.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filename.endsWith(".css")) return "text/css; charset=utf-8";
  if (filename.endsWith(".html")) return "text/html; charset=utf-8";
  return "text/plain; charset=utf-8";
}

export function register(api) {
  const { gatewayToken } = cfg;

  // ── SSE stream ──
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
      // 初始快照经 CLI-system inspect surface 读取，不直读 store（收口观测读旁路）。
      // 活跃 tracker 快照保留（live 态，重启即空是其语义）；buildProgressPayload + SSE 推流
      // 逻辑（transport）原样保留。
      for (const trackingState of await inspectCliSystemSurface({ surfaceId: "inspect.tracking_states" })) {
        const payload = buildProgressPayload(trackingState);
        if (payload.mainViewVisible === false) continue;
        res.write(`event: track_start\ndata: ${JSON.stringify(payload)}\n\n`);
      }
      // 历史回放读记录面(records DB,重启不失忆):最近 10 线程各取最新 run 的事件尾部
      // 20 条,信封 event: run_event + data.replay=true。读失败只损回放,连接与 live 照常。
      try {
        const threadsSnapshot = await inspectCliSystemSurface({ surfaceId: "inspect.threads", params: { limit: 10 } });
        for (const thread of threadsSnapshot?.threads || []) {
          if (!thread?.threadId || !thread?.latestRunId) continue;
          const runEvents = await inspectCliSystemSurface({
            surfaceId: "inspect.run_events",
            params: { threadId: thread.threadId, runId: thread.latestRunId, limit: 20 },
          });
          for (const event of runEvents?.events || []) {
            res.write(`event: run_event\ndata: ${JSON.stringify({ replay: true, ...event })}\n\n`);
          }
        }
      } catch { /* 空树/首启时回放为空是合法态 */ }
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

  // ── 新 SPA 转正:/watchdog/ 即壳(原 /watchdog/next 同物) ──
  const serveShell = async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (gatewayToken && url.searchParams.get("token") !== gatewayToken) {
      res.writeHead(401, { "Content-Type": "text/plain" }); res.end("Unauthorized"); return true;
    }
    const html = await readFile(join(UI_DIR, "index.html"), "utf8").catch(() => null);
    if (!html) { res.writeHead(404); res.end("Not Found"); return true; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_STORE_HEADERS });
    res.end(html);
    return true;
  };
  api.registerHttpRoute({ path: "/watchdog/", auth: "plugin", match: "exact", handler: serveShell });
  api.registerHttpRoute({ path: "/watchdog/next", auth: "plugin", match: "exact", handler: serveShell });

  // 老书签友好:旧主页 → 新壳
  api.registerHttpRoute({
    path: "/watchdog/progress", auth: "plugin", match: "exact",
    handler: async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token");
      const target = token ? `/watchdog/?token=${encodeURIComponent(token)}` : "/watchdog/";
      res.writeHead(302, { Location: target });
      res.end();
      return true;
    },
  });

  // ── SPA 静态直发 ──
  // 静态资源不做 token 校验(与老页惯例一致):壳 HTML 引用资源不带 token,浏览器
  // 子资源请求天然无 query;资源本身是无密静态文件(仓库即公开源码)。敏感数据
  // 只经 JSON/SSE 端点,那些路由各自验 token。路径穿越防线保留。
  api.registerHttpRoute({
    path: "/watchdog/ui/", auth: "plugin", match: "prefix",
    handler: async (req, res) => {
      // 用原始 req.url 取相对段：new URL 会规范化掉 ..，穿越判定必须在解码后的原文上做。
      const rawPath = String(req.url || "").split("?")[0];
      let rel;
      try { rel = decodeURIComponent(rawPath.slice("/watchdog/ui/".length)); }
      catch { res.writeHead(400); res.end("Bad Request"); return true; }
      if (!rel || rel.includes("..") || rel.startsWith("/")) {
        res.writeHead(403, { "Content-Type": "text/plain" }); res.end("Forbidden"); return true;
      }
      const content = await readFile(join(UI_DIR, rel), "utf8").catch(() => null);
      if (content == null) { res.writeHead(404); res.end("Not Found"); return true; }
      res.writeHead(200, {
        "Content-Type": getUiResourceContentType(rel),
        ...NO_STORE_HEADERS,
      });
      res.end(content);
      return true;
    },
  });
}
