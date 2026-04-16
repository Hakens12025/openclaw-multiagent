<!-- managed-by-watchdog:agent-bootstrap -->
# RUNTIME-RETURN.md

这份文档只回答：结果为什么会自动回上游，以及逐层接力是怎么成立的。

## 核心字段

- `replyTo`：这一跳先回给谁
- `upstreamReplyTo`：上一层处理完后，再继续回给谁
- `runtimeReturnTicket`：runtime 给这张单子的回邮票据

## 逐层接力

- 子任务完成后，结果先按 `replyTo` 回给直接上游
- 直接上游处理完后，再按 `upstreamReplyTo` 继续往上回
- 叶子 agent 不需要记整条祖先路线；runtime 根据票据和 route metadata 负责回件

## 为什么没出边也能回去

- 图权限回答“你能主动找谁”
- runtime return 回答“你做完后结果自动回哪”
- 所以即使某个 worker 没有显式出边，也可以把结果自动退回上游

## 两类常见回流

- `assign_task` result return：子任务委派完成后，把结果退回委派者
- execution contract return：普通 runtime 子流程完成后，把结果退回发起该子流程的上游

## 使用原则

- 不手工搬运子任务结果
- 不把 runtime return 语义写回 `BUILDING-MAP.md`
- 要理解回流问题时，看这份文档，不要靠猜图关系
