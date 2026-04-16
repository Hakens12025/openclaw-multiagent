# Graph 是运行时真值

> agent_graph.json 在运行时强制执行协作权限，不只是 UI 装饰。

## 决策

`agent_graph.json` 作为运行时权限边界。Agent 间的协作请求必须经过 graph 校验：只有 graph 中存在边的 agent 对才能互相通信。

## 原因

- 没有运行时强制执行，agent 可以联系任何人，graph 就变成了一张没人看的图。
- Graph-constrained actions 防止未授权的协作发生，是系统安全性和可预测性的保障。
- Graph 作为真值源让系统行为可审计 — 看 graph 就知道谁能跟谁通信。

## 否决的替代方案

1. **Graph 纯可视化 / UI-only** — 没有运行时约束力，agent 行为不可预测。
2. **所有 action 都必须经 graph 约束** — 会破坏 `create_task` 等入口场景（graph 为空时无法工作）。
3. **扩大 loop engine 作用范围至覆盖环路以外的场景** — loop engine 职责是环路检测，不应承担通用权限校验。

## 影响

- dispatch graph policy 在路由前校验 graph 边，拒绝未授权的协作请求。
- 新增 agent 协作关系必须先在 graph 中声明。
- Graph 成为系统拓扑的唯一真值源。

## 出处

备忘录51
