# Harness

> 执行塑形层：限制一次执行、采集一次执行、生成一次 `HarnessRun`。

## 是什么

Harness 是执行层工具箱，不是平台总控。

它当前只允许持有三类正式对象：

1. `HarnessSelection`
2. `HarnessRun`
3. `HarnessModuleResult`

当前 active module kind 只保留 4 类：

| Kind | 作用 |
|------|------|
| `guard` | 预算、工具、作用域限制 |
| `collector` | artifact / trace 采集 |
| `gate` | 完成/验证门控 |
| `normalizer` | evaluator 输入与失败归一化 |

当前代码里的正式入口：

- [extensions/watchdog/lib/harness/harness-registry.js](/Users/hakens/.openclaw/extensions/watchdog/lib/harness/harness-registry.js)
- [extensions/watchdog/lib/harness/harness-run.js](/Users/hakens/.openclaw/extensions/watchdog/lib/harness/harness-run.js)
- [extensions/watchdog/lib/harness/harness-module-runner.js](/Users/hakens/.openclaw/extensions/watchdog/lib/harness/harness-module-runner.js)

## 为什么存在

- 让一次执行可限制
- 让一次执行可采证
- 让上层吃到统一 `HarnessRun`

## 和谁交互

- **向上**: 从属于 [automation-of-automation](automation-of-automation.md)（harness 是前置条件，不是目标）
- **向下**: 消费 agent 的工具调用事件
- **平行**: 为 [evaluation-result-chain](evaluation-result-chain.md) 提供 HarnessRun 数据
- **约束来源**: [system-layering](system-layering.md) 定义 harness 在分层中的位置

### Harness 不定义

- 谁与谁协作
- 合约回给谁
- loop 是否继续
- automation 如何治理

## 演化

| 阶段 | 事件 |
|------|------|
| 备忘录 61 | 首次提出 harness 概念，定义执行底座职责 |
| 备忘录 62 | 明确 harness 与 platform 正交关系 |
| 备忘录 63 | 模块类型分类（guard/collector/gate/adapter） |
| 备忘录 78 | Jigsaw 模型：拼图式组合，拒绝 mega orchestrator |

## 当前状态

- 设计方向：稳定
- 正式接口：仍在冻结中，见 `备忘录115`
- 实现：部分完成

相关概念: [CLI System](cli-system.md) | [Operator](operator.md) | [Automation of Automation](automation-of-automation.md) | [Evaluation Result Chain](evaluation-result-chain.md)
