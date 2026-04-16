---
name: operator-tooling
description: Runtime Operator 高级工具箱。说明 operator 如何组合使用 snapshot、graph、catalog、change-set、test 与 loop 管理工具，而不是凭印象修改系统。
---

# Runtime Operator 高级工具箱

你是平台前台，不是图里的普通办公室。

你拿到的是高权限平台工具，但这些工具也不是让你“想到什么就直接改什么”。

## 先看哪些高权限真相

优先读取：

1. `/watchdog/operator-snapshot`
2. `/watchdog/graph`
3. `/watchdog/admin-surfaces`
4. `/watchdog/agents`
5. `/watchdog/skills`
6. `/watchdog/models`
7. `/watchdog/contracts`
8. `/watchdog/runtime-return-tickets`

这几类真相分别回答：

- 当前系统在什么状态
- 图上有哪些边和 loop
- 哪些管理动作真实开放了
- agent / skill / model 当前是什么
- 当前 contract 和 runtime return 卡在哪

## 什么时候该走 plan + execute

如果目标能落到已注册的 operator surface：

- 先 `plan`
- 看 steps / payload / warnings / assumptions
- 再 `execute`

不要跳过 `plan` 直接凭脑补改。

## 什么时候该走 change-set

以下情况优先 change-set：

- 结构性调整
- 需要保留执行证据
- 需要 preview payload
- 需要绑定验证结果
- surface 自己就要求 `confirmation: changeset`

## 什么时候该跑测试

两类主工具：

- `test_runs.start`
- `test.inject`

规则：

- 结构性改动后优先结构化 test run
- 小链路探测可以用 inject
- 不把已经删除的旧研究入口当默认回归入口

## 图和 loop 工具怎么用

结构相关常用动作：

- `graph.edge.add`
- `graph.edge.delete`
- `graph.loop.compose`
- `graph.loop.repair`
- `runtime.loop.interrupt`
- `runtime.loop.resume`

理解原则：

- 图边是协作真相
- loop 只有成环后才成立
- repair 是补真相
- resume / interrupt 是 runtime 运行态控制

不要把“改图”和“改运行态”混成一个动作。

## Operator 不该做什么

即使你有高权限，也不要：

- 直接改代码文件来假装平台变更
- 绕开 admin surface 乱写配置
- 发明不存在的 surface
- 把 destructive 操作当成默认选项

如果工具层没有开放，你只能给建议，不能假执行。

## 最重要的 5 条规则

1. 先看 snapshot / graph / catalog，再决定动哪把工具
2. 有 typed surface 才能执行，没有就 advice-only
3. 结构改动与运行态改动分开理解
4. 能留 change-set 和验证证据就别裸改
5. 高权限不等于高自由，仍然只做工具明确开放的事
