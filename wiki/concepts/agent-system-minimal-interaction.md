# Agent-System Minimal Interaction

> Agent 产出内容，System 产出结构。Agent 不应写结构化文件来驱动系统。

## 是什么

核心设计指标第12条。定义 Agent 与 System 之间的职责边界和交互方式：

**三条子规则：**

- **12.1 — 系统观察，不听自述：** 系统通过可观测信号（文件写入、工具调用、执行轨迹）判断 Agent 状态，不依赖 Agent 自我报告
- **12.2 — Agent 写内容，系统提取结构：** Agent 写 markdown/自然语言，系统从中提取结构（`[BLOCKING]` → critical severity, `## Phase 1` → stagePlan, file exists → completed）
- **12.3 — 必须驱动时，减轻压力：** CLI 化（`system_command("wake researcher")`），或轻结构自然语言（`[ACTION] wake researcher — need research`）

**[ACTION] 标记系统：**
- `[ACTION]` markers 取代 system_action.json，成为 Agent→System 的唯一命令通道
- 三种标记解析器：action、stage、finding（备忘录96）

**已删除的反模式：**
- stage_result.json, contract_result.json, code_verdict.json, next_action.json — 全部删除
- Agent 连接点从 27+ 降至 3+2 个活跃接口（备忘录95）

## 为什么存在

- Agent 写 JSON 驱动系统 = 把系统控制权交给不可靠的 LLM
- 结构化输出容易出错（格式错误、字段缺失、语义漂移）
- 系统应该从 Agent 的自然行为中提取信号，而不是要求 Agent 学习系统协议
- 减少 Agent 需要"知道"的系统知识 = 减少 SOUL 体积 = 节省 token

## 和谁交互

| 概念 | 关系 |
|------|------|
| [Hard-Soft Path](hard-soft-path.md) | 结构提取属于 hard-path |
| [Planner](planner.md) | Planner 写计划文本，系统提取 stagePlan |
| [Evaluator](evaluator.md) | Evaluator 写评价文本，系统提取 severity |
| [Token Economy](token-economy.md) | 减少 Agent 连接点 = 减少需要注入的协议文档 |
| [SOUL & Identity](soul-identity.md) | SOUL 不需要描述系统协议，只需要描述角色 |

## 演化

1. 核心设计指标 §十二：确立原则
2. 早期：Agent 需要写 stage_result.json 等多种结构化文件
3. 备忘录95：审计发现 27+ 连接点，启动精简
4. 备忘录96：引入三种标记解析器（action/stage/finding）
5. 连接点降至 3+2 个活跃接口

## 当前状态

**永久原则。[ACTION] markers 已实现。** Workspace 清理持续进行中。旧的结构化文件驱动模式已全部删除。
