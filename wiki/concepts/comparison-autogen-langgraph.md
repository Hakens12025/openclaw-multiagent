# OpenClaw vs AutoGen Studio vs LangGraph（设计参照）

> 三种"谁来编排流程"的哲学对照，用于定位 OpenClaw 的取舍。外部系统认知，非本系统真值。

## 核心定位差异

- **LangGraph**：图 = 程序控制流（状态机）。边决定下一节点（可条件），节点间穿**共享可变 State**（TypedDict + reducer）；checkpoint 快照支持 time-travel / human-in-loop。
- **AutoGen v0.4**：异步 actor + 对话驱动。Team(GroupChat) 里 manager/selector（常为 LLM）决定下一个 speaker；消息投递与处理解耦；Studio 提供拖拽 builder + flow 可视化。
- **OpenClaw**：**传送带**。图边 = **授权**（谁可投给谁），**非控制流/时序**；时序靠平台（排队→闲时投递→唤醒）。agent 间异步消息（inbox/outbox），非共享 state、非对话；**contract = 唯一真值**；**代码管流程 / LLM 管内容**（回路禁硬编码 agentId）。

## 关键轴对比

| 轴 | LangGraph | AutoGen v0.4 | OpenClaw |
|----|-----------|--------------|----------|
| 控制流编排 | 图边（程序，可条件） | LLM selector 选 speaker | 平台（排队/闲时投递/唤醒）；图边只是授权 |
| 状态真值 | 共享可变 State（TypedDict+reducer） | 对话消息历史 | contract（唯一真值） |
| agent 是什么 | 节点 = 函数 | 对话实体 | prompt-driven 工作区单元（读 inbox→产出 outbox→停） |
| 代码 vs LLM 职责 | 代码定义图，LLM 在节点内 | LLM 兼管时序（选 speaker） | 严格分离：代码管流程，LLM 只管内容 |
| 循环 | 图中的环 + 条件边 | 对话轮次直到终止条件 | 传送带沿图上回边重复投递（`detectCycles` 识环，无独立回路运行时） |
| 持久化/调试 | checkpoint + time-travel 重放 | 消息日志 | contract + transcript + 工作流页回放 |
| 部署 | 库 / LangGraph Platform | 库 + Studio IDE | OpenClaw 插件（gateway 运行时） |

## OpenClaw 独特点 + 取舍

**独特点**：授权与时序解耦 + 代码/LLM 严格分离 → 加 agent 不改流程代码、单一真值、拓扑可迁移。

**取舍**：无开箱即用的共享 typed state + checkpoint/time-travel；**故意不让 LLM 编排时序**（为确定性）。

## 可学（差距）

- LangGraph 的 time-travel / checkpoint 分叉重放、显式 typed state。
- 两家成熟的可视化 IDE（AutoGen Studio / LangGraph Studio）。

## 落到工作流页

我们的拓扑 + SSE 实时高亮 ≈ 它们的图执行态可视化（见 [Dashboard](dashboard.md) 工作流页）。

**我们独有的两层**——系统提示词如何拼装、用户最终接收消息（终端投递）——在 LangGraph（节点=函数）/ AutoGen（agent=对话实体）里不存在，因为我们的 agent 是 prompt-driven 工作区单元。

## 和谁交互

- [传送带原则](conveyor-belt.md)：授权 vs 时序解耦的根。
- [CLI System](cli-system.md)：正式可观测表面，对应它们的"图执行态"读取。
- [Operator](operator.md) / [Harness](harness.md)：四关节（Harness→CLI→Operator→Automation）是 OpenClaw 的治理消费链，两家无对等物。
- [外部参考吸收策略](../decisions/external-reference-absorption.md)：吸收外部系统的既定纪律。

## 2026-08-11 增补:执行机制专项取经(源: 备忘录139)

- **OpenAI Agents SDK 的二分**:Agents-as-Tools(编排者握对话,子 agent 返回结果)vs Handoffs(单向移交不回报)。我们的两平面各对应其一:固定管线=handoff,动态派工=agent-as-tool——二分是行业收敛,不是本系统怪癖
- **Anthropic 研究系统**:编排者-工人+并行扇出(3-5 子 agent),+90.2%/~15x token;最痛教训是**派工提示词质量**(scale effort to query complexity)
- **LangGraph 反面教材**:"checkpoint ≠ durable execution"——快照有了,何时用/如何防重复副作用全是使用者的事
- **Temporal 三纪律**:编排与副作用分离/非确定性结果记录后复用/外部调用幂等键。2026 已与 OpenAI SDK、Google ADK 集成
- **A2A(Linux 基金会 v1.0.1)背书我们三件事**:contract≈Task、artifact-store≈Artifact、agent-card≈Agent Card;其任务终态**无等待输入暂停态**,与 v190 删 AWAITING_INPUT 同向

## 外部来源

- AutoGen Studio（Microsoft Research blog）
- AutoGen v0.4（Microsoft blog）
- Victor Dibia — AutoGen Studio v0.4
- LangGraph Graph API docs

## 当前状态

参照页，稳定。外部系统认知随其版本演化，更新时核对来源。
