# 设计规格：可视化大师 (viz-master) 第二 Meta-Agent + 图表（非真值内容存储）

- **日期**: 2026-06-05（**2026-06-06 修订**）
- **状态**: 脊柱已批准；**2026-06-06 重大修正见下方横幅**，以修正后模型为准 → 实施中

> ## ⚠️ 2026-06-06 修正横幅（覆盖本文档下方 D1 及所有“第 5 结构真值”表述）
>
> **charts 不是结构真值。** 经核实 + 用户裁定（见 [[备忘录123]] / `2026-06-05-truth-seam-coordination-design.md`）：
> 1. **meta-agent 的定义是“某平台改写 *surface 家族* 的唯一改写者”，不是“拥有一个 snapshot 真值”。** 铁证：operator 拥有 `apply.knowledge_*` 面（它是 meta-agent），但 `knowledge-bases.json` 被 D-β 判定**不是真值**。
> 2. 一张 chart = `spec + 位置 + 数据绑定`，**可从数据重生**、不定义 agent 系统形状 = **内容/数据**，与 `knowledge-bases.json` 同类。
> 3. **故 `charts.json` = 非真值 control-plane 存储**（`control-plane-paths.js` 加一行，与 knowledge-bases 并排），**不进 `readTruths`/快照/哈希**。**本设计完全不碰真值层**（`structure-snapshot.js` 不动）。
> 4. viz-master 仍是**真·第 2 meta-agent**——靠**拥有 `chart` surface 家族**成立，与“是否真值”无关。它是**控制面、用户不可见、只由 operator 经进程内直调（R2）召唤**。
> 5. `apply.chart_create` 是**非真值 family**（像 `apply.knowledge_add`，**不**触发结构快照；原文 D1 的 `risk:"structural"` 作废）。
> 6. **R2**（来自 备忘录123 §八）：viz-master 交付走 **operator-executor 进程内委派**，**不**用 graph edge（graph 边会重入 worker 传送带）。
>
> 下方正文 §1.2 D1、§2 脊柱图“第5真值”、§3 第5真值行、§6 Phase B、§8 truth 相关风险，均以本横幅为准修正；其余（viz-master=meta-agent、能力注册表、手搓 SVG、服务端拖拽、静态优先、D8 verify 豁免、前端 4-touch）保留。
- **基线**: 测试门 1729/0（slice-1 全程必须保持绿）
- **代码根**: `~/.openclaw/extensions/watchdog/`（除 `openclaw.json` 在 OC 根 `~/.openclaw/openclaw.json`）
- **grounding 证据**: 2 个并行 workflow（发现 + 落地）共 11 个 agent、~840k token，全部 file:line 核验

---

## 1. 背景与动机

用户希望：operator 在未来需要"建立某个图表展示某些东西"时，**召唤一个专职可视化专家 agent（"可视化大师"）**来生成图表（懂 Vega/Tableau 等可视化语法），图表可在仪表盘上**预览、不满意可重复修改重生、生成后可拖到网页任意位置、支持静态与动态数据**。

### 1.1 三个被纠正的前提（基于代码证据）

设计前先校准了三个与代码不符的心智模型：

1. **React?——不迁。** 仪表盘是纯 vanilla（34 个 `dashboard-*.js` ~13k LOC + ~12.7k LOC NASA-Punk CSS），**零构建、零打包、零前端依赖**；`routes/dashboard.js` 直接发源文件 + 正则防缓存。迁 React = 多周重写 + 强制引构建步骤 + 拉进 React/ReactDOM(+react-flow/d3)，**直接违反零依赖 + 离线自包含姿态**，对画图零收益。逃生口（若某页失控）是给那一页引 `lit-html`/`htm+preact`（ESM，~3KB，免构建），而非全站迁移。
2. **"预览模式"是干跑结构投影，不是视觉预览，也不在 runtime-operator。** 今天的 `预览` = `projectStructureAfter()`（`lib/control-plane/structure-snapshot.js:182`）——深拷贝结构真值、套用拟议改动、返回 `edgeDiff/agentDiff`，**只投影图拓扑**，是 operator 设计流程的收尾步。前端有死代码 `renderStructurePreviewOverlay()`（`dashboard-graph.js:907`，零调用零 import）——这正是用户"没有预览选项"观察的真因。**图表的视觉预览是全新东西**，旧机制只贡献一个可复用的 UI 约定（`.graph-preview-banner` 横幅+退出）。
3. **operator 是硬编码单例 + 设计者-only，运行时不能召唤。** `cli-surface-executor.js:19` `if (actor !== "operator") throw` 是它成为唯一平台改写者的根；`operator-executor.js:54-65` 硬 block `runtime.loop.start/resume`（`operator_is_designer_only`）。所以"operator 召唤 viz-master"要重新定义。

