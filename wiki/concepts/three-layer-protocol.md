# 三层通讯协议

> 当前运行时只有三条业务协议族：`dispatch`（runtime -> agent）、`system_action`（agent -> runtime）、`delivery`（结果回送）。`wake` 只是 transport，不是第四条业务协议。

## 是什么

| 协议族 | 方向 | 职责 | 主要模块 |
|---|---|---|---|
| `dispatch` | runtime -> agent | 外部入口建单、graph 授权、shared contract / direct request 投递 | `extensions/watchdog/lib/ingress/dispatch-entry.js`, `extensions/watchdog/lib/ingress/dispatch-execution-contract-entry.js`, `extensions/watchdog/lib/routing/dispatch-transport.js`, `extensions/watchdog/lib/routing/dispatch-graph-policy.js` |
| `system_action` | agent -> runtime | agent 主动请求平台协作：create_task / assign_task / request_review / wake_agent / pipeline | `extensions/watchdog/lib/system-action/system-action-consumer.js`, `extensions/watchdog/lib/system-action/system-action-runtime.js` |
| `delivery` | result -> user/agent/session | terminal 回用户，或 system_action 子流程回发起 agent / session | `extensions/watchdog/lib/routing/delivery-*.js` |
| `wake` | runtime -> session | 仅负责 heartbeat / wake transport，不承载业务语义 | `extensions/watchdog/lib/transport/runtime-wake-transport.js` |

补充说明：

- graph-based next hop 不再是独立业务协议，而是 `dispatch` 体系内的 graph policy
- `execution_contract / direct_request / review_artifact / heartbeat` 是 carrier，不是协议族
- 前端流线展示通过 `extensions/watchdog/protocol-registry.js` + `extensions/watchdog/dashboard-flow-visuals.js` 统一映射

## 为什么存在

早期系统把 carrier、业务协议、wake transport、graph policy 混在一起，导致同一件事在前端、后端、备忘录里有不同叫法。备忘录106 的收口目标就是把这些层次拆开：

- `dispatch / system_action / delivery` 是业务协议族
- `wake` 只是 transport
- graph policy 是 `dispatch` 内部的路由策略
- carrier 只回答“装在什么信封里”，不回答“这是什么业务语义”

## 和谁交互

- [传送带原则](conveyor-belt.md) — 三层协议都遵循传送带投递模式
- [硬路径与软路径](hard-soft-path.md) — 协议属于硬路径，LLM 不参与路由决策
- [合约 (Contract)](contract.md) — `dispatch` 投递的主要载体
- [投递 (Delivery)](delivery.md) — 统一结果回送体系
- [大楼比喻](building-metaphor.md) — 用户解释协议设计的核心隐喻

## 演化

- `v66-stable`: 外部入口 dispatch 与内部 graph 路由开始分层。
- `v69-stable`: 进一步收敛，loop-session 真值源确立，Path B 删除。
- 2026-04-02 ~ 2026-04-08：超级 session 讨论把三层架构重新定死。
- 2026-04-12：命名与 owner 再统一，`runtime-bridge` 历史残留彻底收编进 `delivery`，协议注册表固定为 `extensions/watchdog/protocol-registry.js`，第二批文件级 rename 也已完成。

源: 备忘录99 §一, 备忘录90 §二, 备忘录34, 备忘录106

## 当前状态

稳定。协议族边界、运行时 variant id、前端 visual id 已统一。当前剩余工作不在协议命名，而在更高层的 one-shot 中层对象消费、stage 真实推进，以及 `system_action / 角色唤醒 / 外部直达入口` 的总规约。
