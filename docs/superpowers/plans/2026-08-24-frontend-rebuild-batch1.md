# 前端重制 批1（架构底座 + 指挥台区）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在零构建原生 ESM 约束下建起新前端架构底座（store/api/i18n/tokens/hash 路由），并把指挥台区（编排图动画 + 工作项 + LIVE PULSE + 哨兵 + 日志抽屉）完整实现在 `/watchdog/next`。

**Architecture:** 单页应用（单 HTML 壳 + hash 路由），四层单向依赖：core（store/api/i18n/tokens）→ components（纯渲染）→ pages（command）→ app.js（接线）。旧 9 页不动，新旧并存。

**Tech Stack:** 原生 ES module + CSS 变量，无构建无框架。宿主分发：`routes/dashboard.js` 读盘直发。

**Spec:** `docs/superpowers/specs/2026-08-24-frontend-rebuild-design.md`（先读）

**基线:** 单测 2466/2465/0。测试命令 `cd extensions/watchdog && npm test`（脚本自带沙箱种子）。

---

## 文件结构（批1 全部新建，旧文件零修改除路由注册一处）

```
extensions/watchdog/ui/
├─ index.html            壳（唯一 HTML）
├─ core/tokens.css       设计 token（柔化四色 + 字号/间距阶梯）
├─ core/store.js         状态仓
├─ core/api.js           HTTP/SSE 收口
├─ core/i18n.js          键表 + t() + 响应式
├─ core/router.js        hash 路由
├─ components/           纯渲染组件（本批：stat-strip, work-item-list, graph-board, pulse-column, log-drawer）
└─ pages/command/        指挥台组装
extensions/watchdog/routes/dashboard.js  修改一处：注册 /watchdog/next 路由
extensions/watchdog/tests/ui-*.test.js   新测试
```

**依赖规则**：components 和 pages 只允许 import core；core 内 i18n/api 可依赖 store；router 只依赖 pages 注册表。禁止反向。

---

### Task 1: 设计 token（tokens.css）

**Files:**
- Create: `extensions/watchdog/ui/core/tokens.css`
- Test: `extensions/watchdog/tests/ui-tokens.test.js`

