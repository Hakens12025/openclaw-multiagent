# Work Items Page A+B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前占位的 `工作项` 子页升级为真实可用的只读工作项页面，展示 runtime-owned lifecycle truth，并提供基础筛选与搜索。

**Architecture:** 页面只读取 `GET /watchdog/work-items` 作为唯一正式数据源，不复用主页内存中的 `workItems` 状态，也不直接拼接 tracker/taskHistory 的第二真值。前端实现拆成“纯数据筛选/选择逻辑”与“页面渲染/请求逻辑”两层，前者走 Node 单测，后者复用现有 dashboard subpage 模式并做 live 验证。

**Tech Stack:** 原生 HTML/CSS/ES modules、Node `node:test`、现有 watchdog 路由注册、现有 subpage shell (`dashboard-subpage-init.js`)

---

## File Structure

**Create**
- `extensions/watchdog/dashboard-work-items-state.js`
  - 纯数据层：规范化筛选条件、过滤、搜索、排序、默认选中项决策、摘要统计。
- `extensions/watchdog/dashboard-work-items.js`
  - 页面控制器：请求 `/watchdog/work-items`、绑定筛选 UI、调用 state helpers、渲染列表与详情。
- `extensions/watchdog/dashboard-work-items.css`
  - `工作项` 页专用样式。
- `extensions/watchdog/tests/dashboard-work-items-state.test.js`
  - 针对筛选、搜索、默认选中、摘要统计的单元测试。
- `extensions/watchdog/tests/dashboard-work-items-page.test.js`
  - 最小 DOM 测试，复用 `dashboard-stage-visibility.test.js` 的 mock document 风格，验证页面壳和详情渲染。

**Modify**
- `extensions/watchdog/work-items.html`
  - 从 `coming soon` 占位页改成真实 `work-items-app` 壳，加载新 JS/CSS。
- `extensions/watchdog/routes/dashboard.js`
  - 注册 `dashboard-work-items.js` 与 `dashboard-work-items.css` 静态路由。
- `extensions/watchdog/tests/dashboard-route-modules.test.js`
  - 把 `工作项` 子页新增资源也纳入路由回归。

**Existing runtime truth to reuse**
- `extensions/watchdog/routes/operator-catalog.js`
  - `GET /watchdog/work-items` 已正式暴露 `listLifecycleWorkItems()`。
- `extensions/watchdog/lib/contract-lifecycle-view.js`
  - work item 真值汇聚入口，已经把 contract snapshot / history / tracker 合并后排序返回。
- `extensions/watchdog/dashboard-subpage-init.js`
  - 子页导航、面包屑、时间头部复用。

---

### Task 1: Lock The Truth Source And Resource Contract

**Files:**
- Modify: `extensions/watchdog/tests/dashboard-route-modules.test.js`
- Modify: `extensions/watchdog/routes/dashboard.js`
- Test: `extensions/watchdog/tests/dashboard-route-modules.test.js`

- [ ] **Step 1: Extend the failing route test to require work-items page assets**

Add these assertions to `extensions/watchdog/tests/dashboard-route-modules.test.js`:

```js
for (const requiredPath of [
  "/watchdog/dashboard-work-items.js",
  "/watchdog/dashboard-work-items.css",
]) {
  assert.equal(paths.includes(requiredPath), true, `${requiredPath} should be served by dashboard routes`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-route-modules.test.js
```

Expected:
- FAIL
- Missing `/watchdog/dashboard-work-items.js`
- Missing `/watchdog/dashboard-work-items.css`

- [ ] **Step 3: Register the new work-items assets in `routes/dashboard.js`**

Update the existing CSS/JS asset arrays:

```js
// CSS list
"dashboard-work-items.css",

// JS list
"dashboard-work-items.js",
```

Do not create a new ad-hoc route family. Keep it inside the existing dashboard asset registration loops.

- [ ] **Step 4: Re-run the route test and syntax check**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-route-modules.test.js
node --check /Users/hakens/.openclaw/extensions/watchdog/routes/dashboard.js
```

Expected:
- test PASS
- `node --check` exits 0

- [ ] **Step 5: Commit**

```bash
git add \
  /Users/hakens/.openclaw/extensions/watchdog/routes/dashboard.js \
  /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-route-modules.test.js
