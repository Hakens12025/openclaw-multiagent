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

**Pipeline 溶解**（备忘录92）：
- pipeline-engine.js（1717 行，8 文件）被标记为删除目标
- loop-session 吸收决策逻辑
- system_action 重命名：`start_pipeline` → `start_loop`，`advance_pipeline` → `advance_loop`

## 为什么存在

- 消除 pipeline-engine god object：将 1700+ 行的单体引擎拆解为循环原语
- 统一重复执行模式：研究回路、生产流水线、审查循环都用同一套 loop 机制
- 避免协议膨胀：loop 不是新协议，只是 conveyor dispatch 的重复应用

## 和谁交互

- [Conveyor Belt](./conveyor-belt.md)：loop 的每次迭代就是一次 conveyor dispatch
- [Graph & Edge](./graph-edge.md)：循环中的 agent 协作路径受图约束
- [Evaluation Result Chain](./evaluation-result-chain.md)：evaluator 判定驱动循环推进/终止
- [Harness](./harness.md)：每次循环执行通过 harness 塑造（如已存在）

## 演化

1. 备忘录65 开始讨论循环机制，将 pipeline 概念向 loop 迁移
2. 备忘录69 loop-session 成为真值源，旧 Path B 删除
3. 备忘录74 提出判别式循环 / GAN-like 模式
4. 备忘录92 正式提出 pipeline 溶解计划，loop-session 吸收决策逻辑

## 当前状态

**概念已定型，溶解半完成**。备忘录98 确认旧 pipeline-engine 仍在 loop-session-store facade 背后运行，尚未真正删除。system_action 重命名已完成。loop-session 存储已独立，但决策逻辑的完全吸收尚未完成。
