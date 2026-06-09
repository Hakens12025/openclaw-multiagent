# CLI System Surface Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前散落的 `hook / observe / inspect / apply / verify` 表面正式收进同一套 `CLI system` registry，并让 `operator` 与外部读取入口消费同一份表面真值。

**Architecture:** 保留现有 runtime truth 与 admin surface 执行逻辑不变，只新增一层只读的 `CLI system` surface registry。该 registry 组合两类来源：一类是现有 `admin-surface-registry` 的 inspect/apply/verify 元数据，另一类是当前已存在但未正式入册的 `hook` / `observe` 表面。随后新增一个统一只读路由暴露这张目录，并把 `operator-surface-policy` 与 `operator-snapshot` 切到这份统一目录上，避免继续 admin-only 视角。

**Tech Stack:** Node.js ESM, watchdog routes, operator snapshot/brain, built-in `node:test`.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `extensions/watchdog/lib/cli-system/cli-surface-catalog.js` | Create | 定义 `hook` / `observe` 的正式静态目录项 |
| `extensions/watchdog/lib/cli-system/cli-surface-registry.js` | Create | 组合 `hook / observe / inspect / apply / verify` 成统一 registry / summary / filter API |
| `extensions/watchdog/routes/operator-catalog.js` | Modify | 新增 `GET /watchdog/cli-system/surfaces` 统一目录读取路由 |
| `extensions/watchdog/lib/operator/operator-surface-policy.js` | Modify | 从 unified CLI registry 读取 operator 可执行表面，而不是只读 admin surfaces |
| `extensions/watchdog/lib/operator/operator-snapshot.js` | Modify | 增加 CLI system 摘要，并让 surface summary 来自 unified registry |
| `extensions/watchdog/tests/cli-system-surface-registry.test.js` | Create | 锁死 unified registry 的 family 组合与 operator/filter 行为 |
| `extensions/watchdog/tests/admin-surface-canonical-api.test.js` | Modify | 锁死统一目录路由返回 `hook/observe/apply` 等 family |
| `extensions/watchdog/tests/suite-operator.js` | Modify | 锁死 operator surface policy 与 snapshot 来自 CLI system registry |

---

### Task 1: Freeze the Unified CLI System Contract with Failing Tests

**Files:**
- Create: `extensions/watchdog/tests/cli-system-surface-registry.test.js`
- Modify: `extensions/watchdog/tests/admin-surface-canonical-api.test.js`
- Modify: `extensions/watchdog/tests/suite-operator.js`

- [ ] **Step 1: Add a registry test that expects five CLI surface families in one catalog**

```javascript
import test from "node:test";
import assert from "node:assert/strict";

import {
  getCliSystemSurface,
  listCliSystemSurfaces,
  summarizeCliSystemSurfaces,
} from "../lib/cli-system/cli-surface-registry.js";

test("cli system registry merges hook observe and admin surfaces into one catalog", () => {
  const summary = summarizeCliSystemSurfaces();
  assert.equal(summary.counts.total > 0, true);
  assert.equal(summary.counts.byFamily.hook > 0, true);
  assert.equal(summary.counts.byFamily.observe > 0, true);
  assert.equal(summary.counts.byFamily.inspect > 0, true);
  assert.equal(summary.counts.byFamily.apply > 0, true);
  assert.equal(summary.counts.byFamily.verify > 0, true);
});

test("cli system registry resolves canonical hook and observe entries", () => {
  assert.equal(getCliSystemSurface("hook.before_tool_call")?.family, "hook");
  assert.equal(getCliSystemSurface("observe.track_progress")?.family, "observe");
});

test("cli system registry filters operator executable apply surfaces only", () => {
  const surfaces = listCliSystemSurfaces({
    family: "apply",
    operatorExecutable: true,
  });
  assert.equal(surfaces.some((surface) => surface.id === "agents.policy"), true);
  assert.equal(surfaces.some((surface) => surface.id === "runtime.reset"), false);
});
```

- [ ] **Step 2: Add a route test for the new canonical CLI system catalog**

```javascript
test("cli-system surfaces route returns unified surface families", async () => {
  const routes = buildRegisteredRoutes();
  const handler = routes.get("/watchdog/cli-system/surfaces");
  assert.equal(typeof handler, "function");

  const req = buildGetRequest("/watchdog/cli-system/surfaces");
  const res = buildResponse();

  await handler(req, res);
  const response = res.snapshot();

  assert.equal(response.status, 200);
  assert.equal(response.json?.counts?.byFamily?.hook > 0, true);
  assert.equal(response.json?.counts?.byFamily?.observe > 0, true);
  assert.equal(Array.isArray(response.json?.surfaces), true);
});
```

- [ ] **Step 3: Add operator regression checks that expect CLI registry ownership**

```javascript
if (testCase.id === "operator-surface-policy-from-catalog") {
  const surfaceIds = listOperatorExecutableSurfaceIds();
  assert(surfaceIds.includes("agents.policy"), "agents.policy should come from CLI registry");
  assert(surfaceIds.includes("graph.edge.add"), "graph.edge.add should come from CLI registry");
  assert(surfaceIds.includes("runtime.reset") === false, "runtime.reset should remain non-operator-executable");
}

if (testCase.id === "operator-snapshot-actions-aligned") {
  const snapshot = await buildOperatorSnapshot({ listLimit: 12 });
  assert(snapshot.cliSystem?.counts?.byFamily?.hook > 0, "snapshot should expose CLI hook summary");
  assert(snapshot.cliSystem?.counts?.byFamily?.observe > 0, "snapshot should expose CLI observe summary");
}
```