git commit -m "test: lock work-items page asset routes"
```

---

### Task 2: Build The Pure State Layer For A+B

**Files:**
- Create: `extensions/watchdog/dashboard-work-items-state.js`
- Create: `extensions/watchdog/tests/dashboard-work-items-state.test.js`
- Test: `extensions/watchdog/tests/dashboard-work-items-state.test.js`

- [ ] **Step 1: Write the failing state tests**

Create `extensions/watchdog/tests/dashboard-work-items-state.test.js` with cases for:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkItemSummary,
  filterAndSortWorkItems,
  normalizeWorkItemFilters,
  resolveSelectedWorkItemId,
} from "../dashboard-work-items-state.js";

const ITEMS = [
  {
    id: "TC-3",
    task: "优化图路由",
    assignee: "worker",
    status: "running",
    updatedAt: 30,
    createdAt: 10,
  },
  {
    id: "TC-2",
    task: "写塑形说明",
    assignee: "planner",
    status: "completed",
    updatedAt: 20,
    createdAt: 5,
  },
  {
    id: "TC-1",
    task: "图回路恢复",
    assignee: "worker",
    status: "failed",
    updatedAt: 10,
    createdAt: 1,
  },
];

test("normalizeWorkItemFilters applies stable defaults", () => {
  assert.deepEqual(normalizeWorkItemFilters({}), {
    status: "all",
    assignee: "all",
    query: "",
  });
});

test("filterAndSortWorkItems filters by status and assignee", () => {
  const result = filterAndSortWorkItems(ITEMS, {
    status: "failed",
    assignee: "worker",
    query: "",
  });
  assert.deepEqual(result.map((item) => item.id), ["TC-1"]);
});

test("filterAndSortWorkItems searches across id task and assignee", () => {
  const result = filterAndSortWorkItems(ITEMS, {
    status: "all",
    assignee: "all",
    query: "planner",
  });
  assert.deepEqual(result.map((item) => item.id), ["TC-2"]);
});

test("resolveSelectedWorkItemId prefers current item when still visible", () => {
  assert.equal(resolveSelectedWorkItemId(ITEMS, "TC-2"), "TC-2");
});

test("resolveSelectedWorkItemId falls back to newest visible item", () => {
  assert.equal(resolveSelectedWorkItemId(ITEMS, "MISSING"), "TC-3");
});

test("buildWorkItemSummary counts total active completed and failed", () => {
  assert.deepEqual(buildWorkItemSummary(ITEMS), {
    total: 3,
    active: 1,
    completed: 1,
    failed: 1,
    awaitingInput: 0,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-work-items-state.test.js
```

Expected:
- FAIL because `dashboard-work-items-state.js` does not exist yet

- [ ] **Step 3: Implement the minimal pure state helpers**

Create `extensions/watchdog/dashboard-work-items-state.js`:

```js
function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeWorkItemFilters(filters = {}) {
  return {
    status: filters.status || "all",
    assignee: filters.assignee || "all",
    query: String(filters.query || "").trim(),
  };
}

function isActiveStatus(status) {
  return ["pending", "running", "awaiting_input"].includes(String(status || "").toLowerCase());
}

export function filterAndSortWorkItems(items, rawFilters = {}) {
  const filters = normalizeWorkItemFilters(rawFilters);
  const query = normalizeText(filters.query);
  return (Array.isArray(items) ? items : [])
    .filter((item) => {
      if (filters.status !== "all" && item?.status !== filters.status) return false;
      if (filters.assignee !== "all" && item?.assignee !== filters.assignee) return false;
      if (!query) return true;
      const haystack = [
        item?.id,
        item?.task,
        item?.assignee,
        item?.replyTargetAgent,
        item?.taskType,
      ].map(normalizeText).join(" ");
      return haystack.includes(query);
    })
    .sort((left, right) =>
      (Number(right?.updatedAt) || Number(right?.createdAt) || 0)
      - (Number(left?.updatedAt) || Number(left?.createdAt) || 0));
}

export function resolveSelectedWorkItemId(items, currentId = null) {
  const visible = Array.isArray(items) ? items : [];
  if (currentId && visible.some((item) => item?.id === currentId)) {
    return currentId;
  }
  return visible[0]?.id || null;
}

export function buildWorkItemSummary(items) {
  const list = Array.isArray(items) ? items : [];
  return {
    total: list.length,
    active: list.filter((item) => isActiveStatus(item?.status)).length,
    completed: list.filter((item) => item?.status === "completed").length,
    failed: list.filter((item) => item?.status === "failed").length,
    awaitingInput: list.filter((item) => item?.status === "awaiting_input").length,
  };
}
```

