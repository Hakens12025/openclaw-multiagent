# SOUL 是通用机，不是专用机

> SOUL.md 只写通用行为（状态机、inbox/outbox），领域知识全部通过 skills 注入。

## 决策

SOUL 只描述 agent 的通用运行时行为：状态机转换、inbox/outbox 消息流程、生命周期钩子。
所有领域知识（schema、数据文件名、领域检查项、领域特有规则）必须通过 skills 注入，禁止出现在 SOUL.md 中。

违反信号：SOUL.md 出现具体数据文件名、领域专属字段说明、领域特有检查项。

## 原因

- SOUL 是投影（projection），不是真值（truth）。将领域知识硬编码进 SOUL 会造成紧耦合。
- 违反装配层分离原则：SOUL 属于运行时层，领域知识属于技能层。混在一起会让每次领域变更都要改 SOUL。
- 通用机设计让同一个 SOUL 可以驱动不同领域的 agent，只需替换 skills。

## 否决的替代方案

1. **在 SOUL.md 中硬编码领域 schema/数据列表/检查项** — 导致 SOUL 成为领域特化文件，失去通用性，每个领域变更都要改 SOUL。
2. **为每个角色创建 "conduct skills"（如 planner-conduct、evaluator-conduct）** — 会把角色身份降格为可选插件，角色的核心行为不应是可插拔的。

## 影响

- 所有 agent 共享同一套 SOUL 行为框架。
- 领域能力完全通过 skills 目录管理，新增领域不需要修改 SOUL。
- 角色区分通过 executionPolicy + skills 组合实现，而非 SOUL 分叉。

## 出处

备忘录56、备忘录68、核心设计指标
