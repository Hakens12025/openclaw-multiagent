# Agent-System Minimal Interaction

> Agent 产出内容，System 产出结构。Agent 不应写结构化文件来驱动系统。

## 是什么

核心设计指标第12条。定义 Agent 与 System 之间的职责边界和交互方式：

**三条子规则：**

- **12.1 — 系统观察，不听自述：** 系统通过可观测信号（文件写入、工具调用、执行轨迹）判断 Agent 状态，不依赖 Agent 自我报告
- **12.2 — Agent 写内容，系统提取结构：** Agent 写 markdown/自然语言，系统从中提取结构（`[BLOCKING]` → critical severity, `## Phase 1` → stagePlan, file exists → completed）
- **12.3 — 必须驱动时，减轻压力：** 最轻的形态是**工具调用**（`assign_task(targetAgent, task)`）——schema 自带、拒绝当场返回；工具不可用时才退到轻结构自然语言（`[ACTION] wake researcher — need research`）

**命令通道的三级梯子**（按形式的自完善程度分级，不是按 `channel` 枚举）：

| 级 | 形态 | 例 |
|---|---|---|
| **L1** | 工具调用（**主路**） | `assign_task({targetAgent, task})` |
| L2 | 结构化 JSON 标记 | `[ACTION] {"type":"assign_task","params":{…}}` |
| L3 | 动词简写自然语言 | `[ACTION] delegate researcher — 查一下 X` |

- 三种标记解析器：action、stage、finding（备忘录96）
- v179 起 L1 是主路，L2/L3 是降级路。标记语法**不进主提示词**——实测两条并列时，已持有工具的 agent 会退回去写标记

**已删除的反模式：**
- 旧多文件结构化回执和下一步声明协议 — 全部删除
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
2. 早期：Agent 需要写多种结构化回执文件
3. 备忘录95：审计发现 27+ 连接点，启动精简
4. 备忘录96：引入三种标记解析器（action/stage/finding）
5. 连接点降至 3+2 个活跃接口
6. **v179：协作主路从标记换成 FC 工具**。原则本体（agent 写内容、系统提取结构）不变，变的是"最轻的驱动形态"这一档——工具比标记更轻，因为 agent 不需要事先知道任何语法（源: 备忘录135、[平台/Agent 解耦](./platform-agent-decoupling.md)）

## 当前状态

**永久原则。** 命令通道已从"标记唯一"演进为"工具主路 + 标记降级"。旧的结构化文件驱动模式已全部删除。