- [ ] **Step 4: Run the state tests**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-work-items-state.test.js
```

Expected:
- PASS

- [ ] **Step 5: Commit**

```bash
git add \
  /Users/hakens/.openclaw/extensions/watchdog/dashboard-work-items-state.js \
  /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-work-items-state.test.js
git commit -m "feat: add work-items state helpers"
```

---

### Task 3: Replace The Placeholder Page Shell

**Files:**
- Modify: `extensions/watchdog/work-items.html`
- Create: `extensions/watchdog/dashboard-work-items.css`
- Test: visual smoke via browser + route module test

- [ ] **Step 1: Replace the `coming soon` HTML with a real page shell**

Update `extensions/watchdog/work-items.html` so it follows the same pattern as `harness.html`:

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OPENCLAW // WORK ITEMS</title>
  <link rel="stylesheet" href="/watchdog/dashboard.css">
  <link rel="stylesheet" href="/watchdog/dashboard-subpage.css">
  <link rel="stylesheet" href="/watchdog/dashboard-work-items.css">
</head>
<body>
  <header class="mission-header">...</header>
  <nav class="nav-bar" id="navBar"></nav>
  <section id="pageChrome"></section>

  <main class="work-items-page">
    <section class="work-items-topline" id="workItemsSummary"></section>
    <section class="work-items-toolbar" id="workItemsToolbar"></section>
    <section class="work-items-layout">
      <aside class="work-items-list" id="workItemsList"></aside>
      <article class="work-items-detail" id="workItemsDetail"></article>
    </section>
  </main>

  <script type="module" src="/watchdog/dashboard-work-items.js"></script>
</body>
</html>
```

Keep:
- existing mission header style
- existing nav/subpage shell pattern

Remove:
- `dashboard-coming-soon.css`
- inline `initDashboardSubpage` script
- placeholder badge markup

- [ ] **Step 2: Add minimal page CSS**

Create `extensions/watchdog/dashboard-work-items.css` with four areas only:

```css
.work-items-page {
  display: grid;
  gap: 16px;
}

.work-items-layout {
  display: grid;
  grid-template-columns: minmax(360px, 520px) minmax(0, 1fr);
  gap: 16px;
}

.work-items-list,
.work-items-detail,
.work-items-topline,
.work-items-toolbar {
  border: 1px solid var(--line, rgba(255,255,255,0.12));
  background: var(--panel, rgba(8, 14, 22, 0.82));
}
```

Then add the real card/detail/filter styles incrementally during Task 4. Do not start with a giant CSS dump.

- [ ] **Step 3: Verify the HTML shell and route assets still load**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-route-modules.test.js
curl -I 'http://localhost:18789/watchdog/work-items-view?token=REDACTED_FOR_PUBLIC'
```

Expected:
- route test PASS
- `work-items-view` returns `200`

- [ ] **Step 4: Commit**

```bash
git add \
  /Users/hakens/.openclaw/extensions/watchdog/work-items.html \
  /Users/hakens/.openclaw/extensions/watchdog/dashboard-work-items.css