### 1.2 锁定的决策（含理由）

| # | 决策 | 理由 |
|---|------|------|
| D1 | **图表 = 服务端第 5 结构真值** `control-plane/charts.json` | 用户要"持久放置 + 数据绑定" = 平台状态，不是一次性 artifact。这是"真·meta-agent"成立的前提（meta-agent 的定义就是"某平台真值的唯一改写者"）。 |
| D2 | **viz-master = 真·第二 meta-agent**，经能力注册表泛化单例 | 用户明确选此路（覆盖了我"建 worker"的推荐）。做对的方式 = **把硬编码单例升级成 `actor→owned-families` 注册表**，而非"放开门让谁都过"。这反而还清硬编码债、符合"一条路径/不特例化"红线。 |
| D3 | **operator 经委派参与**，slice-1 用"operator 建 viz-master + 授权边，viz-master 自己跑 chart" | 避开直接把步骤交给 viz-master actor 与 designer-only 块的冲突。直接 meta→meta 交接推迟到 slice-2。 |
| D4 | **能力检测式渐进渲染**：声明式 spec 默认；检测到已装库则用库；请求超出声明式能力且无库时**中途提示用户安装再决断** | 用户 Q2 原话。slice-1 = 纯手搓 SVG（声明式），库路径与人工门 DEFERRED。 |
| D5 | **手搓 SVG**（复用 `dashboard-svg.js:33 svgEl()`），line/bar/pie 起步 | 零依赖 + NASA-Punk 主题统一。 |
| D6 | **拖拽位置服务端持久化**（`apply.chart_move` 写 `charts.json`），不复用 `dashboard-drag.js` | 服务端位置才算"平台真值"，与 D1 自洽；SVG 拖拽器用 `getScreenCTM` 不适用 HTML 面板，**新写 HTML 拖拽器**。 |
| D7 | **静态数据优先**，SSE 实时 DEFERRED | slice-1 复用已通的 `inspect.*` 读路径。 |
| D8 | **`apply.chart_create` 强制 verify 豁免**（加进 `UNSUPPORTED_VERIFICATION_SURFACES`） | single 套件对图表零断言，跑了=空绿/自欺；slice-2 再补"spec 能渲染不抛错"真校验。 |
| D9 | **手种先行、brain 收尾**：slice-1 内先手种一条 `charts.json` 跑通前端，最后落 viz-master brain | 前端不被 agent 阻塞；端到端仍在 slice-1 内闭环。 |

---

## 2. 架构脊柱

```
┌─ 第 5 结构真值 ────────────────────────────────────────┐
│  control-plane/charts.json  ← 唯一存储模块 chart-registry.js │
│  与现有 4 真值并列: graph边 / loop注册表 / agent配置 / automations │
│  同时是: ① 第5真值(快照/哈希/恢复) ② inspect.charts 读源 ③ apply.chart_* 写靶 │
└───────────────────────────────────────────────────────┘
            ▲ 唯一改写者
┌─ 能力注册表（泛化单例）─────────────────────────────────┐
│  meta-agent-surface-ownership.js                          │
│    META_AGENT_SURFACE_OWNERSHIP = { operator:"*", "viz-master":["chart"] } │
│    SHARED_FAMILIES = ["test_run"]   ← verify 基础设施人人可用 │
│    assertActorOwnsSurface(actor, surfaceId, surface)      │
│  替换 cli-surface-executor.js:19 的裸门                    │
└───────────────────────────────────────────────────────┘
            │ operator 计划: agents.create(viz-master) + 授权边
            ▼
┌─ viz-master = 第二 meta-agent ─────────────────────────┐
│  openclaw.json 块(protected, tools=read/write/edit, 无bash) │
│  viz-master-brain.js(产 spec + 1 步 apply.chart_create)    │
│  chart-build/SKILL.md + chart-spec-schema.js               │
│  拥有 chart 家族 → 经 apply.chart_create 写 charts.json     │
└───────────────────────────────────────────────────────┘
            │
            ▼
┌─ 仪表盘图表层（charts.html 独立页）──────────────────────┐
│  读 inspect.charts → dashboard-chart-render.js(svgEl 手搓)  │
│  → dashboard-draggable-widget.js(HTML 拖拽, 防抖)           │
│      → POST /watchdog/charts/move (apply.chart_move 服务端持久化) │
│  → 复用 .graph-preview-banner 横幅做 预览/重生              │
└───────────────────────────────────────────────────────┘
```

