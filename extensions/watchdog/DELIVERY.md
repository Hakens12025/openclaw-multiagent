<!-- managed-by-watchdog:agent-bootstrap -->
# DELIVERY.md

这份文档只回答：结果如何离开当前 contract，以及为什么会自动送到正确的下一跳。

## 两条 delivery 语义

- `delivery:terminal`：contract 到终态后，把结果送到最终用户或前台入口（controller / agent-for-kksl）
- `delivery:system_action`：文档里的概念家族；运行时落到具体的 system_action return variant

## 核心字段

- `replyTo`：这一跳先回给谁
- `upstreamReplyTo`：上一层处理完后，再继续回给谁
- `systemActionDeliveryTicket`：runtime 持有的 delivery 票据，用来把结果精确送回同一业务会话

## delivery:terminal

- 普通 contract 完成后，runtime 走 terminal delivery
- 若目标是 QQ / controller，这一跳直接送到最终用户侧
- 这是“任务结束后往外送”的出口

## delivery:system_action（概念家族）

- 子任务完成后，结果先按 `replyTo` 回给直接上游
- 直接上游处理完后，再按 `upstreamReplyTo` 继续往上回
- direct service 同会话恢复时，runtime 会结合 delivery ticket、sessionKey 和 wake 机制把结果送回原会话
- 叶子 agent 提交本轮结果；runtime 根据票据和 route metadata 负责回件

## 为什么没出边也能回去

- 图权限回答“你能主动找谁”
- delivery 回答“你做完后结果自动送到哪”
- 所以即使某个 worker 没有显式出边，也可以把结果自动退回上游

## 两类常见 system_action delivery

- `delivery:system_action_assign_task_result`：子任务委派完成后，把结果送回委派者
- `delivery:system_action_runtime_result`：普通 runtime 子流程完成后，把结果送回发起该子流程的上游
- `delivery:system_action_review_verdict`：审查 verdict 送回发起审查的 agent / session

## 使用原则

- 子任务结果交给 runtime 回送
- delivery 语义保留在 `DELIVERY.md`
- 理解 delivery 问题时，以这份文档为准
