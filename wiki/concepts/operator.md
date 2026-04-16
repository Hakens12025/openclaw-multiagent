# Operator

> 治理消费层：读取 formal truth，通过 formal surface 做 inspect / apply / verify。

## 是什么

Operator 不是 runtime，也不是第二 planner。

它只做三件事：

1. 读 formal truth
2. 经由 [CLI System](cli-system.md) 形成治理动作
3. 验证治理动作结果

当前主要读侧：

- [extensions/watchdog/lib/operator/operator-snapshot.js](/Users/hakens/.openclaw/extensions/watchdog/lib/operator/operator-snapshot.js)
- [extensions/watchdog/lib/operator/operator-surface-policy.js](/Users/hakens/.openclaw/extensions/watchdog/lib/operator/operator-surface-policy.js)

## 为什么存在

- 给系统一个治理消费者
- 让治理动作走 formal surface，而不是手写补丁

## 和谁交互

- 吃 runtime truth
- 通过 [CLI System](cli-system.md) 操作系统
- 消费 [Harness](harness.md) 的证据
- 结果可继续喂给 automation

## 演化

| 阶段 | 事件 |
|------|------|
| 备忘录 45 | 定义 operator 为系统级 agent |
| 备忘录 55 | 明确 operator 的管理端点和能力边界 |
| 备忘录 59 | De-pseudo-intelligence：拆解 god object，业务语义回归专属模块 |

## 当前状态

- 实现：部分完成
- 当前红线：不能绕过 CLI system 直写真值

相关概念: [system-layering](system-layering.md) | [agent-binding](agent-binding.md) | [hard-soft-path](hard-soft-path.md)