---

## 3. Slice-1 切线（IN / DEFERRED）

**成功判据**：operator(经委派)驱动 viz-master 产出 1 张静态图 → 落 `charts.json` → 进结构内容哈希(快照/恢复安全) → 仪表盘渲染成 1 个可拖拽面板，位置经 `apply.chart_move` 服务端持久化、刷新不丢 → 预览/重生横幅能重读 spec。**全程测试门 1729/0 保持绿。**

| 支柱 | Slice-1 IN | DEFERRED |
|---|---|---|
| **第5真值** | `chartsRegistryFile` 路径；`chart-registry.js` 存储；`readTruths()`+restore+`restored` 加第5键；快照往返测试 | `projectStructureAfter` chart 分支（今天优雅 no-op，`structural:false`）；恢复引用完整性检查（无跨真值外键，免） |
| **能力注册表** | `meta-agent-surface-ownership.js`；替换裸门；`actor` 串进 `operator-executor.js:90`+`cli-surface-verify-gate.js:65/68`；`admin-surface-subject.js` 加 `chart.` 分支；`CONTROL_PLANE_AGENT_IDS`/`PROTECTED_AGENT_IDS` 由 `META_AGENT_IDS` 派生（spread 不 replace）；ownership 对抗测试 | designer-only 块泛化进 ownership（slice-1 原样保留）；per-agent brain prompt/model 参数化；`/watchdog/meta/:id/*` 路由泛化 |
| **chart.\* 写面** | `apply.chart_create`(risk:structural→自动快照) + `apply.chart_move`(risk:safe, confirmation:none) 的 catalog+handler+input-fields+route | `apply.chart_update`/`apply.chart_delete`；独立 `chart` CLI 家族（slice-1 骑 `stage:"apply"`→family `"apply"`） |
| **viz-master agent** | `openclaw.json` 块(tools 仅 read/write/edit)；`chart-spec-schema.js`+`validateChartSpec`；`chart-build/SKILL.md`；精简 `viz-master-brain.js`+`viz-master-knowledge.js`；`semantic-skill-registry.js` 加 `chart-build` 条目 | bash + 库能力检测(`python -c "import altair"`) + 安装人工门(无库渲染前无意义)；SSE dataBinding；area/scatter |
| **前端** | 独立 `charts.html`(4-touch)；`dashboard-chart-render.js`(svgEl 手搓 line/bar/pie)；`dashboard-draggable-widget.js`(新写 HTML 拖拽，**不动** `dashboard-drag.js`)；防抖落点→POST `/watchdog/charts/move`；克隆 `.graph-preview-banner`→`.chart-preview-banner` 做预览/重生 | SSE 实时(`chart_series` 事件 + `dashboard.js:1244` 监听白名单)；vendored 库路径 + 静态资产路由(`routes/dashboard.js:16` 的 `^dashboard.*` 正则会 404 `vendor-*.js`)；多图布局/缩放；agent 端 matplotlib/plotly 出图 |

---

## 4. 组件设计（每单元：做什么 / 怎么用 / 依赖什么）

