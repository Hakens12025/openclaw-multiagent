# Loop

> 循环 = 传送带的重复分发，不是独立协议。

## 是什么

Loop 是 conveyor belt dispatch 的重复执行机制。它不引入新的通信协议，而是在已有的 conveyor dispatch 之上增加重复和状态管理。

**核心对象**：
- `LoopSpec` — 循环定义：从 cycle 提升为 runtime loop，包含 phase order 和 max iterations
- `loop-session` — 循环运行时状态存储，**只存循环状态**（不含通信字段——备忘录92 审查纠正）

**判别式循环 / GAN-like 模式**（备忘录74）：
```
researcher → worker → evaluator → (judgment) → researcher ...
```
- evaluator 产出判定结果驱动改进
- 形成 judgment-driven improvement loop

**Loop 家族概念**：
- 通用循环机制 + 具体家族绑定
- 不同循环场景（研究、生产、审查）复用同一套循环原语

**Loop runtime 收口**（备忘录92 之后）：
- 历史编排引擎职责回收到 loop-session 与 dispatch graph policy
- loop-session 吸收循环决策状态
- system_action 当前入口使用 `start_loop` / `advance_loop`

## 为什么存在

- 消除旧编排 god object：把单体引擎职责拆解为循环原语
- 统一重复执行模式：研究回路、生产流水线、审查循环都用同一套 loop 机制
- 避免协议膨胀：loop 不是新协议，只是 conveyor dispatch 的重复应用

## 和谁交互

- [Conveyor Belt](./conveyor-belt.md)：loop 的每次迭代就是一次 conveyor dispatch
- [Graph & Edge](./graph-edge.md)：循环中的 agent 协作路径受图约束
- [Evaluation Result Chain](./evaluation-result-chain.md)：evaluator 判定驱动循环推进/终止
- [Harness](./harness.md)：每次循环执行通过 harness 塑造（如已存在）

## 演化

1. 备忘录65 开始讨论循环机制，将历史编排概念向 loop 迁移
2. 备忘录69 loop-session 成为真值源，旧 Path B 删除
3. 备忘录74 提出判别式循环 / GAN-like 模式
4. 备忘录92 正式提出旧编排引擎收口计划，loop-session 吸收决策逻辑

## 当前状态

**概念已定型，仍需实现收尾**。loop runtime 使用 loop-session 作为循环状态源；剩余工作是继续移除历史编排残留，并把决策消费面完全接到当前 runtime 对象链。
