# Automation of Automation

> 长期演化层：消费运行结果和治理结果，形成下一轮自动化决策。

## 是什么

Automation 不等于定时器，也不等于“让 harness 更大”。

它当前应该只消费：

1. runtime truth
2. `HarnessRun`
3. `EvaluationResult`
4. `AutomationDecision`

### 不是什么

| 常见误解 | 实际含义 |
|---------|---------|
| "跑更多自动化任务" | 不是数量，是质量结晶 |
| "让 harness 更大" | harness 是工具，不是目标 |
| "单轮成功率更高" | 单轮是手段，能力演化是目标 |

### 是什么

- 哪些成功可以复用
- 哪些失败可以被吸收
- 哪些模式可以结晶为稳定能力

### 渐进硬化（Progressive Hardening）

未知任务从 provisional/experimental 开始，经过验证后毕业为 stable：

```
unknown -> provisional -> experimental -> stable -> (retired)
```

每次晋升都需要 [evaluation-result-chain](evaluation-result-chain.md) 提供的证据支撑。

### 与 Platform 的关系

- 它站在 [Harness](harness.md) 和 [Operator](operator.md) 之后
- 它不能跳回去接管执行层或表面层

## 为什么存在

- 系统不能停留在"每次都从零开始"
- 人工运维不可扩展，自动化本身需要被自动化
- 没有元层级的能力管理，系统会退化为脚本堆砌

## 和谁交互

- **基础设施**: [harness](harness.md) 提供标准化执行数据（前置条件）
- **信息流**: [evaluation-result-chain](evaluation-result-chain.md) 提供评估→决策→演化的对象链
- **分层**: [system-layering](system-layering.md) 定义各层职责边界

## 演化

| 阶段 | 事件 |
|------|------|
| 备忘录 62 | 明确 platform vs harness 的主从关系 |
| 备忘录 79 | 正式定义 automation-of-automation 为系统终局目标 |

## 当前状态

- 方向：稳定
- 实现：距离完整还远
- 当前缺口：`AutomationDecision -> ProfileLifecycle` 链未完全落地

相关概念: [evaluation-result-chain](evaluation-result-chain.md) | [harness](harness.md) | [system-layering](system-layering.md)
