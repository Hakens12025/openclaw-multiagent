# Evaluator

> 去特化重构：从专用 agent 角色到通用评估能力 + EvaluationResult 合约。

## 是什么

"Evaluator" 在系统中曾承载三重语义，导致严重耦合。去特化（de-specialization）的目标是将其拆解为独立关注点。

### 三重语义过载（备忘录 76）

| 语义 | 含义 | 问题 |
|------|------|------|
| Agent ID | 名为 `evaluator` 的特定 agent | 硬编码依赖 |
| 评估能力 | 任何 agent 都可以有的能力 | 被绑定到单一 agent |
| EvaluationResult | 评估结果对象 | 与 agent 身份混淆 |

### 硬编码严重程度（备忘录 88）

系统中存在 **40+ 处硬编码引用**（比 contractor 的 19 处更严重），分布在：
- Pipeline 层
- Automation 层
- Harness 层

### 三桶分类

| 桶 | 内容 | 规模 | 处理方式 |
|----|------|------|---------|
| B1 | 已是通用 harness 基础设施 | ~400 行 | 保留，无需改动 |
| B2 | 可注册为通用模式 | ~300 行 | 迁移到 registry |
| B3 | 真正专用的审查协议 | ~500 行 | 保留为 review capability |

### 目标架构

```
evaluator (agent id)  ──>  worker + review capability + EvaluationResult contract
```

- 任何 worker 都可以装备 review capability
- EvaluationResult 是标准化合约（见 [evaluation-result-chain](evaluation-result-chain.md)）
- "evaluator" 不再是特权角色

### Reviewer 不是新结构角色（备忘录 89）

Reviewer 进入平台主线的唯一原因：它产出标准化的 EvaluationResult。不是因为它是新的结构角色。

### Reviewer = Worker-First（备忘录 94 修正）

- Reviewer 首先是 worker，治理是可选附加
- **Review by Exception**（GMP 模式）被评为最高杠杆方案
- 只在异常时触发 review，而非每次都 review

### System 1 / System 2 模型

| 层 | 类型 | 职责 |
|----|------|------|
| System 1 | 确定性平台检查 | 自动化规则、阈值、格式验证 |
| System 2 | LLM 判断 | 质量评估、创意评价、模糊决策 |

System 1 的结果喂给 System 2，reviewer 看到的是富化后的上下文（enriched context）。

### executionPolicy 模式

Contractor 的 `executionPolicy` 模式可直接复用于 evaluator 去特化。

## 为什么存在

- 40+ 硬编码引用使系统僵化
- 评估能力不应被锁定在单一 agent 上
- EvaluationResult 作为合约需要与 agent 身份解耦
- 去特化是 [god-role-elimination](god-role-elimination.md) 的核心工作之一

## 和谁交互

- **产出**: [evaluation-result-chain](evaluation-result-chain.md) 中的 EvaluationResult
- **消除**: [god-role-elimination](god-role-elimination.md) 的一个实例
- **绑定**: [agent-binding](agent-binding.md) 定义 review capability 如何绑定到 worker

## 演化

| 阶段 | 事件 |
|------|------|
| 备忘录 76 | 识别三重语义过载 |
| 备忘录 88 | 量化硬编码规模（40+），三桶分类 |
| 备忘录 89 | 明确 reviewer 不是新结构角色 |
| 备忘录 94 | 修正为 worker-first；Review by Exception 为最高杠杆 |

## 当前状态

- **设计方向**: 明确
- **executionPolicy 模式**: 来自 contractor，可复用
- **实现**: 未开始
- **来源**: 备忘录 76, 88, 89, 94

相关概念: [evaluation-result-chain](evaluation-result-chain.md) | [god-role-elimination](god-role-elimination.md) | [agent-binding](agent-binding.md)