### 4.1 `chart-registry.js`（第 5 真值存储）
- **做什么**：`charts.json` 的读写门面。导出 `loadCharts/saveCharts/listCharts/getChart/upsertChart/deleteChart/normalizeChartSpec`。
- **怎么用**：`inspect.charts` 调 `listCharts()`；`apply.chart_*` 调 `upsertChart/saveCharts`；`structure-snapshot.js` restore 调 `saveCharts`。
- **依赖**：`CONTROL_PLANE_PATHS.chartsRegistryFile`、`atomicWriteFile`、`withLock`。**模板** = `automation-registry.js:167-193`（envelope `{updatedAt, charts:[...]}`，`LOCK="store:charts"`）。
- **不变量**：`saveCharts` 必须可被 `lib/control-plane/structure-snapshot.js` import（故存储置于 `lib/control-plane/`，**不**放 `lib/operator/`）。

### 4.2 `meta-agent-surface-ownership.js`（能力注册表）
- **做什么**：`META_AGENT_SURFACE_OWNERSHIP={operator:"*", "viz-master":["chart"]}`、`META_AGENT_IDS`、`SHARED_FAMILIES=["test_run"]`、`resolveSurfaceFamily(surface)=buildAdminSurfaceSubject(surface).kind`、`assertActorOwnsSurface(actor, surfaceId, surface)`、`isMetaAgentId`。
- **怎么用**：`cli-surface-executor.js:19` 用 `assertActorOwnsSurface` 替换裸门。
- **依赖**：`admin-surface-subject.js` 的 `buildAdminSurfaceSubject`（**前置修正**：见 §6 修正 1，必须先加 `chart.` 分支，否则 chart 落进 `kind:"platform"`）。
- **不变量**：`operator:"*"` 保证 operator 行为字节级不变（回归锁测试）。

### 4.3 `chart-operations.js`（写面 handler）
- **做什么**：`createChartDefinition` / `moveChartPosition`，签名 `({payload, logger, onAlert, runtimeContext}) => ({ok:true,...})`。
- **怎么用**：`admin-surface-operations.js:273 ADMIN_SURFACE_OPERATION_HANDLERS` 把两个 surfaceId 映射到此。
- **依赖**：`validateChartSpec`、`upsertChart`、`saveCharts`。
- **不变量**：软失败必须 `return {ok:false}`（executor 据此 throw→`maybePreApplyStructureSnapshot` 回滚，`operator-executor.js:98`）。

### 4.4 `viz-master-brain.js`（精简规划器）
- **做什么**：`buildVizMasterBrainSystemPrompt` + `planWithVizMaster`，产出"1 个 chart spec + 1 步 `apply.chart_create`"，surface 视图经 ownership 注册表过滤到仅 chart 家族。
- **怎么用**：路由 `/watchdog/viz/plan|execute`（或对 `executeOperatorExecutablePlan` 的薄别名传 `actor:"viz-master"`）。
- **依赖**：复用 `resolveOperatorBrainModel(config)`（已验证 agent-agnostic）；`viz-master-knowledge.js`；`chart-spec-schema.js`。

### 4.5 前端三件套
- `dashboard-chart-render.js`：纯函数 `spec→SVG`，建立在 `svgEl`（`dashboard-svg.js:33`）；line/bar/pie；**SVG 表达力上限 = 手搓能力**（spec schema 的天花板由此约束，维护性不变量）。
- `dashboard-draggable-widget.js`：HTML 绝对定位面板拖拽，`clientX/Y` delta（**非** `getScreenCTM`）；`{onCommit}` 防抖→`apply.chart_move`。
- `dashboard-charts.js`：页面控制器，`fetchJson('/watchdog/inspect?surface=inspect.charts')`（模式同 `dashboard-knowledge.js:26`）。

---

## 5. 数据模型

### 5.1 声明式 chart spec（`chart-spec-schema.js`）
```js
{
  version: 1,
  id: string,                       // kebab-case ^[a-z0-9][a-z0-9-]{1,48}$
  label: string,
  type: "line" | "bar" | "pie",     // slice-1; area/scatter DEFERRED
  title: string,
  series: [
    { name: string,
      points: [ { x: number|string, y: number } ] }  // x: 时间/类目=string, 数值=number
  ],
  axes: { x: { label: string }, y: { label: string } },  // type=pie 时忽略
  dataBinding: { mode: "static" },  // "sse" DEFERRED——字段保留做前向兼容
  render: { prefer: "declarative", width?: number, height?: number }  // "lib" DEFERRED
}
```
`validateChartSpec` 风格仿 `skill-author.js`（纯函数，非法 id/type/缺 series 即 throw）。

