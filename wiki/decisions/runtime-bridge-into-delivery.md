# Runtime-Bridge 合入 Delivery

> `runtime-bridge` 不再作为独立协议存在；结果回送统一归入 `delivery` 体系。

## 决策

`runtime-bridge` 的功能已经并入 `delivery`。当前运行时使用：

- **delivery:terminal** — 终端投递，面向 QQ / Feishu / controller 等外部入口
- **delivery:system_action_contract_result** — 普通子流程结果回上游
- **delivery:system_action_assign_task_result** — 委派子任务结果回委派者
- **delivery:system_action_review_verdict** — 审查 verdict 回发起者

`delivery:system_action` 只保留为文档中的概念家族，不再作为运行时 fallback id。

## 原因

- Runtime-bridge 的独特价值是会话级精度（session-level precision）。
- 这项能力已经通过 deterministic session key + delivery ticket 并入 delivery。
- 两个独立的投递通道增加了系统复杂度和维护负担。

## 否决的替代方案

1. **永久保留 runtime-bridge 作为独立协议** — 两条投递路径长期共存，违反统一控制面原则。
2. **不实现 session 支持就合并** — 会丢失 runtime-bridge 的核心价值（会话精度），合并后反而退化。

## 影响

- 投递路径从两条收敛为一条（delivery），语义通过子类型区分。
- 统一控制面进一步完善。
- session management 不再阻塞这项合并；后续只剩更高层的会话抽象与消费面统一。

## 出处

备忘录99 §1.8-1.9，备忘录106
