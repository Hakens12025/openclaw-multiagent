# Contract

> 系统中的工作单元，携带执行者、回程目标、和完整的分发链路。

## 是什么

Contract 是 OpenClaw 中一切工作的基本载体。每个 contract 代表一个需要被某个 agent 执行的任务。

**核心字段**：
- `assignee` — 谁执行这个 contract
- `replyTo` — 结果返回给谁
- `contractId` — 唯一标识
- `dispatchChain` — 消息源链路记录，用于自动注入 replyTo

**Agent 身份判定**：通过 agentId 硬判定（KNOWN_GATEWAYS 白名单），不依赖 LLM 自报身份。

**生命周期**：
```
PENDING → running → completed / failed / abandoned
```

- DRAFT 状态已被消除（备忘录96）：ingress 直接创建 PENDING 状态的 contract
- 不再有 "草稿等待确认" 的中间态

**备忘录100 提出的 5 对象链（规划中）**：
```
ContractDefinition → ExecutionObservation → TerminalOutcome → DeliveryPayload → LifecycleProjection
```

**已知结构性不适**：stagePlan 字段混合了定义（应做什么）和运行时进度（做到哪了），违反关注点分离。

## 为什么存在

- 统一工作单元：无论来自用户消息、agent 协作、还是自动化触发，都通过 contract 承载
- 可追踪：contractId + dispatchChain 让任何消息都能溯源
- 硬判定身份：防止 LLM 幻觉导致身份混淆

## 和谁交互

- [Three-layer Protocol](./three-layer-protocol.md)：contract 在三层协议中流转
- [Conveyor Belt](./conveyor-belt.md)：conveyor 负责 dispatch contract 到目标 agent
- [Delivery](./delivery.md)：contract 完成后结果通过 delivery 系统投递

## 演化

1. 核心设计指标 §四 确立 contract 为工作单元
2. 备忘录96 消除 DRAFT 生命周期——ingress 直接创建 PENDING
3. 备忘录100 提出 5 对象链重构方向，将 contract 拆分为定义/观测/终态/投递/投影

## 当前状态

**核心机制稳定运行**。DRAFT 消除已落地。stagePlan 的定义/运行时混合问题已识别，5 对象链重构尚在规划中，未开始实施。
