# Wake Event

> 按需唤醒控制面——由运行时状态变迁驱动，而非固定调度。

## 是什么

Wake Event 定义了 agent 被唤醒的完整决策链。

**对象链**：
```
WakeEvent → WakeRule → WakeDecision → WakeAction
```

- `WakeEvent` — 触发唤醒的事件（状态变迁、外部信号等）
- `WakeRule` — 唤醒规则（什么条件下应该唤醒谁）
- `WakeDecision` — 唤醒决策（是否执行、由 automation/control plane 做出）
- `WakeAction` — 唤醒动作（实际执行唤醒调用）

**三种唤醒方式评估**：

| 方式 | 角色 | 说明 |
|------|------|------|
| 定时任务 (cron) | 降级为 fallback | 不是主要机制 |
| 持续监控 | 罕见场景 | 仅用于极少数需要持续观测的情况 |
| **事件驱动按需唤醒** | **主要机制** | 由运行时状态变迁触发 |

**职责分离**：
- Harness 提供 evidence/signals，**不拥有**唤醒决策权
- Automation / Control Plane 拥有 WakeRule 和 WakeDecision

**健康指标**：审查报告确认所有 14 个唤醒场景都正确经过 comm.js。

**风险**：pipeline auto-advance 在图有环路时可能创建无限唤醒循环。

## 为什么存在

- 避免轮询浪费：agent 不应该定时醒来检查"有没有事做"
- 精确控制：只在状态真正变化时唤醒相关 agent
- 防止失控：唤醒决策经过 rule + decision 链，不是随意调用

## 和谁交互

- [Automation of Automation](./automation-of-automation.md)：WakeRule/WakeDecision 是自动化治理的一部分
- [Graph & Edge](./graph-edge.md)：唤醒必须遵守图约束（wake_agent 需要有向边）
- [Loop](./loop.md)：循环推进触发下一阶段的 agent 唤醒

## 演化

1. 备忘录84 提出 WakeEvent 对象链和三种唤醒方式评估
2. 审查报告确认 14 个唤醒场景均健康通过 comm.js
3. 识别 pipeline auto-advance 的无限循环风险

## 当前状态

**概念设计完成，代码未结构化**。当前唤醒调用仍是 ad-hoc 的（散布在各处的 wakeAgent 调用），尚未重构为 WakeEvent → WakeRule → WakeDecision → WakeAction 的结构化链路。所有调用路径正确经过 comm.js，但缺乏统一的规则引擎。