git commit -m "feat: add work-items page shell"
```

---

### Task 4: Implement The Read-Only Page Controller

**Files:**
- Create: `extensions/watchdog/dashboard-work-items.js`
- Create: `extensions/watchdog/tests/dashboard-work-items-page.test.js`
- Test: `extensions/watchdog/tests/dashboard-work-items-page.test.js`

- [ ] **Step 1: Write a minimal DOM rendering test**

Create `extensions/watchdog/tests/dashboard-work-items-page.test.js` using the mock document style from `dashboard-stage-visibility.test.js`. Test only:
- summary counts render
- list renders filtered items
- detail panel renders the selected item
- changing filters changes visible rows and selected item

Target API:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  renderWorkItemsPage,
} from "../dashboard-work-items.js";
```

Expected test shape:

```js
test("renderWorkItemsPage shows filtered rows and selected detail", () => {
  const items = [
    { id: "TC-2", task: "写评估摘要", assignee: "planner", status: "completed", updatedAt: 20 },
    { id: "TC-1", task: "补 runtime truth", assignee: "worker", status: "failed", updatedAt: 10 },
  ];

  const dom = buildMockWorkItemsDocument();
  renderWorkItemsPage({
    items,
    filters: { status: "failed", assignee: "all", query: "" },
    selectedId: "TC-1",
    host: dom.host,
  });

  assert.match(dom.list.innerHTML, /TC-1/);
  assert.doesNotMatch(dom.list.innerHTML, /TC-2/);
  assert.match(dom.detail.innerHTML, /补 runtime truth/);
});
```

- [ ] **Step 2: Run the page test to verify it fails**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-work-items-page.test.js
```

Expected:
- FAIL because `dashboard-work-items.js` does not exist yet

- [ ] **Step 3: Implement the page controller**

Create `extensions/watchdog/dashboard-work-items.js` with this structure:

```js
import { esc, getToken } from "./dashboard-common.js";
import { initDashboardSubpage } from "./dashboard-subpage-init.js";
import {
  buildWorkItemSummary,
  filterAndSortWorkItems,
  normalizeWorkItemFilters,
  resolveSelectedWorkItemId,
} from "./dashboard-work-items-state.js";

const state = {
  loading: true,
  error: "",
  items: [],
  filters: normalizeWorkItemFilters(),
  selectedId: null,
};

function buildApiUrl(path) {
  const token = getToken();
  return token ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : path;
}

async function requestJson(path) {
  const response = await fetch(buildApiUrl(path));
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || `request failed: ${response.status}`);
  }
  return data;
}

export function renderWorkItemsPage({ items, filters, selectedId, host }) {
  const visible = filterAndSortWorkItems(items, filters);
  const summary = buildWorkItemSummary(visible);
  const resolvedId = resolveSelectedWorkItemId(visible, selectedId);
  const selected = visible.find((item) => item.id === resolvedId) || null;

  host.summary.innerHTML = /* summary cards */;
  host.toolbar.innerHTML = /* status select + assignee select + query input */;
  host.list.innerHTML = /* visible rows */;
  host.detail.innerHTML = /* selected item detail */;

  return { visible, selectedId: resolvedId };
}

