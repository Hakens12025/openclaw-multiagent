# 前端重制设计文档 · OpenClaw Dashboard（2026-08-24，用户已裁决）

> 状态：**已完工（2026-08-25，批1-4 全清）**。批1/2 由 Kimi Code 施工；批3/4 由 ZCode 收口。
> 2026-08-25 追加裁决：全谱 NASA-punk 上色（推翻 §4 限色，tokens 五语义色+底色层次）、
> 黑色系对比度回调、读数带单条带重设计、编排图交互三件套（拖动/连线/删边）。
> 判据核验：旧 9 页零残留(grep 无引用)、/watchdog/ 转正新 SPA、三区 live 手验通过。
> 背景侦察：现有前端为零构建原生 MPA（9 HTML 入口，dashboard/ 55 文件 21,279 行），三套架构并存、i18n 半拉子、全局状态横飞、九页平铺无信息架构。数据面侦察结论：全链路透视所需数据几乎全部已有接口，只缺两个 surface（各约 5 行）。

## 0. 裁决记录（用户逐点拍板）

| # | 决策点 | 裁决 |
|---|---|---|
| 1 | 技术路线 | **零构建原生 ESM 重构**（不引入构建链/框架） |
| 2 | 信息架构 | **三区模型**：指挥台 / 透视 / 管理（9 页收 3 区；工作流页解散，拓扑编辑并入指挥台、session 查看器并入透视；运行账页并入透视） |
| 3 | 透视页形态 | **A+B 结合**：左树（thread→run→agent）+ 右详，默认 Tab = 三账混排时间线，提示词装配一等 Tab，「快照/完整」切换 |
| 4 | 主页右栏 | **脉搏+哨兵混合**：LIVE PULSE 卡为底，异常时砖红 ATTENTION 卡置顶（解决即消失），日志流降级底部抽屉 |
| 5 | 编排动效 | **合约卡滑行**（交接=合约卡实体沿边移动，排队=卡片堆叠增高） |
| 6 | 风格 | **底暖点冷·柔化版**：米底 + 暖黑/砖红/柔橙点睛 |
| 7 | 双语 | **全覆盖**（硬编码=缺陷，lint 守门）+ **即时无刷新切换** |

## 1. 架构（教科书分层，单向依赖）

从 9 个 HTML 的 MPA 改为**单页应用**：一个 HTML 壳 + hash 路由（`#/`、`#/inspect`、`#/manage/*`）。

```
extensions/watchdog/ui/
├─ core/
│  ├─ store.js      状态仓：单一数据源，发布订阅；SSE/轮询只写 store，组件只读 store
│  ├─ api.js        服务层：所有 HTTP fetch 与 SSE 连接的唯一收口
│  ├─ i18n.js       键表 + 响应式 t()；lang 变化触发重渲染（无刷新）
│  └─ tokens.css    设计 token 唯一定义处
├─ components/      纯渲染组件：props 进、DOM 出、零副作用、零 fetch
├─ pages/
│  ├─ command/      指挥台
│  ├─ inspect/      透视
│  └─ manage/       管理区（agents/knowledge/charts/control-plane/devtools 五子页）
└─ app.js           入口 + hash 路由 + 接线
```

**铁律**：
- 组件不直接 fetch、不直接订阅 SSE——一切数据经 store（单向数据流）
- 禁止 `window.*` 全局槽位跨模块通信（现状 5+ 处全消灭）
- 禁止 HTML `onclick` 字符串桥，统一 `data-action` 事件委托
- 每个组件必定义三态：loading / error / empty

## 2. 页面设计

### 2.1 指挥台 `#/`
- 顶栏：统计读数带（粗边框格、大数字、状态色上数字）
- 左栏：工作项生命周期列表（数据源 `/watchdog/work-items`，沿用现有轮询语义）
- 中栏：**编排图**。节点=agent（粗边框卡），边=传送带。**交接动画**：合约卡实体沿边滑行（offset-path 贝塞尔），到达时目标节点边框加厚"吸入"。**排队动画**：合约卡在目标入口左侧堆叠增高。动效语义纪律：动=有事在传，静=无事
- 右栏：**LIVE PULSE**。活跃 run 的迷你链路卡（实时滚动工具调用/思考状态，点击跳 `#/inspect` 对应 run）；异常时砖红 ATTENTION 哨兵卡置顶（信号源：refused 尖峰 / SSE error 告警 / 队列淤积 / 链尖报警；出现即插入、解决即消失、带「查看证据/忽略本次」）
- 底部：日志流抽屉（原事件流降级，默认收起）