- [ ] **Step 1: 写失败测试** —— 读 tokens.css 内容，断言四个主色变量存在且值正确，且全文件不含 `border-radius`/`box-shadow`/`linear-gradient`（除注释）：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("tokens: 柔化四色单一定义 + 零圆角零阴影零渐变", async () => {
  const css = await readFile(new URL("../ui/core/tokens.css", import.meta.url), "utf8");
  assert.match(css, /--bg:\s*#FEF9EC/);
  assert.match(css, /--ink:\s*#2E2A24/);
  assert.match(css, /--alert:\s*#B05C4C/);
  assert.match(css, /--active:\s*#C08A5A/);
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(noComments, /border-radius|box-shadow|linear-gradient/);
});
```

- [ ] **Step 2: 跑测试确认失败**（文件不存在）`node --test tests/ui-tokens.test.js`
- [ ] **Step 3: 实现 tokens.css**：

```css
/* tokens.css — 设计变量唯一来源（2026-08-24 裁决：底暖点冷·柔化版）
   纪律：零圆角、零阴影、零渐变。状态色只有三个语义。 */
:root {
  --bg: #FEF9EC;        /* 米白底 */
  --ink: #2E2A24;       /* 暖黑：结构/标题/主按钮 */
  --alert: #B05C4C;     /* 砖红：异常/危险/哨兵 */
  --active: #C08A5A;    /* 柔橙：进行中 */
  --line-soft: #B0A794; /* 暖沙：虚线分隔 */
  --font-mono: "Courier New", ui-monospace, monospace;
  --fs-micro: 9px; --fs-label: 10px; --fs-body: 11px; --fs-num: 20px; --fs-title: 22px;
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
  --border: 2px solid var(--ink);
}
```

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `git add ui/core/tokens.css tests/ui-tokens.test.js && git commit -m "feat(ui): 批1 tokens.css 设计变量"`

### Task 2: 状态仓 store.js

**Files:**
- Create: `extensions/watchdog/ui/core/store.js`
- Test: `extensions/watchdog/tests/ui-store.test.js`

- [ ] **Step 1: 失败测试**：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../ui/core/store.js";

test("store: get/patch/subscribe/退订", () => {
  const store = createStore({ lang: "zh-CN", items: [] });
  const seen = [];
  const off = store.subscribe((s, changed) => seen.push(changed));
  store.patch({ lang: "en-US" });
  assert.equal(store.get().lang, "en-US");
  assert.deepEqual(seen, [["lang"]]);
  off();
  store.patch({ lang: "zh-CN" });
  assert.equal(seen.length, 1, "退订后不再通知");
});

test("store: patch 相同值不触发通知", () => {
  const store = createStore({ a: 1 });
  let calls = 0;
  store.subscribe(() => calls++);
  store.patch({ a: 1 });
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: 确认失败** `node --test tests/ui-store.test.js`
- [ ] **Step 3: 实现**（浅比较 + 变更键集合通知）：

```js
// store.js — 单一数据源。SSE/轮询只写，组件只读+订阅。
export function createStore(initial) {
  let state = { ...initial };
  const listeners = new Set();
  return {
    get: () => state,
    patch(partial) {
      const changed = Object.keys(partial).filter((k) => state[k] !== partial[k]);
      if (!changed.length) return;
      state = { ...state, ...partial };
      for (const fn of listeners) fn(state, changed);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
```

- [ ] **Step 4: 通过**
- [ ] **Step 5: Commit**

### Task 3: 服务层 api.js

**Files:**
- Create: `extensions/watchdog/ui/core/api.js`
- Test: `extensions/watchdog/tests/ui-api.test.js`

- [ ] **Step 1: 失败测试**（mock fetch 注入）：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../ui/core/api.js";

test("api.getJson: 拼 token + 错误归一", async () => {
  const calls = [];
  const api = createApi({
    token: "T",
    fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({ n: 1 }) }; },
  });
  const data = await api.getJson("/watchdog/runtime");
  assert.equal(data.n, 1);
  assert.ok(calls[0].includes("token=T"));

  const bad = createApi({ token: "T", fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(() => bad.getJson("/x"), (e) => e.kind === "auth");
});

test("api.inspect: surface 与参数拼装", async () => {
  const api = createApi({ token: "T", fetchImpl: async (url) => ({ ok: true, json: async () => ({ url }) }) });
  const r = await api.inspect("inspect.threads", { limit: 5 });
  assert.ok(r.url.includes("surface=inspect.threads") && r.url.includes("limit=5"));
});
```

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（错误归一 kind: network/auth/data）：

```js
// api.js — 所有 HTTP 的唯一收口。组件禁止直接 fetch。
export function createApi({ token, fetchImpl = fetch }) {
  async function getJson(path) {
    const sep = path.includes("?") ? "&" : "?";
    let res;
    try {
      res = await fetchImpl(`${path}${sep}token=${encodeURIComponent(token)}`);
    } catch (e) {
      throw Object.assign(new Error(`network: ${e.message}`), { kind: "network" });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`http ${res.status}`), { kind: res.status === 401 || res.status === 403 ? "auth" : "data" });
    }
    return res.json();
  }
  return {
    getJson,
    inspect: (surface, params = {}) =>
      getJson(`/watchdog/inspect?surface=${encodeURIComponent(surface)}&${new URLSearchParams(params)}`),
  };
}
```

- [ ] **Step 4: 通过**
- [ ] **Step 5: Commit**

### Task 4: i18n.js（键表 + 响应式 + lint 守卫）

**Files:**
- Create: `extensions/watchdog/ui/core/i18n.js`
- Create: `extensions/watchdog/ui/core/i18n-keys.js`（双语键表，批1 只需指挥台区键）
- Test: `extensions/watchdog/tests/ui-i18n.test.js`

- [ ] **Step 1: 失败测试**——镜像完整性 + 回退链：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { LANG_PACKS, createI18n } from "../ui/core/i18n.js";
import { enUS } from "../ui/core/i18n-keys.js";

test("i18n: 双语键表完全镜像", () => {
  const en = Object.keys(LANG_PACKS["en-US"]).sort();
  const zh = Object.keys(LANG_PACKS["zh-CN"]).sort();
  assert.deepEqual(en, zh);
});

test("i18n: t() 参数替换与回退", () => {
  const i18n = createI18n({ lang: "zh-CN" });
  assert.equal(i18n.t("pulse.queue", { n: 2 }), "队列: 2 等待中");
  i18n.setLang("en-US");
  assert.equal(i18n.t("pulse.queue", { n: 2 }), "queue: 2 waiting");
});
```

（键表内容：指挥台全部文案，nav/th 三区名、统计带 7 键、工作项栏、LIVE PULSE、哨兵、日志抽屉、空态/加载/错误三态文案。）

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现** i18n.js（`t(key, params)`，回退链 当前语言→en-US→key 本身；`setLang` 通知 store）+ i18n-keys.js 双语键表
- [ ] **Step 4: 通过**
- [ ] **Step 5: Commit**

### Task 5: hash 路由 + 壳 + /watchdog/next 路由注册

**Files:**
- Create: `extensions/watchdog/ui/index.html`、`ui/core/router.js`、`ui/app.js`
- Modify: `extensions/watchdog/routes/dashboard.js`（注册一处：`/watchdog/next` 及 `/watchdog/ui/*` 静态文件直发，沿用现有读盘 + Cache-Control no-store 模式）
- Test: `extensions/watchdog/tests/ui-router.test.js`

- [ ] **Step 1: router 失败测试**（纯函数解析 hash → {zone, params}）：`#/、#/inspect、#/inspect?run=r-1、#/manage/agents` 四种
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现** router.js（`parseHash(hash)` 纯函数 + `startRouter(onChange)` 监听 hashchange）；index.html 壳（`<div id="app">` + `<script type="module" src="/watchdog/ui/app.js">`）；routes/dashboard.js 加路由（读 ui/ 目录文件，ES module 引用照旧由 URL 直发）
- [ ] **Step 4: 通过 + curl 实证**：网关重启后 `curl -s localhost:18789/watchdog/next?token=...` 返回壳 HTML（网关重启由用户/主会话执行，子代理不重启）
- [ ] **Step 5: Commit**

### Task 6: 指挥台布局 + 统计读数带

**Files:**
- Create: `ui/components/stat-strip.js`、`ui/pages/command/command-page.js`、`ui/pages/command/command.css`
- Test: `extensions/watchdog/tests/ui-command.test.js`

- [ ] **Step 1: 失败测试**：stat-strip 纯渲染（输入 {active:3, queue:2, done:41, alert:1} 输出 DOM 字符串含 4 格与状态色类名）
- [ ] **Step 2-3: 实现**（三栏 grid：左工作项 260px / 中编排图 1fr / 右 LIVE PULSE 300px；顶栏读数带；组件返回 DOM 节点，样式全部 var(--*)）
- [ ] **Step 4-5: 通过 + Commit**

### Task 7: 编排图（合约卡滑行动画 + 排队堆叠）

**Files:**
- Create: `ui/components/graph-board.js`（SVG 生成，参考旧 dashboard-svg.js 的布局与 calcEdgePath 五种几何，可移植简化）+ `graph-board.css`
- Modify: 无（旧 dashboard-svg.js 不动）
- Test: `tests/ui-graph-board.test.js`

- [ ] **Step 1: 失败测试**：给定 nodes+edges+flows 生成 SVG 文本含：节点 rect 数正确、流动合约卡 `<g class="contract-card">` 带 `offset-path`、排队堆叠数正确
- [ ] **Step 2-3: 实现**：
  - 节点 = 粗边框卡（var(--border)），状态点（active=柔橙 / idle=暖黑）
  - **交接动画**：`<g class="contract-card">` 矩形卡沿边 `offset-path: path(...)` + `@keyframes slide`（0%/100% opacity 0），到达瞬间目标节点 `stroke-width` 加厚 200ms
  - **排队动画**：queued 数 >0 时在目标入口左侧画 N 张堆叠卡（错开 4px）
  - 数据源：store.graph（/watchdog/graph）+ store.runtime（/watchdog/runtime）+ SSE graph_dispatch/track_progress 驱动 flows
- [ ] **Step 4-5: 通过 + Commit**

### Task 8: LIVE PULSE 右栏（脉搏卡 + 哨兵卡 + 日志抽屉）

**Files:**
- Create: `ui/components/pulse-column.js`、`pulse-column.css`
- Test: `tests/ui-pulse.test.js`

- [ ] **Step 1: 失败测试**：①正常态渲染 run 脉搏卡（含最近工具调用行、点击回调携带 runId）；②异常信号注入时哨兵卡置顶且带 alert 色与两个按钮；③异常消失后哨兵卡移除
- [ ] **Step 2-3: 实现**：
  - 脉搏卡：活跃 run（store 里 tracking/run_event 派生）各一张，含最近工具调用滚动行、进度条、点击 → `#/inspect?run=<runId>`
  - 哨兵规则 MVP（纯函数 `evaluateSentinels(signals)` 可单测）：refused 5 分钟 ≥3 次 / SSE alert error 族 / 队列淤积 ≥5 / 链尖报警事件
  - 哨兵卡：砖红底、「查看证据」（跳透视）「忽略本次」（本地 dismiss）
  - 日志抽屉：底部收起条，展开显示 SSE 事件流（沿用旧 ticker 的渲染逻辑简化移植）
- [ ] **Step 4-5: 通过 + Commit**

### Task 9: 工作项左栏 + 接线成页

**Files:**
- Create: `ui/components/work-item-list.js`、`ui/pages/command/index.js`
- Test: 并入 `tests/ui-command.test.js`

- [ ] **Step 1-5**：工作项列表纯渲染（状态分组：进行中/排队/已完成；点击跳详情）；command 页组装三栏 + 顶栏 + 抽屉；store 接线（api 轮询 work-items 15s + SSE 即时刷，沿用旧 dashboard.js:706-712 的节拍语义）；Commit

### Task 10: i18n 硬编码 lint 守卫 + 全量回归

**Files:**
- Create: `tests/ui-i18n-hygiene.test.js`
- [ ] **Step 1-3**：守卫测试 = 扫描 `ui/**` 下 JS/HTML，断言 UI 文案零硬编码中文（正则：标签/按钮/属性里的 CJK 字符出现在字符串字面量中即报，键表文件豁免）
- [ ] **Step 4**：全量 `npm test` 对比基线（2465 pass + 新增全绿）
- [ ] **Step 5**：Commit + 报告

---

## 批1 完成判据

1. `/watchdog/next` 打开即是可用的指挥台（编排图动画/工作项/LIVE PULSE/哨兵/抽屉）
2. 新单测全绿 + 旧 2465 零回归
3. i18n 键表镜像 + 硬编码 lint 守卫绿
4. 旧 9 页零改动（并存期）

## Self-Review 记录

- 覆盖核对：spec §1 架构（T2-5）§2.1 指挥台（T6-9）§4 tokens（T1）§5 i18n（T4/T10）§6 错误处理（T3）§6 测试（各任务）——批2/3 内容不在本计划（透视页/管理区），符合分批
- 命名一致性：createStore/createApi/createI18n/parseHash/evaluateSentinels 全文一致
- 已知留白：透视页与管理区的组件规格在批2/批3 计划里另立
