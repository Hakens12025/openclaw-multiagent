import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { register } from "../routes/dashboard.js";

function collectRouteMap() {
  const routes = new Map();
  register({
    registerHttpRoute(route) {
      routes.set(route.path, route);
    },
  });
  return routes;
}

test("dashboard route registry serves every checked-in frontend module", async () => {
  const routes = collectRouteMap();
  const dashboardDir = join(import.meta.dirname, "..");
  const resourceFiles = (await readdir(dashboardDir))
    .filter((name) => (
      (/^dashboard.*\.(?:js|css)$/u.test(name) || name === "protocol-registry.js")
      && !name.endsWith(".test.js")
    ))
    .sort();

  assert.ok(resourceFiles.length > 0, "expected dashboard frontend resources");
  for (const filename of resourceFiles) {
    const routePath = `/watchdog/${filename}`;
    assert.equal(routes.has(routePath), true, `${routePath} should be served by dashboard routes`);
  }
});

test("dashboard HTML and frontend resource routes disable browser caching", async () => {
  const routes = collectRouteMap();

  for (const path of [
    "/watchdog/progress",
    "/watchdog/work-items-view",
    "/watchdog/dashboard-init.js",
    "/watchdog/dashboard.css",
  ]) {
    let statusCode = null;
    let headers = null;
    let body = "";
    const route = routes.get(path);
    assert.ok(route, `${path} route should be registered`);

    const handled = await route.handler(
      { url: path },
      {
        writeHead(status, nextHeaders) {
          statusCode = status;
          headers = nextHeaders;
        },
        end(chunk = "") {
          body = String(chunk || "");
        },
      },
    );

    assert.equal(handled, true);
    assert.equal(statusCode, 200);
    assert.ok(body.length > 0, `${path} should return a payload`);
    assert.equal(
      headers?.["Cache-Control"],
      "no-store, must-revalidate",
      `${path} should disable browser caching`,
    );
  }
});

test("work-items view serves the checked-in work item page shell", async () => {
  const routes = collectRouteMap();
  const route = routes.get("/watchdog/work-items-view");
  assert.ok(route, "/watchdog/work-items-view route should be registered");

  let statusCode = null;
  let headers = null;
  let body = "";
  const handled = await route.handler(
    { url: "/watchdog/work-items-view" },
    {
      writeHead(status, nextHeaders) {
        statusCode = status;
        headers = nextHeaders;
      },
      end(chunk = "") {
        body = String(chunk || "");
      },
    },
  );

  assert.equal(handled, true);
  assert.equal(statusCode, 200);
  assert.equal(headers?.["Content-Type"], "text/html; charset=utf-8");
  assert.match(body, /data-watchdog-page="work-items"/u);
  assert.match(body, /\/watchdog\/dashboard-work-items\.js/u);
});

test("dashboard HTML versions frontend resources so browser module graphs refresh", async () => {
  const routes = collectRouteMap();
  const route = routes.get("/watchdog/progress");
  assert.ok(route, "/watchdog/progress route should be registered");

  let body = "";
  const handled = await route.handler(
    { url: "/watchdog/progress" },
    {
      writeHead() {},
      end(chunk = "") {
        body = String(chunk || "");
      },
    },
  );

  assert.equal(handled, true);
  assert.match(body, /data-dashboard-build="[^"]+"/u);
  assert.match(body, /\/watchdog\/dashboard-init\.js\?v=[^"]+"/u);
  assert.match(body, /\/watchdog\/dashboard-graph\.css\?v=[^"]+"/u);
  assert.match(body, /\/watchdog\/dashboard-surface-display\.js\?v=[^"]+"/u);
  assert.doesNotMatch(body, /src="\/watchdog\/dashboard-init\.js"/u);
  assert.doesNotMatch(body, /href="\/watchdog\/dashboard-graph\.css"/u);
});

test("dashboard JS routes version relative frontend module imports", async () => {
  const routes = collectRouteMap();
  const route = routes.get("/watchdog/dashboard-init.js");
  assert.ok(route, "/watchdog/dashboard-init.js route should be registered");

  let body = "";
  const handled = await route.handler(
    { url: "/watchdog/dashboard-init.js" },
    {
      writeHead() {},
      end(chunk = "") {
        body = String(chunk || "");
      },
    },
  );

  assert.equal(handled, true);
  assert.match(body, /from '\.\/dashboard-bus\.js\?v=[^']+'/u);
  assert.match(body, /from '\.\/dashboard\.js\?v=[^']+'/u);
  assert.doesNotMatch(body, /from '\.\/dashboard-bus\.js'/u);
});