### 5.2 `charts.json` 注册表条目
```js
{
  updatedAt: <ms>,
  charts: [
    {
      id: string,                   // == spec.id
      label: string,
      spec: <上面的 chart spec>,    // 唯一真相；重生 = 重渲染此 spec
      position: { x: number, y: number },  // 绝对 px, 由 apply.chart_move 写
      renderMode: "declarative",    // "lib" DEFERRED
      createdAt: <ms>, updatedAt: <ms>
    }
  ]
}
```
Envelope `{updatedAt, charts:[...]}` 精确对齐 `automation-registry.js:188`。`position` 创建默认 `{x:0,y:0}`；`apply.chart_move` 是仅覆盖 `position` 的 safe 写。**无跨真值外键** → restore 末尾追加安全，slice-1 不需引用完整性检查。

---

## 6. 构建顺序（依赖序，6 阶段 ~27 步）

> 按 D9（手种先行）：Phase A-D + F 先落地并用**手种 `charts.json`** 验证前端；Phase E（viz-master brain）作为同一刀收尾，演示端到端。

**Phase A — 存储（一切的地基）**
1. `control-plane-paths.js:CONTROL_PLANE_PATHS`(16-40) 加 `chartsRegistryFile: join(CONTROL_PLANE_ROOT,"charts.json")`。无 LEGACY 项（净新）。
2. **新** `lib/control-plane/chart-registry.js`（仿 `automation-registry.js:167-193`）。

**Phase B — 第 5 真值（写面之前先保证快照安全）**
3. `structure-snapshot.js:readTruths`(44-52) `Promise.all` 加 `loadCharts()`，返回加 `charts` 键。
4. `structure-snapshot.js:restoreStructureSnapshot`(139-150) `writeAutomationStore` 后追加 `await saveCharts(snap.truths.charts)`；`restored` 加 `charts:true`；顶部加 import。
5. **新** 快照往返测试：capture→改 charts→restore→断言 charts 恢复 + 哈希匹配（覆盖"4 处改一致"风险）。

**Phase C — 能力注册表（对 operator 行为字节级不变）**
6. ⚠ `admin-surface-subject.js:buildAdminSurfaceSubject`(144 前) 加 `if (surfaceId.startsWith("chart.")||surfaceId.startsWith("apply.chart_")) return {kind:"chart",...}`。**必须先于步骤 8**。
7. **新** `lib/cli-system/meta-agent-surface-ownership.js`。
8. `cli-surface-executor.js:19-21` 裸门 → `assertActorOwnsSurface(actor, normalizedSurfaceId, surface)`；22-30 不动。
9. `operator-executor.js:7,90` 加 `actor` 参（默认 `"operator"`），90 行传入。
10. `cli-surface-verify-gate.js:65,68` 串 `actor`；`test_run` 在 `SHARED_FAMILIES` 故强制 verify 通过。
11. `agent-plane-policy.js:10-15` → `new Set([...META_AGENT_IDS,"harness","cli-system","automation"])`；`agent-metadata.js:3,50-55` 加 `VIZ_MASTER`，`PROTECTED_AGENT_IDS` 由 `META_AGENT_IDS` 派生（**spread 不 replace**）。
12. **新** `meta-agent-surface-ownership.test.js`：operator(`*`) 过全部；viz-master 在 `agents.create`/`graph.*` 被拒、在 `apply.chart_*`+`test_run` 通过。