### 2.2 透视 `#/inspect`
- 左树：thread → run → participant（树账原生形状），选中驱动右侧
- 右侧 Tab：
  - **时间线**（默认）：◆run 事件账 + 🔧trace 工具调用 + 💭transcript 思考，三账按 gseq/锚点对齐混排；点行看完整内容；「快照/完整」切换（快照=只工具+输出摘要）
  - **提示词装配**：六层（framework/tools/skills/role/soul/wake）逐层展开全文 + injectedFiles 正文（数据源 `inspect.session_system_prompt`）
  - **输出**：产物 + 投递正文（`inspect.session_transcript` 的 delivery/producedFiles）
- run 全景：run_events + run_causality（因果图）+ contract_seal

### 2.3 管理 `#/manage/*`
五个子页（agents/knowledge/charts/control-plane/devtools）收进统一子导航壳，页面内容本期以迁移重组为主（统一接入新架构四层），逐页深化留后续。

## 3. 后端最小新增

- `inspect.trace` surface：sessionKey → records.db 的 trace_event 行（复用 `tryReadTraceEventsFromDb`）
- `inspect.run_join` surface：threadId+runId/contractId → `joinRunRecords` 全景装配（复用现成函数）

## 4. 设计 token（柔化版，tokens.css 单一定义）

```
--bg:        #FEF9EC  米白底
--ink:       #2E2A24  暖黑（结构/标题/主按钮）
--alert:     #B05C4C  砖红（异常/危险/哨兵）
--active:    #C08A5A  柔橙（进行中）
+ 字号阶梯（9/10/11/20/22 档位）、间距阶梯（4/8/12/16）、边框规格（2px 结构线/1px dashed 分隔）
```

纪律：零圆角、零阴影、零渐变；状态色只有柔橙/砖红/暖黑三个语义；字体等宽（Courier New 族）。

## 5. i18n 标准

- 所有 UI 文案走键表（`t(key)`），硬编码 = 缺陷
- 键表 en-US / zh-CN 完全镜像；**lint 守卫**：双表键集一致性 + 源码硬编码中文扫描，进 npm test
- 切换即时无刷新：lang 是 store 状态，变更触发重渲染
- 默认 zh-CN，localStorage 持久化

## 6. 错误处理与测试

- api.js 统一错误归一（网络错/鉴权错/数据错），组件只消费标准错误形
- 测试（tests/ui-*.test.js）：纯渲染组件 props→DOM 断言；i18n 双表镜像 + 硬编码 lint；store 状态迁移单测
- 沿用既有 npm test 套件，新测试进同一套

## 7. 旧资产处置

- 旧 9 页并存期不动，批4 整删
- `routes/dashboard.js` 的服务端字符串改写缓存 hack（versionDashboardHtml）随新 SPA 转正后删除——新架构用内容 hash 文件名或 `?v=` 统一在壳层解决
- harness 兼容折叠、pipeline 术语死键、i18n 死键等祖传残留随旧页入土

## 8. 分批施工（每批独立验收）

| 批 | 内容 | 验收 |
|---|---|---|
| 1 | 架构底座（core 四层 + hash 路由 + 壳 + tokens + i18n 骨架）+ 指挥台区全功能 | `/watchdog/next` 可用：编排图动画、工作项、LIVE PULSE、哨兵卡、日志抽屉；新单测全绿 |
| 2 | 透视页 + 后端两个 surface | 左树右时间线 + 提示词六层 + 快照切换；live 数据实证 |
| 3 | 管理区五子页迁入新架构 | 五子页功能对齐旧页 |
| 4 | 旧 9 页删除 + 字符串改写 hack 删除 + 新 SPA 转正为 /watchdog/ | 旧 dashboard 零残留；grep 无旧页引用 |

完成判据（整体）：旧 9 页删除、i18n 全覆盖 lint 绿、三区在 live 网关全功能手验通过。
