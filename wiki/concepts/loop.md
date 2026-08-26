# Loop（已退役 2026-08-18）

> **本页是历史页，不是当前真值。** 回路机制已整体退役：`LoopSpec` / `LoopSession` / `start_loop` /
> `advance_loop` / `graph.loop.*` / `runtime.loop.*` / `lib/loop/` 全部不存在。
> 当前真值见 [Graph & Edge](./graph-edge.md) 与 [Conveyor Belt](./conveyor-belt.md)。

## 现在的替代物（一句话）

**图上成环 = 传送带沿回边重复投递。** 环只是边的形状，`detectCycles`（`lib/agent/agent-graph.js`）
负责识别，前端据此高亮并弹「检测到环」，提示词装配据此写出「当前显式回路」段。
除此之外没有回路对象、没有注册表、没有轮次、没有回路预算。

| 退役前 | 现在 |
|---|---|
| `graph.loop.compose` 注册 LoopSpec | `graph.edge.add` 把末跳连回入口即可，平台自动识别环 |
| `runtime.loop.start` 起一轮 | 用户/ingress 把任务投进入口 agent 的 inbox，传送带逐跳推进 |
| LoopSession 持有 round/stage/budget | `contract.stageRuntime` 持有当前环节；轮次由 automation 承担 |
| `loop-budget.js` maxRounds/maxExperiments | 迭代预算归 automation governance（`resolve-governance.js` 的 `maxRounds`） |
| loop 跑飞由 budget governance 兜底 | `dispatch-depth-guard`（32 跳 / 同目标 6 次）+ 执行硬停（重复工具调用指纹） |
| AgentGroup 是「空间」、Loop 是「时间」 | AgentGroup 仍是空间原语；时间维由传送带逐跳推进 + automation 轮次承担 |

## 为什么退役

回路曾被设计成「conveyor dispatch 之上的重复执行机制」，但它实际长成了第二套并行真值：
自己的注册表（`graph-loop-registry.json`）、自己的会话态（`loop_session_state.json`）、
自己的预算器、自己的 admin/CLI/HTTP 表面、自己的 agent_end 推进分支。
这直接违反「一条路径原则」——同一件事（让任务在图上反复走）有了两条实现。
退役后只留一条：传送带按图边投递，环由 `detectCycles` 识别。

**保留下来的能力（用户明确要求）**：识环。`detectCycles` / `hasDirectedEdge` / `loadGraph`、
`GET /watchdog/graph` 的 `cycles` 字段、dashboard 的 `normalizeGraphCycles` / `highlightCycles` /
`isLoopBack` 回边几何、提示词的「当前显式回路」段——一个都没删。

## 命名警告（同名不同物）

退役后代码里仍有大量 `loop` 字面量，它们**与本页描述的图回路无关**，分属两族：

1. **执行硬停**（L3 沙箱安全闸）：`lib/runtime/execution-hard-stop-registry.js`、
   `lib/runtime/session-epoch-key.js`、`hooks/after-tool-call.js` 的重复工具调用检测、
   `[LOOP DETECTED]` 标记、`loop_warning` / `loop_detected` 事件、`E-*` 里的 hard stop 措辞。
   这是"agent 卡在同一个工具调用上转圈"的意思，不是图回路。
2. **自治回路 / 工具回路**：`autonomy-loop-semantics`、"Inspect-Apply-Verify Loop"、
   [四关节自治闭环](./self-governance-loop.md)、`knowledge-toolface.js` 的 "tool loop"。
   这是控制面的反馈闭环，也不是图回路。

## 演化

1. 备忘录65 开始讨论循环机制，将历史编排概念向 loop 迁移
2. 备忘录69 loop-session 成为真值源，旧 Path B 删除
3. 备忘录74 提出判别式循环 / GAN-like 模式（researcher → worker → evaluator → …）
4. 备忘录92 正式提出旧编排引擎收口计划，loop-session 吸收决策逻辑
5. v120-stable: LoopSpec 自带 `maxRounds`/`maxExperiments`
6. v121-stable: reviewer 控制环（早停/强停）+ heartbeat artifact-branch idle 误判修复
7. **2026-08-18（B1–B10 十批）：整体退役**。`lib/loop/` 七文件、`suite-loop.js`、
   admin/CLI/HTTP 回路表面、agent_end 回路推进分支、automation 回路腿、
   控制面第 4 份结构真值、`loop` 测试预设全部删除；错误码 114→105；
   structure snapshot 4 真值→3 真值。

## 和谁交互（历史）

- [Conveyor Belt](./conveyor-belt.md)：曾经每次迭代就是一次 conveyor dispatch；现在直接就是 conveyor dispatch
- [Graph & Edge](./graph-edge.md)：环的真值所在，**当前真值页**
- [AgentGroup](./agent-group.md)：空间原语，退役后成为图上唯一的成组原语
- [四关节自治闭环](./self-governance-loop.md)：第二族命名，与本页无关

## 当前状态

**已退役**。本页仅供理解历史决策与命名来源；任何按本页描述去找代码的动作都会扑空。