**Phase D — chart 写面（已正确门控）**
13. **新** `lib/admin/chart-operations.js`（`{ok,...}` 契约，软失败 `ok:false`）。
14. `apply-rest.js`(410 `apply.knowledge_add` 后) 加 `apply.chart_create`(risk:structural, confirmation:changeset) + `apply.chart_move`(risk:safe, confirmation:none)。
15. `admin-surface-operations.js:273 ADMIN_SURFACE_OPERATION_HANDLERS` 映射两 id 到 handler。
16. **新** `lib/admin/input-fields/chart.js` + 并入 `admin-surface-input-fields.js`（create 需 `{spec}`；move 需 `{chartId,x,y}`）。
17. `routes/api.js`(~419) `registerAdminSurfacePostRoute("/watchdog/charts/create","apply.chart_create")` + `("/watchdog/charts/move","apply.chart_move")`。
18. `cli-surface-catalog.js`(仿 `inspect.knowledge_bases:399`) + `cli-surface-inspector.js:INSPECT_SOURCES`(仿 :126) 加 `inspect.charts`→`()=>listCharts()`。
19. **新** `apply.chart_create` 加进 `UNSUPPORTED_VERIFICATION_SURFACES`（D8 豁免）。

**Phase E — viz-master agent（已有 surface 可驱动）**
20. **新** `lib/viz/chart-spec-schema.js`（schema + `validateChartSpec`）。
21. **新** `lib/viz/viz-master-brain.js` + `lib/viz/viz-master-knowledge.js`（surface 视图经 ownership 过滤到 chart）。
22. **新** `skills/chart-build/SKILL.md` + `semantic-skill-registry.js:6-138` 加 `chart-build`。
23. `openclaw.json:agents.list`(operator 块后) 加 `viz-master` 块（继承 `model.primary`，**不钉 ark-openai**）。
24. `routes/api.js`(~421-437) 加 `/watchdog/viz/plan` + `/watchdog/viz/execute`。

**Phase F — 仪表盘图表层**
25. **新** `dashboard-chart-render.js` / `dashboard-draggable-widget.js` / `dashboard-charts.js` / `charts.html` / `dashboard-charts.css`。
26. `dashboard-nav.js:5-14` 加 `{key:"nav.charts", path:"/watchdog/charts-view", page:"charts", ...}` + i18n 键。
27. `routes/dashboard.js:213-225` 加 `/watchdog/charts-view` 页路由（仿 knowledge-view）。

---

## 7. 净新文件清单（15）

| 文件 | 用途 |
|---|---|
| `lib/control-plane/chart-registry.js` | `charts.json` 存储门面；`saveCharts` 被 restore import |
| `control-plane/charts.json`（运行时自建） | 第 5 真值 + 读写靶；envelope `{updatedAt, charts:[]}` |
| `lib/cli-system/meta-agent-surface-ownership.js` | 能力注册表 + `assertActorOwnsSurface` |
| `lib/admin/chart-operations.js` | `apply.chart_create/move` handler |
| `lib/admin/input-fields/chart.js` | 两个 chart surface 的必填字段 schema |
| `lib/viz/chart-spec-schema.js` | 声明式 chart spec 契约 + `validateChartSpec` |
| `lib/viz/viz-master-brain.js` | viz-master 规划器（chart-scoped surface 视图） |
| `lib/viz/viz-master-knowledge.js` | viz brain 静态知识片段 |
| `skills/chart-build/SKILL.md` | WHEN/选哪种图 + spec schema + 重生契约 |
| `dashboard-chart-render.js` | 纯 `spec→SVG` 绘图器（svgEl，line/bar/pie） |
| `dashboard-draggable-widget.js` | HTML 面板拖拽器，`{onCommit}`→防抖 `apply.chart_move` |
| `dashboard-charts.js` | 图表页控制器 |
| `charts.html` | 子页骨架 |
| `dashboard-charts.css` | NASA-Punk 扁平面板 + `.chart-preview-banner` |
| `meta-agent-surface-ownership.test.js` | ownership 门对抗测试 |
| （快照往返测试，并入既有 structure-snapshot 测试文件） | 断言 charts 经 capture→restore 存活 |

---

## 8. 风险与缓解（grounding 核验）

