# Session Management

> Contract 无关的独立会话设计——同一 contract 的不同 agent 在独立 session 中工作。

## 是什么

Session Management 定义了 contract 执行过程中的会话隔离策略。

**用户核心设计**：
- 单个 contract 使用独立 session 作为处理空间
- 例：Contract 1241237 → planner 在 session1241237 中处理，后续 agent 使用同一 session
- 框架支持自定义 session key：
```javascript
runtimeWakeAgentDetailed(agentId, reason, api, logger, {
  sessionKey: `contract:${contractId}:${targetAgent}`
})
```

**三层分离**：

| 层 | 标识 | 用途 |
|----|------|------|
| Identity | roleId / agentId | 我是谁 |
| Session | sessionId / sessionKey | 我在哪个工作空间 |
| Memory | 独立 | 我记住了什么 |

**当前状态**：
- runtime 已支持 session 级 heartbeat / wake，`dispatch` 与 `delivery` 都能直达指定 `sessionKey`
- user→agent 与 agent→agent 已不再强行共用默认 session
- `runtime-bridge` 的历史问题已通过统一到 `delivery` 体系消除

## 为什么存在

- 防止上下文污染：不同 contract 的上下文不应混入同一 session
- 支持并发：多个 contract 可以同时执行，需要独立的工作空间
- 解除 delivery 统一的阻塞：session 级精度让 agent return 不必再伪装成新 contract

## 和谁交互

- [Delivery](./delivery.md)：session management 是 delivery 统一的关键阻塞
- [Contract](./contract.md)：session 为 contract 提供执行空间
- [Context Isolation](./context-isolation.md)：session 隔离是上下文隔离的实现机制（如已存在）

## 演化

1. 备忘录99 §二 正式提出 contract 无关的独立 session 设计
2. v71 确定 deterministic session key 方案
3. 2026-04-12 命名统一后，runtime wake / dispatch / delivery 全部按同一 session 语义工作

## 当前状态

**已部分实现并进入运行时主链**。当前不足不再是“有没有 sessionKey”，而是更高层的会话建模是否还需要进一步抽象给 automation / harness / long-running loop 使用。