- [ ] **Step 4: Run tests to verify RED**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/cli-system-surface-registry.test.js tests/admin-surface-canonical-api.test.js tests/suite-operator.js
```

Expected:
- FAIL because the unified CLI system registry module does not exist yet
- FAIL because `/watchdog/cli-system/surfaces` route does not exist
- FAIL because operator snapshot/policy still read admin-only metadata

---

### Task 2: Implement the Unified CLI System Registry

**Files:**
- Create: `extensions/watchdog/lib/cli-system/cli-surface-catalog.js`
- Create: `extensions/watchdog/lib/cli-system/cli-surface-registry.js`

- [ ] **Step 1: Define static hook/observe catalog entries**

```javascript
export const CLI_SYSTEM_STATIC_SURFACES = Object.freeze([
  {
    id: "hook.before_tool_call",
    family: "hook",
    risk: "runtime_gate",
    method: "HOOK",
    path: "before_tool_call",
    status: "active",
    summary: "工具调用前的正式拦截点，用于角色限制、loop hard stop 与 harness guard。",
  },
  {
    id: "hook.after_tool_call",
    family: "hook",
    risk: "observe",
    method: "HOOK",
    path: "after_tool_call",
    status: "active",
    summary: "工具调用后的正式观察点，用于 trace、timeline、progress 与 protocol commit observe。",
  },
  {
    id: "observe.track_progress",
    family: "observe",
    risk: "read",
    method: "SSE",
    path: "track_progress",
    status: "active",
    summary: "追踪 session 级运行进度、activity cursor 与 tool timeline。",
  },
]);
```

- [ ] **Step 2: Compose static surfaces with admin surfaces**

```javascript
import { listAdminSurfaces } from "../admin/admin-surface-registry.js";
import { CLI_SYSTEM_STATIC_SURFACES } from "./cli-surface-catalog.js";

function decorateAdminSurface(surface) {
  return {
    ...surface,
    family: surface.stage,
    source: "admin_surface",
  };
}

export function listCliSystemSurfaces(filters = {}, options = {}) {
  const adminSurfaces = listAdminSurfaces({}, options).map(decorateAdminSurface);
  const allSurfaces = [...CLI_SYSTEM_STATIC_SURFACES, ...adminSurfaces];
  return allSurfaces.filter((surface) => /* family/id/operatorExecutable filters */ true);
}
```

- [ ] **Step 3: Add summary helpers**

```javascript
export function summarizeCliSystemSurfaces(filters = {}, options = {}) {
  const surfaces = listCliSystemSurfaces(filters, options);
  const counts = {
    total: surfaces.length,
    byFamily: {
      hook: surfaces.filter((surface) => surface.family === "hook").length,
      observe: surfaces.filter((surface) => surface.family === "observe").length,
      inspect: surfaces.filter((surface) => surface.family === "inspect").length,
      apply: surfaces.filter((surface) => surface.family === "apply").length,
      verify: surfaces.filter((surface) => surface.family === "verify").length,
    },
  };
  return { counts, surfaces };
}
```

- [ ] **Step 4: Run targeted tests to verify GREEN**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/cli-system-surface-registry.test.js
```

Expected:
- PASS

---

### Task 3: Expose the Catalog and Repoint Operator Consumption

**Files:**
- Modify: `extensions/watchdog/routes/operator-catalog.js`
- Modify: `extensions/watchdog/lib/operator/operator-surface-policy.js`
- Modify: `extensions/watchdog/lib/operator/operator-snapshot.js`
- Modify: `extensions/watchdog/tests/admin-surface-canonical-api.test.js`
- Modify: `extensions/watchdog/tests/suite-operator.js`

- [ ] **Step 1: Add the canonical unified route**

```javascript
api.registerHttpRoute({
  path: "/watchdog/cli-system/surfaces",
  auth: "plugin",
  match: "exact",
  handler: async (req, res) => {
    if (!checkAuth(req, res)) return true;
    const url = new URL(req.url, "http://localhost");
    const payload = summarizeCliSystemSurfaces({
      id: url.searchParams.get("id"),
      family: url.searchParams.get("family"),
      status: url.searchParams.get("status"),
      operatorExecutable: url.searchParams.has("operatorExecutable")
        ? url.searchParams.get("operatorExecutable") === "true"
        : undefined,
    }, {
      includeTemplates: url.searchParams.get("includeTemplates"),
    });
    sendJson(res, 200, { generatedAt: Date.now(), ...payload });
    return true;
  },
});
```

- [ ] **Step 2: Make operator policy read from CLI registry**

```javascript
import { getCliSystemSurface, listCliSystemSurfaces } from "../cli-system/cli-surface-registry.js";

export function listOperatorExecutableSurfaceIds() {
  return listCliSystemSurfaces({
    family: "apply",
    status: "active",
    operatorExecutable: true,
  }).map((surface) => surface.id);
}
```

- [ ] **Step 3: Add unified CLI summary into operator snapshot**

```javascript
const cliSurfaceSummary = summarizeCliSystemSurfaces();

return {
  ...snapshot,
  cliSystem: {
    counts: cliSurfaceSummary.counts,
    surfaces: cliSurfaceSummary.surfaces.slice(0, limit).map(summarizeSurface),
    links: {
      catalog: "/watchdog/cli-system/surfaces",
      operatorSnapshot: "/watchdog/operator-snapshot",
    },
  },
};
```

- [ ] **Step 4: Run verification**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/cli-system-surface-registry.test.js tests/admin-surface-canonical-api.test.js tests/suite-operator.js
```

Expected:
- PASS

- [ ] **Step 5: Run the broader operator/admin regression slice**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/formal-test-surface.test.js tests/admin-surface-canonical-api.test.js tests/suite-operator.js
```

Expected:
- PASS