- **⚠ 修正 1（最可能的坑）**：能力注册表**不会**免费识别 chart 家族。`buildAdminSurfaceSubject`(`admin-surface-subject.js:144-149`) 有 `platform` 兜底，`chart.*` 会掉进 `kind:"platform"`。**步骤 6 强制先行**：若跳过，viz-master 的 `["chart"]` 谁都匹配不上（全拒）；若误把 ownership 写成 `"platform"` 则过度授权拿到所有未匹配 surface。
- **泛化单例不破坏四控制面 agent（已验证）**：`cli-surface-executor.js:19` 是唯一 actor 门，3 个调用点都传字面 `"operator"`；`harness`/`cli-system`/`automation` 是控制面**agent id** 但不是调 executor 的 **actor**，从不到达门。唯一注意：步骤 11 必须 **spread 不 replace**，否则三者丢控制面身份（会进主视图、可被建成 runtime agent）。
- **delegation 不与 designer-only 冲突（slice-1 规避）**：operator 计划 = `agents.create(viz-master)` + 授权边；viz-master 在自己 pass 跑 `apply.chart_*`。operator 自身步骤仍 `actor:"operator"`；designer-only 块（仅挡 loop surface）不碰 chart。**直接 meta→meta 交接 DEFERRED 到 slice-2**（届时 designer-only 字面块需由 ownership 重新派生，要对既有测试验证）。
- **服务端拖拽 ≠ localStorage node-layout（已验证不相交）**：`dashboard-drag.js:114` 存 `openclaw-node-layout`(SVG 节点, `getScreenCTM`, 主页)；chart 用新 `dashboard-draggable-widget.js`(HTML 面板, clientX/Y, charts 页, 服务端)。**陷阱**：勿原样搬 SVG 拖拽器（`getScreenCTM().inverse()` 对 HTML 面板算错偏移）。
- **`apply.chart_create` 必须 `risk:"structural"`**：否则 `maybePreApplyStructureSnapshot`(`:415` 仅快照 destructive/structural) 不自动快照 → 半失败的多写 chart create 无回滚。`apply.chart_move` 保持 `safe`（单次幂等覆盖）。
- **强制 verify 空绿**：默认 `verificationCapability.supported=true`(`admin-surface-registry.js:208`)。**D8 豁免**（步骤 19）。
- **6 触点漂移**：catalog+handler+input-fields+plan-hints+route+subject 分支同 id 无编译期链接。缓解 = 快照测试 + ownership 测试 + 注册表构建校验 + 路由最后加并冒烟 `/watchdog/charts/create`。
- **⚠ 修正 2**：viz-master **不钉 `ark-openai`**（ARK 限额有 GLM 兜底）；继承当时 `model.primary` 或落 `agents.defaults`。`resolveOperatorBrainModel` agent-agnostic 可直接复用。
- **哈希跨升级边界churn**：加 `charts` 键改变所有新快照内容哈希；旧快照(无 charts 键) verify 时显 `drifted:true`。可接受（20 深环形缓冲快速换出）。

---

## 9. 测试策略

- **快照往返测试**（步骤 5）：charts 经 capture→restore 存活 + 哈希匹配。
- **ownership 对抗测试**（步骤 12）：operator 过全部；viz-master 在 `agents.create`/`graph.*` 被拒、`apply.chart_*`/`test_run` 通过。
- **渲染单测**：`dashboard-chart-render.js` 合成 spec → 断言 SVG 结构（不依赖 live，仿既有 `dashboard-*.test.js`）。
- **回归锁**：operator 全 apply/verify 路径行为字节级不变（`operator:"*"`）。
- **门**：全程 `test-runner.js` 1729/0 保持；新增测试净加。
- **live 冒烟**：网关 kickstart 重启加载新码后，`/watchdog/charts/create` + charts 页截图（headless Chrome）验渲染/拖拽/刷新持久化。

---

## 10. 后续切片（Slice-2+，DEFERRED）

1. **动态数据 SSE**：`buildChartSeriesPayload` + `dashboard.js:1244` 加 `'chart_series'` 监听；`dataBinding.mode:"sse"` 激活。
2. **库渲染路径 + 安装人工门（D4 完整版）**：能力检测（`python -c "import altair"` / 前端 vendored 资产探测）；超声明式且无库→提示安装。需给 viz-master 加 `bash` + 静态资产路由（绕开 `^dashboard.*` 正则）。
3. **operator 直接 meta→meta 交接**：operator 计划含 viz-master 拥有的步骤，executor 检测"我不拥有此家族"→路由给 owning meta-agent；designer-only 块由 ownership 派生。
4. **`apply.chart_update`/`apply.chart_delete`** + `projectStructureAfter` chart 分支（apply 时 UI 预览）。
5. **真 chart verify**："渲染该 spec 不抛错"校验，撤 D8 豁免。
6. area/scatter 等更多图型；多图布局/缩放。

