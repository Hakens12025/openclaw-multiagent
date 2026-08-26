# CLI System

> 系统正式可操作表面层。不是新的协议族，不持有业务真值。

## 是什么

`CLI system` 统一表示系统的五类正式表面（surface family）：

| Family | 方向 | 职责 |
|--------|------|------|
| `hook` | 入 | 平台事件接入点 |
| `observe` | 读 | 流式/订阅式观测 |
| `inspect` | 读 | 拉取一次 runtime 真值快照 |
| `apply` | 写 | 形成治理动作（dispatch 到执行/控制面） |
| `verify` | 写后读 | 验证治理动作结果 |

读路径与写路径对称：
- 写：`lib/cli-system/cli-surface-executor.js`（apply/verify dispatch）
- 读：`lib/cli-system/cli-surface-inspector.js`（inspect dispatch，入口 `inspectCliSystemSurface`）

它的职责是把 runtime truth 暴露成稳定入口，供人、operator、automation 读取和操作。

## 全族收口：每个 family 的真值边界（v111 完成）

观测读取必经 surface；变更必经统一变更执行器。五族各自的边界：

| Family | 真值边界 | 收口结论 |
|--------|---------|---------|
| `inspect` | `cli-surface-inspector.js`（`inspectCliSystemSurface`） | 观测读取唯一碰 store 入口；operator + HTTP read-route 都经它 |
| `observe` | 声明式，**无需独立 dispatch** | 其中的观测读经 inspect surface；实时推送本身是 transport |
| `apply` | `lib/admin/operations/admin-surface-operations.js`（`executeAdminSurfaceOperation`，统一变更执行器） | 所有变更必经它；executor 是 operator 专用守卫通道叠在其上 |
| `verify` | 经 admin-operations 执行 | **0 旁路**；harness gate/评审判定是 verify owner 自驱 |

### inspect：观测读取唯一碰 store 的入口

operator（13/13，v109）+ HTTP read-route（v110）都经 inspect surface，是同一条读路径的两个消费者。

v112 起新增统一 HTTP 投影 `GET /watchdog/inspect?surface=`（`routes/api.js`）：取到 surface 后校验 `family==="inspect"`，否则 **403**（红线：不允许经此调 apply/admin）。配套 `POST /watchdog/reveal-file`（`lib/agent/agent-reveal-file.js`）在文件管理器定位 transcript 引用文件——严格白名单 `~/.openclaw/{workspaces,control-plane,contracts,agents}`，`resolve` 后 `startsWith(root + sep)` 防逃逸，`execFile("open","-R")` 不走 shell。

### observe：读经 inspect，推是 transport

observe 不需要独立 dispatch。其观测读（SSE `/watchdog/stream` 的 `listTrackingStates` / `getRecentTaskHistory`，`/watchdog/capability-registry` 的 `loadCapabilityRegistry`）改经 inspect surface；**实时推送（broadcast / SSE push）是 transport** —— payload 由 caller 现成构造，不存在“经 surface 读 store”语义，故 observe surface 维持声明式。

### apply：admin-operations 是真值边界，executor 是 operator 通道

**apply 真值边界 = `executeAdminSurfaceOperation`（统一变更执行器）**，所有变更都经它。`cli-surface-executor.js` 的 `executeCliSystemSurface` 是叠在其上的 **operator 专用守卫通道**（强制 `actor=operator` + `operatorExecutable`）。

HTTP routes 直调 admin-operations = 合法（同一变更原语的另一 caller，非第二真值路径）。故 ~42 个 admin POST route **不算旁路、不收口** —— 强行经 operator executor 反而会削弱守卫、混淆 actor。

### owner-vs-observer 判据（全族统一）

| 类别 | 处理 | 例 |
|------|------|----|
| **观测读**（read-for-observation） | = 旁路，**必经 inspect surface** | operator snapshot、HTTP read-route、SSE 里的观测读 |
| **engine 控制流自取/自写真值** | 合法直读 | automation / ingress / schedule / admin 执行器 / dispatch-reconcile |
| **truth-assembler** | 合法直读（组装 registry） | `lib/management/capability-registry.js` |
| **协议边界 / transport** | 合法直读 | a2a（协议）、broadcast / SSE push / `getSseClientCount`（transport） |
| **纯算法** | 合法直读 | `detectCycles` |

## 冻结的接口

v109-stable 起，surface 注册/编目时**非静默拒绝**不合规项：

