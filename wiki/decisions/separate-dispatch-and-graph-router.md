# 决策：dispatch 与 graph-based policy 保持分层

> `dispatch` 是业务协议族；graph-based next-hop policy 是它内部的路由策略模块，不和 ingress / delivery / wake 混在一起。

## 决策

当前分层如下：

- `dispatch-entry.js` / `dispatch-execution-contract-entry.js`：入口建单
- `dispatch-transport.js`：shared contract / direct request 投递原语
- `dispatch-graph-policy.js`：graph 授权与下一跳策略

这三者同属 `dispatch` 体系，但职责必须分层，不允许再退化成一个大 `dispatcher`。

## 原因

用户在超级 session 中观察到：外部入口、graph 下一跳、shared transport 虽然都属于 runtime -> agent，但它们不是同一层问题。把 graph policy 塞回入口模块，只会重新做出 god object。

> "graph router 会更重要，因为 dispatch 只负责一处，而 graph router 负责后面系统的每一处，将 graph router 收纳进入 dispatch 是不合理的" —— 用户原话

## 否决的替代方案

**合并为统一 dispatcher**：所有消息（外部+内部）走同一个 dispatch 函数，用参数区分来源。
否决理由：违背单一职责；dispatch 会变成又一个 god object；两者的演化速度和方向不同。

**graph policy 调 ingress 的原语**：graph policy 不直接调 transport，而是通过入口模块间接调用。
否决理由：增加了一层不必要的间接；v66 之前的实际问题就是这种间接导致的耦合。

## 影响

- [三层通讯协议](../concepts/three-layer-protocol.md) — 这个决策确立了 `dispatch` 族内部的 owner 分层
- [传送带原则](../concepts/conveyor-belt.md) — 入口、graph policy、transport 共享原语但独立决策，符合传送带精神

## 出处

源: 备忘录99 §一, 讨论日期: 2026-04-02
确立于 v66-stable
