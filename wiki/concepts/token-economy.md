# Token Economy

> 每个 token 都有成本，系统设计以最小化浪费性消耗为目标。

## 是什么

一套贯穿系统设计的资源意识原则，控制 LLM 上下文窗口中的 token 使用：

**成本基线：**
- 1 KB ≈ 250 tokens
- 每个 wake cycle 都会支付上下文中所有文件的 token 成本
- Framework 自动加载：AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, memory/*.md

**控制手段：**
- Workspace 只放必要文件（SOUL + HEARTBEAT + USER.md）
- AGENTS.md 保持最小化（防止 framework 重建开销）
- 不在 workspace 放通用指南或教程
- 执行类 Agent 只注入 SOUL + HEARTBEAT，不注入全部导航文件

**Context Injection 问题（备忘录97）：**
- 发现 ~2000+ tokens 的注入淹没了 SOUL → planner 跳过了计划编写
- 修复：workspace-guidance-writer 按角色差异化生成文件；执行 Agent 只收到最小集

## 为什么存在

- LLM API 按 token 计费，上下文越长费用越高
- 上下文窗口有限，无用信息挤占有效信息的空间
- Agent 每次被唤醒都重新支付全部上下文成本 — 减少常驻内容直接降低成本
- 过长上下文还会降低 LLM 注意力质量（lost in the middle 效应）

## 和谁交互

| 概念 | 关系 |
|------|------|
| [Context Isolation](context-isolation.md) | 隔离是 token 节约的架构基础 |
| [SOUL & Identity](soul-identity.md) | SOUL 瘦身是 token economy 的直接体现 |
| [Agent-System Minimal Interaction](agent-system-minimal-interaction.md) | 减少交互面 = 减少上下文注入 |
| [Workspace Guidance](workspace-guidance.md) | workspace-guidance-writer 按角色差异化注入 |

## 演化

1. 核心设计指标 §十一：确立为永久原则
2. 早期：所有 Agent 加载相同的完整 workspace
3. 备忘录97：发现 context injection 问题，planner 被淹没
4. 修复：workspace-guidance-writer 实现角色差异化注入

## 当前状态

**永久原则。主动执行中。** workspace-guidance-writer 已实现角色差异化注入。持续监控 token 使用。
