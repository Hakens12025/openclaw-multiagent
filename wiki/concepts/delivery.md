# Delivery

> 统一结果回送体系——终态回用户，或 system_action 子流程回发起 agent / session。

## 是什么

Delivery 负责把结果送到正确的下一跳。当前运行时只保留一套 delivery 体系，旧的 `runtime-bridge / runtime-return` 已经被收编。

当前 canonical runtime variant：

| runtime id | 语义 |
|------|------|
| `delivery:terminal` | contract 到终态后回最终用户或外部入口 |
| `delivery:system_action_contract_result` | 普通子流程完成后，结果回发起 agent / session |
| `delivery:system_action_assign_task_result` | assign_task 子任务完成后，结果回委派者 |
| `delivery:system_action_review_verdict` | request_review 审查完成后，verdict 回发起者 |

文档里仍可把后三者统称为 `delivery:system_action` 概念家族，但运行时不会再写这个模糊 id。

**回件元数据模型**：

- `replyTo` — 这一跳先回给谁
- `upstreamReplyTo` — 上游处理后继续回给谁
- `systemActionDeliveryTicket` — runtime 持有的精确回件票据
- `returnContext / serviceSession` — 辅助恢复同一业务会话

**硬路径投递**：
- QQ 投递：通过 `qqNotify()`，2000 字符分段，500ms 延迟
- WebUI 投递：通过 `sessions_send` 到 controller

## 为什么存在

- 终态回用户和 agent 间回件本来就是同一类事情，长期保留两套 return 体系只会继续制造重复协议
- `runtime-bridge` 的独特价值不是名字，而是 session 级精度；这个能力现在已经通过 deterministic session key + delivery ticket 进入 delivery 主链
- 外部渠道各有约束（字符限制、速率限制），需要专门处理

## 和谁交互

- [三层通讯协议](./three-layer-protocol.md) — delivery 是三条业务协议族之一
- [合约 (Contract)](./contract.md) — contract 完成或子流程收口后触发 delivery
- [Session Management](./session-management.md) — 为同会话精确回件提供会话建模

## 演化

1. 备忘录60 识别三种被混淆的投递语义
2. 备忘录72 提出 parcel model，用 returnTicket/returnContext 管理回程
3. 备忘录99 §1.7-1.8 确认收编方向
4. 2026-04-12 备忘录106 + `protocol-registry.js` 把 runtime-bridge 历史残留彻底收编进 delivery

## 当前状态

**统一已完成并在运行时主链生效。** 当前不足不再是“bridge 有没有收编”，而是更高层的结果对象是否被 harness / automation / dashboard 一致消费，以及同会话 delivery 的更高阶会话建模是否还需要继续抽象。
