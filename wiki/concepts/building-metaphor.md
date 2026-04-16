# Building Metaphor

> OpenClaw 系统是一栋多 Agent 大楼：Controller 是前台，其他 Agent 是办公室，LLM 是内容生产线，监控/投递/分发/兜底是"走廊和电梯"（hard-path）。

## 是什么

将整个多 Agent 系统比喻为一栋大楼的空间隐喻模型：

- **Controller** = 前台/接待处 — 接收外部请求，决定分派方向
- **其他 Agent** = 独立办公室 — 各自有明确职责，互不串门
- **LLM** = 内容生产线 — 负责文本生成，不负责流程控制
- **监控/投递/分发/兜底** = 走廊和电梯 — 系统级 hard-path，不依赖 LLM

关键扩展：

- **system_action**: "访客可以直接去办公室" — 不必经过前台（Agent 可主动调用平台操作）
- **Parcel Model**（备忘录72）: 像邮政系统，有正向运单（contract）和回程运单（replyTo）

## 为什么存在

- 提供统一的心智模型，让所有参与者用同一套语言讨论系统架构
- 明确区分"谁负责什么"以及"消息怎么流动"
- BUILDING-MAP.md 从运行时真值自动生成，保证隐喻与实际拓扑一致

## 和谁交互

| 概念 | 关系 |
|------|------|
| [Three-Layer Protocol](three-layer-protocol.md) | 大楼内部的通信规则 |
| [Conveyor Belt](conveyor-belt.md) | 大楼内的传送带系统 |
| [Workspace Guidance](workspace-guidance.md) | 大楼导航文件（黄页、楼层图） |
| [Context Isolation](context-isolation.md) | 办公室之间的隔墙 |

## 演化

1. 备忘录50：正式提出 Building Metaphor，引入 BUILDING-MAP.md（运行时真值自动生成）
2. 备忘录72：引入 Parcel Model — contract 是正向运单，replyTo 是回程运单
3. 备忘录99 §1.5：隐喻进一步固化为系统设计语言

## 当前状态

**已固化。** BUILDING-MAP.md 由 `syncRuntimeWorkspaceGuidance()` 在 Gateway 启动时自动生成。Parcel Model 已实现。隐喻用于所有架构讨论。
