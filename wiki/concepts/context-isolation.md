# Context Isolation

> 多 Agent 的核心理由是上下文隔离，而非单纯的分工。

## 是什么

系统中每个 Agent 拥有独立的上下文窗口，Agent 之间不共享对话历史。跨 Agent 通信只传递摘要/结果，不传递原始 conversation history。

核心规则：

- **Worker 之间永不直接通信** — 防止上下文污染
- **监控（Watchdog）运行在 LLM 上下文之外** — 纯代码逻辑，不消耗 token
- **Subagent 是一次性的** — 干净上下文启动，任务完成即销毁，结果通过 announce 传回
- **反馈回路只通过 Controller/Gateway 单一入口** — 不允许旁路

## 为什么存在

- LLM 的上下文窗口是有限且昂贵的资源
- 上下文污染是多 Agent 系统最隐蔽的失败模式：一个 Agent 的噪音会干扰另一个 Agent 的判断
- 隔离保证每个 Agent 只看到与自己任务相关的信息，提高决策质量
- 销毁 subagent 比清理上下文更可靠

## 和谁交互

| 概念 | 关系 |
|------|------|
| [Hard-Soft Path](hard-soft-path.md) | 隔离由 hard-path 代码保证，不依赖 Agent 自觉 |
| [Session Management](session-management.md) | Session 是隔离的执行边界 |
| [Token Economy](token-economy.md) | 隔离直接服务于 token 效率 |
| [Building Metaphor](building-metaphor.md) | 办公室之间的隔墙 |

## 演化

1. 核心设计指标 §二：确立为永久原则
2. 实践中发现：即使 prompt 告诉 Agent "不要泄露上下文"，也无法可靠阻止 — 必须在架构层面物理隔离
3. Subagent 模式成为标准：启动 → 执行 → announce → 销毁

## 当前状态

**永久原则。已实现。** 所有跨 Agent 通信都经过 Gateway 中转，自动剥离原始上下文。Subagent 生命周期由 harness 管理。
