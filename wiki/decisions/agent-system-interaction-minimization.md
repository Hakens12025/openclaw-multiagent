# Agent-System 交互最小化

> ⚠️ **部分被取代（v179 / 2026-08-08）**：正文里「`[ACTION]` 是 Agent→System 的唯一命令通道」这半已由 FC 工具主路取代（见 [动态协作不查图边](./dynamic-collaboration-leaves-graph.md)、[平台/Agent 解耦](../concepts/platform-agent-decoupling.md)）。**原则本体（agent 写内容、系统提取结构、不依赖自报）仍然成立**，且工具比标记更符合它——agent 不必事先知道任何语法。以下正文保留当时原貌。

> 核心设计指标 #12：Agent 写内容，System 提取结构。System 响应可观察信号，不依赖 agent 自报。

## 决策

新增核心设计原则第 12 条，含三个子规则：

- **12.1 可观察信号**：System 根据 agent 输出中的可观察信号（如 `[ACTION]` 标记）做出反应，不要求 agent 主动自报状态。
- **12.2 内容→结构提取**：Agent 用自然语言写内容，System 负责从中提取结构化数据。
- **12.3 CLI 化**：当 agent 确实需要驱动系统时，用 CLI 风格的标记（`[ACTION]`），不用 JSON schema。

## 原因

- Agent 写 JSON schema 驱动系统是脆弱的：格式敏感、token 昂贵、出错难调试。
- 违反 hard-path 原则：让 LLM 承担结构化输出的负担，而结构化是系统的强项。
- `[ACTION]` 标记在自然语言中廉价且可解析，LLM 天然擅长产出。

## 否决的替代方案

以下协议/文件已删除：
- 旧多文件结构化回执协议
- 旧代码 verdict 文件协议
- 旧下一步声明文件协议
- `system_action.json` 协议（被 `[ACTION]` 标记替代）
- 要求 agent 写 artifact checklist、transition declaration 等结构化输出

## 影响

- Agent prompt 大幅简化，不再需要教 agent 写特定 JSON 格式。
- System 端增加信号提取逻辑，但这是系统的强项（确定性解析）。
- Token 消耗降低，agent 输出更自然。

## 出处

备忘录96
