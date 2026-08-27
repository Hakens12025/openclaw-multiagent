# Agent Group

> Graph 原语：空间封装。（曾与之正交的「时间原语」Loop 已于 2026-08-18 退役，时间维回落到传送带逐跳推进 + automation 轮次。）

## 是什么

AgentGroup 是 graph 系统的空间封装原语（spatial encapsulation primitive）。它定义哪些 agent 被组织在一起以及它们的输出如何聚合，但**不定义时间行为**。

### 空间 / 时间的分工（2026-08-18 更新）

| 维度 | 谁承担 | 职责 |
|------|------|------|
| 空间 | **AgentGroup** | 谁在一起、输出如何聚合 |
| 时间 | 传送带 + 图上的环（`detectCycles`）；需要「跑 N 轮」时由 automation governance 的 `maxRounds` 承担 | 重复多少次、何时终止 |

退役前时间维由 `Loop` 原语承担（LoopSpec/LoopSession/轮次/预算），[已整体退役](loop.md)。
AgentGroup 本体不受影响：它从来就只管空间。

### 三种输出模式

| 模式 | 行为 |
|------|------|
| `passthrough` | 每个 agent 的输出独立传递给下游 |
| `aggregate` | 所有 agent 输出合并为单一结果 |
| `race` | 第一个完成的 agent 输出胜出，其余取消 |

### AgentGroup 本质

AgentGroup 是一个**宏（macro）**，展开为：
- Graph edges（图边）
- Binding policies（绑定策略）

它不是新的运行时概念，而是 graph 语言的语法糖。

### Edge 显式性原则（备忘录 86 修正）

所有 group 内的边必须是显式的 `EdgeSpec`。

**没有 auth 豁免** — 即使在同一 group 内，agent 间通信也必须通过显式声明的边。这是备忘录 86 对早期设计的修正。

### Graph = 编程语言

Graph 提供的控制流原语：

| 原语 | 对应 |
|------|------|
| Sequential | 顺序执行 |
| Conditional | 条件分支 |
| Loop | 循环（图上成环即可，无独立原语） |
| Function | 子图调用 |
| Parallel | 并行执行 |
| Stream | 流式处理 |
| Race | 竞争执行 |

AgentGroup 的 `parallel` 和 `race` 输出模式直接映射到 graph 的同名原语。

## 为什么存在

- 多 agent 协作需要空间组织（谁和谁一起工作）
- 输出聚合策略需要声明式定义
- Graph 需要封装机制来管理复杂性
- 但这个封装必须透明（展开为显式边），不能成为黑盒

## 和谁交互

- **组成**: [graph-edge](graph-edge.md) — group 展开后的底层表示
- **绑定**: [agent-binding](agent-binding.md) — group 内 agent 的能力绑定
- **历史正交项**: [loop](loop.md) — 曾经的时间维原语，已退役（历史页）

## 实现

宏展开本体已落地（v119）：

- `lib/agent/agent-group-spec.js`：`normalizeGroupSpec`（members ≥ 2；`internalEdges` 两端必须都是成员，否则不是组内协作、会污染拓扑——**无 group-internal 免授权暗门**）+ `expandAgentGroup`（GroupSpec → 显式 `EdgeSpec[]` 带 `metadata.groupId`）+ `OUTPUT_MODES`（passthrough/aggregate/race，default aggregate）+ `buildOutputPolicies`。
- `lib/agent/group-session-store.js` + `lib/agent/group-session-normalize.js`：运行层追踪（在 `lib/agent/`；曾经并列的回路会话存储模块 loop-session-store 已随回路退役（v215）连同整个 `lib/loop/` 目录删除，GroupSession 现在是图上唯一的运行层会话）。
- `lib/agent/agent-workflow-grouping.js`：工作流分组。
- 可观测：`inspect.agent_groups`。

## 演化

| 阶段 | 事件 |
|------|------|
| 备忘录 85 | 定义 AgentGroup 为 graph 空间封装原语 |
| 备忘录 86 | 修正：所有 group 边必须显式，无 auth 豁免 |
| v119-stable | AgentGroup 宏展开本体落地（与当时的 loop 时间维度正交，space × time）；对抗 7 红线验证组内未声明边真被拒。tasks #38 + #46 done |
| 2026-08-18 | 回路退役：时间维原语 Loop 整体下线，AgentGroup 成为图上唯一的成组/成会话原语；`pruneGroupSessionsForTopology` 接进 agent 删除的拓扑级联 |

## 当前状态

- **设计**: 冻结
- **实现**: 已落地（v119 宏展开；`inspect.agent_groups` 可观测）
- **来源**: 备忘录 85, 86 + v119 实现

相关概念: [graph-edge](graph-edge.md) | [agent-binding](agent-binding.md) | [loop（已退役）](loop.md)