---

## 11. 开放问题

无阻塞性开放问题。D1-D9 全部锁定；两个 grounding 修正已并入构建顺序（步骤 6、23）。slice-1 可直接转 writing-plans 出实施计划。

---

## 12. 实现记录 (2026-06-07) — 全部落地 + live 验证

设计批准后分阶段实现，全程 gate 1819/0，`structure-snapshot.js` 未触碰。**14 个 commit**（branch `openclaw-system`）：

- **阶段1 后端**：`58db654` 所有权门 · `4c5a886` spec schema · `1173481` 非真值 chart 存储 · `39af83b` chart 面 + knowledge_remove 假回滚修复
- **阶段2 前端**：`1f7c935` 渲染器+拖拽 · `a2d2ec8` charts 页 · `c1e62bc` 标题对比度修复
- **1-2 审查**：`5f6c5f9` 死代码/冗余清理 · **chore** `c86651d` 删 stock-writer/reviewer
- **阶段3a viz-master meta-agent**：`aee6cb3` 定义(config+skill+actor 门接缝) · `fab8fdb` brain+knowledge+runtime+`/watchdog/viz` 路由
- **阶段3b operator→viz 委派**：`9b301db` `meta.delegate` · **3 审查** `19c8a8c` `meta.delegate` 硬化(operator-only+一跳)+死代码清理

### 关键落点（相对 spec 的精化）
- **charts = 非真值内容存储**（非第5结构真值，见顶部修正横幅）→ `lib/control-plane/chart-registry.js`，与 `knowledge-bases.json` 同级，不进 readTruths/快照。
- **viz-master = 真·第2 meta-agent**：靠拥有 `chart` surface 家族成立 —— `lib/cli-system/meta-agent-surface-ownership.js` 把硬编码 `actor!=="operator"` 门泛化成 `{operator:"*", "viz-master":["chart"]}` 注册表；控制面/用户不可见/protected。
- **operator 召唤 = `meta.delegate` 进程内委派 (R2)**：operator brain 对图表请求 emit `{surfaceId:"meta.delegate", payload:{targetActor:"viz-master", request}}` → `operator-executor` 拦截 → 进程内调 viz-master brain+executor（`actor:"viz-master"`），留在 operator 快照事务内。**非 graph 边、非 dispatch、非传送带**。委派 **OPERATOR-ONLY + 一跳深度上限**（结构保证，非提示词约定）。
- viz brain **DRY 复用** operator 的 `resolveOperatorBrainModel`/`callPlannerWithSingleRetry`/`scoreFragment`/fallbacks/normalizer。viz plan intent = `platform_mutation`（复用 operator 合法 intent 集，非自造 `chart_create`）。

### live 验证（活网关 :18789）
- **Tier-1**（确定性，无 LLM）：`POST /watchdog/viz/execute`(actor=viz-master) 写 chart ✓；`agents.create` 被 `assertActorOwnsSurface` 拒("does not own surface family agent")✓ —— 证 viz-master 真受限、不是冒充 operator。
- **Tier-2**（LLM）：`POST /watchdog/operator/plan`「用柱状图…召唤可视化专家」→ operator LLM emit `meta.delegate(viz-master)` ✓ → `operator/execute` → 进程内 viz-master 产 spec 写图 ✓ —— 证「operator 召唤可视化大师生成图表」端到端。
- **前端**：headless Chrome 截图，line(双 series)/bar/pie 渲染 + 服务端持久化拖拽 ✓。

### 延后（明确未做）
动态 SSE 实时图 · vendored 图表库 + 安装人工门 · `apply.chart_update/delete` · 预览/重生横幅 · area/scatter · 真 chart verify · 跨页 `fetchJson` helper · `normalizeText` 2/8 dedup · 协调缝 `STRUCTURAL_TRUTHS` 表(charts 非真值→未用上，独立清理) · RAG per-KB 消费者(另条线)。
