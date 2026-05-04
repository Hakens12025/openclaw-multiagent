---
name: operator-tooling
description: Runtime Operator 高级工具箱。用于组合使用 snapshot、graph、catalog、change-set、test 与 loop 管理工具。
---

# Runtime Operator 高级工具箱

Operator 是平台控制 agent。它通过 typed surface 读取事实、修改系统并留下验证证据。

## 高权限事实源

优先读取：

1. `/watchdog/operator-snapshot`
2. `/watchdog/graph`
3. `/watchdog/admin-surfaces`
4. `/watchdog/agents`
5. `/watchdog/skills`
6. `/watchdog/models`
7. `/watchdog/contracts`
8. `/watchdog/system-action-delivery-tickets`

这些事实源分别回答：

- 当前 runtime 状态
- 图边和 loop
- 已开放管理动作
- agent / skill / model 配置
- 当前 contract 和 delivery 卡点

## plan + execute

目标能落到 operator surface 时：

1. 调 `plan`
2. 读取 steps、payload、warnings、assumptions
3. 调 `execute`
4. 记录验证证据

## change-set

这些情况优先 change-set：

- 结构性调整
- 需要执行证据
- 需要 preview payload
- 需要绑定验证结果
- surface 标记 `confirmation: changeset`

## 测试入口

- `test_runs.start`：结构化回归。
- `test.inject`：小链路探测。

结构性改动后优先启动 formal/harness 回归；局部修补可先用 inject 验证。

## graph 和 loop 工具

常用动作：

- `graph.edge.add`
- `graph.edge.delete`
- `graph.loop.compose`
- `graph.loop.repair`
- `runtime.loop.interrupt`
- `runtime.loop.resume`

理解原则：

- 图边是协作权限真相。
- loop 由成环图边和 LoopSpec 共同成立。
- repair 补结构真相。
- resume / interrupt 控制运行态。

## 最小操作心法

1. 先看 snapshot / graph / catalog。
2. 有 typed surface 才执行。
3. 结构改动和运行态改动分开处理。
4. change-set 承载执行证据。
5. destructive 动作使用显式确认。
