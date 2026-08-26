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
| v109-stable | 对象链 `HarnessRun→CLI System→Operator→Automation` 四关节接上，端到端样例 `tests/cli-chain-e2e.test.js`；automation 经 `inspect.automation_runtime` surface 被读取，不直读 store。`ProfileLifecycle` 概念预算未满足，本轮不建。源: 备忘录114 |
| 2026-05-31 | 备忘录120 把四关节闭合成带反馈的真值回路，定位三处真死链（reworkGuidance 零消费 / cli-system 无法真执行 / governanceSnapshot 无合流点）+ 阶段计划。详见 [四关节自治闭环](self-governance-loop.md) |
| v115 | **自治回路物理闭合**：ProfileLifecycle 已建（`profile-lifecycle.js`，现算 streak 渐进硬化 trustLevel）+ resolveGovernance 合流点（`resolve-governance.js`，snapshot 覆盖 spec 回灌下轮）+ reworkGuidance 接通 + 安全阀（熔断/复活）。E2E 闭环已断言 |

## 当前状态

- 方向：稳定
- 实现：**核心回路已闭合**（HarnessRun→EvaluationResult→AutomationDecision→ProfileLifecycle 全段实接，证据见 [四关节自治闭环](self-governance-loop.md)）
- 余项：**均已完成** —— P5（operator 经 CLI-system 的治理闭环：`cli-surface-executor.js` + operatorExecutable surface 已在位）、P6b（Agent-Group 空间原语：`lib/agent/agent-group-spec.js` v119 宏展开落地）

相关概念: [evaluation-result-chain](evaluation-result-chain.md) | [harness](harness.md) | [system-layering](system-layering.md)
