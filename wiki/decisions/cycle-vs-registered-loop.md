# 检测到的环 ≠ 受控 loop；环自带 limit 复用既有 governance

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
- 代码：`lib/loop/{loop-budget,graph-loop-registry,loop-round-runtime,loop-session-normalize}.js`、`lib/admin/admin-surface-graph-operations.js`（composeGraphLoop 转发 entry/信号/maxRounds）、`dashboard-graph.{js,css}`。

## 出处

源: 备忘录120；讨论日期: 2026-05-31；commit `3dd81b7`（v120-stable）。用户核对"前端检测环自动注册"记忆 → 代码核实从不存在，借此厘清概念。
