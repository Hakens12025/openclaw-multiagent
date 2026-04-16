# Evaluation Result Chain

> 从一次执行到能力演化的正式对象链：HarnessRun -> EvaluationResult -> AutomationDecision -> ProfileLifecycle。

## 是什么

四个严格分离的对象，形成从执行到治理的信息流：

```
HarnessRun ──> EvaluationResult ──> AutomationDecision ──> ProfileLifecycle
 (执行层)        (评估层)            (治理消费者)          (能力演化)
```

### 1. HarnessRun

一次 harness 执行的完整记录。由 [harness](harness.md) 产出。

### 2. EvaluationResult

**"这一轮表现如何"** — 评估层的核心输出。

- 规范名称：`EvaluationResult`（不是 EvaluatorResult，不是 Verdict）
- 包含 `confidence` 字段（0-1 浮点数）
- 每条 finding 附带 `artifactRef`（指向 harness 产物）+ `confidence`
- 属于评估层，不属于执行层或治理层

### 3. AutomationDecision

**"运行时接下来该做什么"** — 治理消费者。

- 消费 EvaluationResult，产出运行时决策
- 决策类型：继续 / 重试 / 升级 / 终止 / 归档
- 是治理层的产物，不是评估层的产物

### 4. ProfileLifecycle

**"这个能力对象如何演化"** — 能力演化。

- 消费 AutomationDecision 的历史模式
- 管理 profile 的生命周期：provisional -> experimental -> stable -> retired
- 是最长时间尺度的对象

### 三对象分离原则

三个对象（EvaluationResult / AutomationDecision / ProfileLifecycle）**必须严格分离**，不能合并为单一"verdict"。原因：

- 评估（"表现如何"）与决策（"该做什么"）是不同关注点
- 决策（"该做什么"）与演化（"能力如何成长"）在不同时间尺度运作
- 合并会导致职责混淆，每个消费者被迫处理不相关的字段

### "Evaluator" 三重语义过载（备忘录 76）

"Evaluator" 这个词在系统中曾同时指代三件事：

1. 特定的 agent id（`evaluator`）
2. 评估能力（任何 agent 都可以有的能力）
3. EvaluationResult 对象本身

这个歧义是 [evaluator](evaluator.md) 去特化重构的直接原因。

### 备忘录 100 扩展链

备忘录 100 在原有四对象基础上扩展为更精细的链路：

```
ContractDefinition -> ExecutionObservation -> TerminalOutcome
    -> DeliveryPayload -> LifecycleProjection
```

## 为什么存在

- 执行、评估、治理、演化是四个不同时间尺度的关注点
- 没有正式对象链，信息在层间传递时会退化为非结构化文本
- 每个消费者只需要链中属于自己的那一段

## 和谁交互

- **上游**: [harness](harness.md) 产出 HarnessRun
- **评估层**: [evaluator](evaluator.md) 能力产出 EvaluationResult
- **治理层**: [automation-of-automation](automation-of-automation.md) 消费 AutomationDecision
- **分层位置**: [system-layering](system-layering.md) 定义每个对象属于哪一层

## 演化

| 阶段 | 事件 |
|------|------|
| 备忘录 76 | 识别 Evaluator 三重语义过载问题 |
| 备忘录 80 | 正式定义四对象链及分离原则 |
| 备忘录 100 | 扩展为五阶段精细链路 |

## 当前状态

- **EvaluationResult**: 部分存在
- **AutomationDecision**: 部分实现
- **ProfileLifecycle**: 尚未实现
- **Phase 1 目标**: 先作为运行时内部对象实现
- **来源**: 备忘录 76, 80, 100

相关概念: [harness](harness.md) | [automation-of-automation](automation-of-automation.md) | [evaluator](evaluator.md) | [system-layering](system-layering.md)
