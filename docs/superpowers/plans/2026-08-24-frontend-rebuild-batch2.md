# 前端重制 批2（透视页 + 后端两个 surface）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。Steps use checkbox syntax.

**Goal:** 实现透视区 `#/inspect`——左树（thread→run→participant）+ 右详三 Tab（混排时间线 / 提示词装配 / 输出）+ 快照切换；后端补两个 inspect surface（trace / run_join）。

**Spec:** `docs/superpowers/specs/2026-08-24-frontend-rebuild-design.md` §2.2/§3；批1 架构与纪律（core 四层、单向依赖、三态、i18n 键表、零圆角零阴影零渐变、状态色纪律）全部沿用。

**基线:** 2491 tests / 2490 pass / 0 fail / 1 skipped。`cd extensions/watchdog && npm test`。

---

## 后端（先行，两个小 surface）

### Task B1: `inspect.trace` surface

**Files:** Modify `lib/cli-system/cli-surface-inspector.js`（INSPECT_SOURCES 注册处）

- [x] 注册 `inspect.trace`：params `{sessionKey}` → 调 `lib/record-plane/record-reader.js` 的 `tryReadTraceEventsFromDb(sessionKey)`；DB 无数据时回落文件读（record-reader 已内置回落）。返回行数组（seq/ts/name/outcome/argsDigest/resultDigest/anchorRunId/anchorSeq/gseq）。
- [x] 测试 `tests/inspect-trace-surface.test.js`：种双写数据 → surface 返回行；无数据返回空数组不炸。
- [x] Commit `feat(record-plane): inspect.trace surface（trace 证据账出闸）`

### Task B2: `inspect.run_join` surface

**Files:** Modify 同上；复用 `lib/archive/run-join.js` 的 `joinRunRecords`（已带 resolveRunTarget：runId/contractId/threadId 任意入参）。

- [x] 注册 `inspect.run_join`：params `{runId|contractId|threadId}` → joinRunRecords 结果（事件账+证据账合一）。
- [x] 测试：构造 run 双写数据 → 返回含 events+traces+recordSource。
- [x] Commit

## 前端

### Task B3: 左树组件 thread-tree

**Files:** Create `ui/components/thread-tree.js` + `.css`；Test `tests/ui-thread-tree.test.js`

- [x] 数据：`api.inspect("inspect.threads", {limit})` → 选中 thread 后 `api.inspect("inspect.run", {...})` 取 run 详情与 participants。
- [x] 纯渲染：三级缩进树，节点状态点（运行中=柔橙 / 完成=暖黑 / 失败=砖红），点击回调 `onSelect({type:"thread"|"run"|"agent", id...})`。
- [x] 测试：树形渲染 + 状态色类名 + 点击回调参数。
- [x] Commit

### Task B4: 时间线组件 run-timeline（核心）

**Files:** Create `ui/components/run-timeline.js` + `.css`；Test `tests/ui-run-timeline.test.js`

- [x] 数据装配（在 page 层，组件保持纯渲染）：`inspect.run_join` 拿 events+traces；活跃 session 的思考/文本用 `inspect.session_transcript` 补。三类条目混排：◆事件 / 🔧工具（name+argsDigest+outcome，refused 砖红）/ 💭思考（截断+展开）。
- [x] 排序键：run_event 用 seq；trace 行用 anchorSeq（锚点）插入对应事件之后；transcript 条目按 ts 就近插入，**ts 永不作主排序键**（142 铁律）——transcript 与 trace 的对齐用 sessionKey+工具调用序。
- [x] 「快照/完整」切换：快照态只渲染 ◆+🔧（不看思考），完整态全量。
- [x] 点行 → 展开该行完整 payload（details 抽屉，payload JSON 美化）。
- [x] 测试：混排序正确性（含锚点插入）、快照切换、refused 标红、点行展开。
- [x] Commit

### Task B5: 提示词装配 Tab prompt-layers

**Files:** Create `ui/components/prompt-layers.js`；Test `tests/ui-prompt-layers.test.js`

- [x] 数据：`api.inspect("inspect.session_system_prompt", {agentId, sessionId})`。
- [x] 渲染：六层（framework/tools/skills/role/soul/wake）手风琴，每层标 present/source/chars，展开显示 content 全文（截断标记如实显示）；injectedFiles 列表附后；`activePath` 与 `source`（live/archive/reconstructed）角标。
- [x] 测试：六层齐渲染、缺失层显示 absent、truncated 标记。
- [x] Commit

### Task B6: 输出 Tab + inspect 页组装

**Files:** Create `ui/components/output-panel.js`、`ui/pages/inspect/inspect-page.js`、`index.js`、`inspect.css`；Test `tests/ui-inspect-page.test.js`

- [x] 输出面板：producedFiles 清单 + delivery 正文（`inspect.session_transcript` 对应字段）+ contract_seal 状态徽标。
- [x] 页组装：左树 + 右 Tab 容器 + store 接线；`#/inspect?run=<id>` 深链支持（批1 脉搏卡的跳转目标）；live 中 run 的轮询刷新（5s，页面可见时）。
- [x] 测试：路由参数→选中态、Tab 切换、三态。
- [x] Commit

### Task B7: i18n 键 + 全量回归

- [x] i18n-keys.js 补透视区全部键（双表镜像）；硬编码 lint 自动覆盖新文件（批1 守卫）。
- [x] 全量 npm test 零回归；Commit。

## 批2 完成判据

1. `#/inspect` 三区可用：树导航、时间线混排（真实 live 数据）、提示词六层全文、输出面板、快照切换
2. 从指挥台脉搏卡点 run 能深链到对应 run 的时间线
3. 单测全绿零回归；i18n 镜像 lint 绿
