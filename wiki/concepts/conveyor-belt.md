# 传送带原则 (Conveyor Belt)

> 唯一的 transport 原语：agent 读 inbox → 处理 → 写 outbox → 停止。平台检查 graph 授权 → 排队 → 投递 → 唤醒。

## 是什么

传送带是系统内所有消息投递的统一模式。回路保持 graph-driven 和通用 transport 语义。

- Agent 只负责：读 inbox → 处理 → 写 outbox → 停止
- 平台只负责：检查 graph 授权 → 排队 → 目标闲时自动投递 → 唤醒
- Graph edge = 授权（谁能投给谁），不是时序控制
- Loop = 传送带重复投递，不是独立协议
- 结果回传走 replyTo 路由元数据，不走 graph
- **产物也走传送带**：上游产物以「包」随 contract 流到下游 `inbox/upstream/<producer>/`，agent 只读自己 inbox（见 [产物整包流转](../decisions/artifact-package-flow.md)）

## 为什么存在

防止系统退化为"多条专用管道胶在一起"。备忘录 90 诊断出的核心问题就是违背了传送带原则：旧 pool、旧 graph routing、旧 loop 编排、before-start-ingress 各自造了一套投递逻辑。

## 实现约束

- Dispatch 逻辑基于 graph edge 和 runtime metadata
- 相似路径收敛到统一 transport 流程
- 特定需求通过可迁移的 runtime surface 表达
- 通用代码保持真实通用，不承载隐藏专用分支

## 和谁交互

- [三层通讯协议](three-layer-protocol.md) — 三层都基于传送带模式
- [硬路径与软路径](hard-soft-path.md) — 传送带属于硬路径
- [合约 (Contract)](contract.md) — 传送带投递的载体
- [产物整包流转](../decisions/artifact-package-flow.md) — 产物维度的传送带延伸

## 演化

- 项目早期即确立。
- v48-stable: 历史编排推进收敛 + loop 真相源，向传送带统一迈进。
- v52-stable: 统一分发 dispatch。
- 备忘录 90: 诊断出代码已再次偏离传送带原则，提出重构红线。

源: CLAUDE.md §传送带原则, 核心设计指标, 备忘录90 §一

## 当前状态

永久原则。代码层面仍有偏离（备忘录 90 诊断），待重构收敛。
