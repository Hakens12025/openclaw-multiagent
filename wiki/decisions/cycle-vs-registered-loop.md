# 检测到的环 ≠ 受控 loop；环自带 limit 复用既有 governance

> 🛑 **SUPERSEDED 2026-08-18（回路整体退役）**。本决策的**上半句已升为唯一真值**、下半句已作废：
>
> - **仍然成立**：`detectCycles` 发现环 → 前端只提示、不自动做任何事；环 = 边的形状，`GET /watchdog/graph` 的 `cycles` 是读环真相；edge = 传送带投递授权、不是时序。
> - **已作废**：`graph.loop.compose` / LoopSpec / `resolveLoopStartBudget` / `evaluateLoopBudgetGovernance` / "REGISTER CYCLE AS LOOP" 按钮 —— 全部随回路退役删除，代码不存在。
>   于是「注册成 LoopSpec 才是受控 loop」这条区分**没有了另一侧**：现在环只有一种形态，就是拓扑上的环。
> - **限流去了哪**：跑飞兜底改由 `dispatch-depth-guard`（32 跳 / 同目标 6 次）与执行硬停承担；需要"跑 N 轮"的语义由 automation governance 的 `maxRounds` 承担（`lib/automation/resolve-governance.js`）。
>
> 当前真值见 [Loop（已退役页）](../concepts/loop.md) 与 [Graph & Edge](../concepts/graph-edge.md)。以下正文保留 2026-05-31 原貌。

> ⚠️ **口径限定（v179）**：正文「## 原因」段里支撑本决策的「edge = 授权」说法，现在只对**传送带投递**一侧成立，不含动态协作。**结论（环 ≠ driven loop）不变**。以下正文保留当时原貌。

> graph 里有环只是传送带授权拓扑；只有显式注册成 LoopSpec 才是带终止语义的受控 loop。前端不自动注册；环自带 limit 复用现有 budget governance，不造第二套限流器。

## 决策

1. **检测到环 ≠ 注册 loop**：`detectCycles` 发现 graph 有环，前端只弹提示（`dashboard-graph.js` LOOP DETECTED toast），**不自动注册**。注册是单独的显式动作 `graph.loop.compose`（写 LoopSpec：entry/continue/conclude 信号 + maxRounds）。
2. **环自带 limit = LoopSpec 声明式 maxRounds**：LoopSpec 携带 maxRounds/maxExperiments，经 `resolveLoopStartBudget` 注入 loop-session budget，由**现有** `evaluateLoopBudgetGovernance` 超限强制优雅收敛（terminalOutcome=COMPLETED），即使环内无 agent 发 concludeSignal。缺省 fall-through 平台默认 3。
3. **前端注册按钮**：检测到未注册环时出现"REGISTER CYCLE AS LOOP"按钮，弹表单选 entry/conclude/maxRounds，POST `graph.loop.compose`，注册后自动撤按钮（`cyclesMatchNodesClient` 判已注册/未注册）。

## 原因

- **edge = 授权，不是时序**（传送带原则）。一个环只表示"这几个 agent 能互相投递"，不蕴含"这是一个要驱动的循环"。把"有环"等同"是 loop"会违反该原则。
- **entry/conclude 猜不出来**。LoopSpec 需要入口 agent 和收敛信号；这俩无法从纯拓扑推断（哪个是 generator？什么信号算收敛？）。自动注册=瞎猜，违反"不能猜测系统里发生了什么"红线。
- **不造第二套限流器**（一条路径）。registered loop 的 maxRounds 兜底早已存在于 budget governance；环自带 limit 只是让 LoopSpec **声明**这个 cap，复用同一条收敛路径，而非新增 timeout governor。

## 替代方案

- **前端检测到环就自动注册**（用户一度以为的旧设计，实际从不存在）：否决——见上"entry/conclude 猜不出来"。退一步给"注册按钮"让人确认 entry/conclude，是被采纳的折中。
- **为裸环（未注册）单独建并行 round/timeout governor**：否决——会出现第二套限流真值源，违反一条路径。裸环无 round 上限的 gap 刻意保留并显式标记；需要受控就注册成 loop。
- **改全局默认 maxRounds**：否决——保留 `DEFAULT_LOOP_MAX_ROUNDS=3` 为单一 floor，按需在 LoopSpec 声明覆盖。

## 影响

- [Loop](../concepts/loop.md)：LoopSpec 增声明式 maxRounds；厘清 cycle/loop 区分。
- [Graph & Edge](../concepts/graph-edge.md)：再次确认 edge=授权≠driven loop。
- 收口副产：`loop-session-normalize` 原硬编码 10/30 双真值 → 引 `loop-budget.js` DEFAULT 单一源。
- 代码：`lib/loop/{loop-budget,graph-loop-registry,loop-round-runtime,loop-session-normalize}.js`、`lib/admin/operations/admin-surface-graph-operations.js`（composeGraphLoop 转发 entry/信号/maxRounds）、`dashboard-graph.{js,css}`。

## 出处

源: 备忘录120；讨论日期: 2026-05-31；commit `3dd81b7`（v120-stable）。用户核对"前端检测环自动注册"记忆 → 代码核实从不存在，借此厘清概念。
superseded: 2026-08-18 回路退役十批（B1–B10）。
