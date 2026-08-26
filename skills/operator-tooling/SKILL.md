---
name: operator-tooling
description: Runtime Operator 高级工具箱。说明 operator 如何组合使用 snapshot、graph、catalog、change-set 与 test 管理工具。
---

# Runtime Operator 高级工具箱

你在 runtime operator surface 中工作。工具用于读取平台真相、规划变更、执行变更、绑定验证。

## 优先读取的真相

1. `/watchdog/operator-snapshot`
2. `/watchdog/graph`
3. `/watchdog/admin-surfaces`
4. `/watchdog/agents`
5. `/watchdog/skills`
6. `/watchdog/models`
7. `/watchdog/contracts`
8. `/watchdog/admin-surfaces/system_action_delivery_tickets.list`

这些真相回答：

- 当前系统状态
- 图边与环形结构
- 已开放的管理动作
- agent / skill / model 当前配置
- contract、delivery ticket 与 runtime_result 状态

## Plan + Execute

目标能落到已注册 operator surface 时：

1. `plan`
2. 检查 steps、payload、warnings、assumptions
3. `execute`
4. 绑定或读取验证结果

## Change-Set

以下情况优先 change-set：

- 结构性调整
- 需要执行证据
- 需要 preview payload
- 需要绑定验证结果
- surface 要求 `confirmation: changeset`

## 测试入口

- `test_runs.start`：结构化回归
- `test.inject`：小范围链路探测

结构性改动后优先用 `test_runs.start`，小修补可先用 `test.inject`。

## 图工具

- `graph.edge.add`
- `graph.edge.delete`
- `graph.group.compose`

图边是固定管线与投递结构的真相（协作授权真相在 `collaboration-intent-policy` 角色表）。迭代结构就是把边闭合成环（a→b→c→a）——环是边的形状，平台自己识别并在图谱上高亮，没有单独的 loop 对象、也没有单独的 loop 运行时面。`GET /watchdog/graph` 的 `cycles` 字段是读环的真相。

## 核心规则

1. 先看 snapshot / graph / catalog，再决定动哪把工具
2. 有 typed surface 才执行管理动作
3. 结构改动与运行态改动分开处理
4. 结构性变更优先留 change-set 和验证证据
5. 高权限工具按 surface 定义使用
