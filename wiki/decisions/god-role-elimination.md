# 消除 God Role

> 只保留 bridge + worker 两种结构角色。规划/评审/研究等能力通过 policy + skill 组合注入。

## 决策

系统只有两种结构角色：**bridge**（外部入口）和 **worker**（执行单元）。
所有原先的"规划者/评审者/研究者"不再是独立角色类型，而是通过 `executionPolicy` + skills 组合在通用 worker 上实现。

具体机制：
- `executionPolicy` schema 定义在 AgentBinding 中
- `planMode` 让任意 agent 具备规划能力
- `reviewPolicy`（已设计，未实现）用于评审能力

## 原因

- **Contractor** 有 19+ 硬编码引用分布在 6 条链路中 — 这不是结构角色，是捆绑策略。
- **Evaluator** 有 40+ 引用跨越 pipeline/automation/harness — 同样是策略捆绑，不是固有结构。
- God role 导致每新增一种能力就要新增一种角色类型，系统复杂度线性增长。

## 否决的替代方案

1. **先建 AgentGroup 再消除 god roles** — 顺序错误，group 会继承 god role 的复杂性。
2. **Group 内部 auth 绕过** — 安全隐患，即使同组也应遵循 graph 约束。
3. **保留 evaluator/researcher 作为结构角色** — 它们的行为完全可以用 policy + skill 表达，不值得保留为结构类型。

## 影响

- 角色类型从 N 种收敛为 2 种，系统概念大幅简化。
- 新能力通过组合 policy + skill 实现，不需要改动角色系统。
- 已有的 contractor/evaluator 引用需要逐步迁移清理。

## 出处

备忘录85、86、88、89