- `lib/cli-system/cli-surface-schema.js` 的 `validateCliSurface`：必填 `id` / `family`∈{hook,observe,inspect,apply,verify} / `source` / `status`。
- 编目落在 `lib/cli-system/cli-surface-catalog.js`，统一 registry 在 `lib/cli-system/cli-surface-registry.js`。
- 当前静态 catalog 的 `inspect.*` 共 **36 个**（2026-08-19 实测 `lib/cli-system/cli-surface-catalog.js`；本文不复刻清单——以文件为准）。
  历史沿革：v109 起编目，v110/v111/v112 逐批扩充；**2026-08-18 回路退役删掉 3 个**（`inspect.graph_loops` / `inspect.loop_sessions` / `inspect.active_loop_session`），同期 archive/knowledge 两族新增若干。surface 总量的 live 下界钉在 `SURFACE_REGISTRY_FLOORS`（`health` 的 `inspect.surface-registry` 检查），改动 surface 族必须同批更新它。
- **apply / verify 族已编目，不是缺 catalog**：surface 落在 `lib/admin/catalog/apply-rest.js`（`stage:'apply'`/`'verify'`）+ `agents-apply.js`，经 `cli-surface-registry.js` 的 `normalizeAdminSurface` 归一进 CLI family —— family **从 `stage` 字段派生**（不是因为缺 catalog 而归 inspect）。携带 `operatorExecutable:true` 的 surface 见 `lib/admin/catalog/`（2026-08-09 抽样：apply-rest 40 + agents-apply 10 = 50）。operator 落地**不再走 admin-surface 旁路**：executor（`cli-surface-executor.js`）硬要求 `operatorExecutable=true`，而这些 surface 真实存在。[四关节自治闭环](self-governance-loop.md) 的**死链 (b) 已闭**。

### capability-registry 刻意不收口

`capability-registry` 是 truth-assembler（组装 agent/capability registry），且若经 surface 会形成 `capability-registry → cli-surface-registry → inspector → admin-change-sets → capability-registry` 的 TDZ 循环依赖。故归类**合法直读**，刻意不迁。

### 把守随边界上移

guard 测试新增 `cli-runtime-inspector` 把守（禁 raw state globals + 必经 `dispatch-runtime-state` 正源），`routes/api.js` 的 required surface 改为 `inspect.runtime_state`。

### 死重复写路由删除（v111）

`/watchdog/graph/edge`（bare POST/DELETE）已被 `/add` + `/delete`（经 admin-operations 的 `mutateGraphEdge`）取代，仓内零 consumer，按不留遗留删除。graph edge 变更现仅一条路径。

## 不是什么

- 不是 `dispatch / system_action / delivery` 的第四条协议族
- 不是新的 runtime truth owner
- 不是 shell 命令集合
- 不是第二控制器

## 和谁交互

- 向下：读取 runtime truth（inspect/observe），写治理动作（apply/verify 经 executor 走 dispatch）
- 向上：供 [Operator](operator.md) 读真值、后续 automation 消费
- 平行：可投影 [Harness](harness.md) 的结果（`inspect.harness_runs`），但不替代 `HarnessRun`

## 演化

- v112 之后: inspect 静态 catalog 22→26 —— 新增 `inspect.profile_lifecycle`（ProfileLifecycle 治理观测）/ `inspect.agent_groups`（AgentGroup 观测）/ `inspect.structure_preview`（operator build plan 终态预览）；apply/verify 族在 admin catalog 编目，~38 携带 `operatorExecutable=true`，operator executor 落地真接通（死链 b 闭合）。
- 备忘录 114 §6: 概念预算纪律 — 先冻结 surface/module 接口，不继续扩张术语。
- v109-stable: 新增 `cli-surface-inspector.js` 补齐读路径，与写路径对称；`validateCliSurface` 上线，注册/编目非静默拒绝不合规项。operator 全部读取改经此层（见 [Operator](operator.md) 零旁路红线）。源: 备忘录112/113/114。
- v110-stable (P-G): 系统级旁路收口 —— 10 个 HTTP read-route 全改经 inspect surface，确立「inspect surface = 观测读取唯一碰 store 的入口」；明确观测视图/owner 判据；新增 2 个 surface（14→16）；guard 把守上移到 `cli-runtime-inspector`。
- v111-stable (P-H): 全族收口 —— observe 的观测读改经 inspect（推送维持 transport），裁定 apply 真值边界=admin-operations、executor=operator 通道（~42 admin POST 不收口），verify 0 旁路；inspect 16→19；删除死路由 `/watchdog/graph/edge`。
- v112 (P-WF): 工作流页可观测 —— inspect 19→22（agent_workflows / agent_sessions / session_transcript），新增 inspect 家族 HTTP 投影 `GET /watchdog/inspect`（403 挡 apply）+ `POST /watchdog/reveal-file`（白名单防逃逸）。见 [Dashboard](dashboard.md) 工作流页。

## 当前状态

- 概念：稳定
- 代码：五族真值边界已全部裁定并收口；inspect 静态 catalog 26 个（活跃 family 视图 44）；apply/verify 已编目，~38 携带 `operatorExecutable=true`，operator executor 落地接通
- 待补：更多 surface 家族、统一前端消费
