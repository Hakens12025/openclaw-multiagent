import test from "node:test";
import assert from "node:assert/strict";
import { parseHash } from "../ui/core/router.js";
import { register } from "../routes/dashboard.js";

test("router.parseHash: 四种形态", () => {
  assert.deepEqual(parseHash("#/"), { zone: "command", params: {} });
  assert.deepEqual(parseHash("#/inspect"), { zone: "inspect", params: {} });
  assert.deepEqual(parseHash("#/inspect?run=r-1"), { zone: "inspect", params: { run: "r-1" } });
  assert.deepEqual(parseHash("#/manage/agents"), { zone: "manage", params: { sub: "agents" } });
  assert.deepEqual(parseHash(""), { zone: "command", params: {} });
});

function collectRoutes() {
  const routes = new Map();
  register({ registerHttpRoute(route) { routes.set(route.path, route); } });
  return routes;
}

function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk = "") { this.body = String(chunk || ""); },
  };
}

test("route: /watchdog/next 直发壳 HTML", async () => {
  const route = collectRoutes().get("/watchdog/next");
  assert.ok(route, "/watchdog/next 应注册");
  const res = mockRes();
  const handled = await route.handler({ url: "/watchdog/next" }, res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["Content-Type"], /text\/html/);
  assert.match(res.body, /id="app"/);
});

test("route: /watchdog/ui/* 静态直发 + 路径穿越拒绝", async () => {
  const route = collectRoutes().get("/watchdog/ui/");
  assert.ok(route, "/watchdog/ui/ 前缀路由应注册");
  assert.equal(route.match, "prefix");

  const okRes = mockRes();
  await route.handler({ url: "/watchdog/ui/core/store.js" }, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.match(okRes.headers["Content-Type"], /javascript/);
  assert.match(okRes.body, /createStore/);

  const evilRes = mockRes();
  await route.handler({ url: "/watchdog/ui/../package.json" }, evilRes);
  assert.equal(evilRes.statusCode, 403);
});

test("route: 批4 转正 — /watchdog/ 直发新 SPA 壳;/watchdog/progress 302 友好跳转", async () => {
  const routes = collectRoutes();
  const shell = routes.get("/watchdog/");
  assert.ok(shell, "/watchdog/ 应注册");
  const res = mockRes();
  await shell.handler({ url: "/watchdog/?token=x" }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["Content-Type"], /text\/html/);
  assert.match(res.body, /id="app"/);

  const legacy = routes.get("/watchdog/progress");
  assert.ok(legacy, "/watchdog/progress 转正后保留 302");
  const res2 = mockRes();
  await legacy.handler({ url: "/watchdog/progress?token=x" }, res2);
  assert.equal(res2.statusCode, 302);
  assert.equal(res2.headers["Location"], "/watchdog/?token=x");
});