async function loadWorkItems() {
  state.loading = true;
  state.error = "";
  try {
    state.items = await requestJson("/watchdog/work-items");
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  // collect #workItemsSummary #workItemsToolbar #workItemsList #workItemsDetail
  // call renderWorkItemsPage for success state
  // render loading/error placeholders otherwise
}

function bindToolbar() {
  // delegate change/input/click from toolbar + list
}

initDashboardSubpage({ page: "work-items" });
bindToolbar();
loadWorkItems();
```

Field policy for first version:
- List row:
  - `id`
  - `status`
  - `task`
  - `assignee`
  - `replyTargetAgent`
  - `updatedAt`
- Detail panel:
  - `task`
  - `id`
  - `status`
  - `assignee`
  - `taskType`
  - `protocolEnvelope`
  - `pipelineStage.stage`
  - `pipelineStage.round`
  - `terminalOutcome.reason`
  - `operatorContext.originSurfaceId`
  - `output`

Filtering scope for B:
- `status`
- `assignee`
- free-text `query` over `id + task + assignee + replyTargetAgent + taskType`

Do not add:
- mutate/retry/cancel buttons
- direct operator actions
- secondary data fetches
- cross-page write actions

- [ ] **Step 4: Run automated tests**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-work-items-state.test.js
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-work-items-page.test.js
node --check /Users/hakens/.openclaw/extensions/watchdog/dashboard-work-items.js
```

Expected:
- all PASS
- syntax check exits 0

- [ ] **Step 5: Commit**

```bash
git add \
  /Users/hakens/.openclaw/extensions/watchdog/dashboard-work-items.js \
  /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-work-items-page.test.js
git commit -m "feat: add read-only work-items page"
```

---

### Task 5: Live Verification Against The Running System

**Files:**
- No new files
- Verify: `extensions/watchdog/work-items.html`
- Verify: `extensions/watchdog/dashboard-work-items.js`
- Verify: `extensions/watchdog/routes/dashboard.js`

- [ ] **Step 1: Restart gateway so the updated routes and page assets are live**

Run:

```bash
bash /Users/hakens/.openclaw/start.sh
```

Expected:
- gateway restarts cleanly
- terminal prints `Watchdog:` and `Control UI:` links

- [ ] **Step 2: Verify the truth endpoint directly**

Run:

```bash
curl -sS 'http://localhost:18789/watchdog/work-items?token=REDACTED_FOR_PUBLIC' | head
```

Expected:
- JSON array
- same count as current runtime work items

- [ ] **Step 3: Verify the page in browser**

Open:

```text
http://localhost:18789/watchdog/work-items-view?token=REDACTED_FOR_PUBLIC
```

Check:
- page title is `OPENCLAW // WORK ITEMS`
- nav still shows `主页 / 代理 / 工作项 / 塑形套件 / 测试工具`
- page no longer says `即将到来`
- list count matches `/watchdog/work-items` filtered total
- search by `planner` returns planner-owned items
- filter by `failed` shows failed entries only
- selecting a row updates the detail pane

- [ ] **Step 4: Optional scripted smoke**

Run:

```bash
node - <<'NODE'
const { chromium } = require('/Users/hakens/.nvm/versions/node/v25.6.1/lib/node_modules/openclaw/node_modules/playwright-core');
const token = 'REDACTED_FOR_PUBLIC';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://localhost:18789/watchdog/work-items-view?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log(await page.locator('body').innerText());
  await browser.close();
})();
NODE
```

Expected:
- output contains `工作项`
- output contains at least one `TC-`
- output does not contain `即将到来`

- [ ] **Step 5: Commit**

```bash
git add \
  /Users/hakens/.openclaw/extensions/watchdog/work-items.html \
  /Users/hakens/.openclaw/extensions/watchdog/dashboard-work-items.css \
  /Users/hakens/.openclaw/extensions/watchdog/dashboard-work-items.js \
  /Users/hakens/.openclaw/extensions/watchdog/dashboard-work-items-state.js \
  /Users/hakens/.openclaw/extensions/watchdog/routes/dashboard.js \
  /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-route-modules.test.js \
  /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-work-items-state.test.js \
  /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-work-items-page.test.js
git commit -m "feat: add searchable work-items dashboard page"
```

---

## Self-Review

### Spec coverage
- `A` 只读首版：由 Task 3 + Task 4 完成。
- `B` 基础筛选/搜索：由 Task 2 + Task 4 完成。
- “唯一真值”要求：由 Task 1 和 Task 4 的 `/watchdog/work-items` 单一数据源约束完成。
- “不做写操作治理台”：Task 4 明确排除 mutate/retry/cancel/operator writes。

### Placeholder scan
- 没有使用 `TBD` / `TODO`。
- 每个任务都给了明确文件、命令、期望结果。
- 所有新增模块都绑定到现有文件路径。

### Type consistency
- 页面只使用已确认存在的 payload 字段：
  - `id`
  - `task`
  - `assignee`
  - `status`
  - `updatedAt`
  - `taskType`
  - `protocolEnvelope`
  - `pipelineStage`
  - `terminalOutcome`
  - `operatorContext`
  - `output`
- 唯一数据源与现有运行接口一致：`GET /watchdog/work-items`

