# SOUL & Identity

> SOUL.md 是角色自我描述 + 最小本地工作规则（身份层），不是装配清单。

## 是什么

SOUL.md 定义一个 Agent "是谁"：

**SOUL 应该包含的：**
- 角色自我描述（我是谁、我做什么）
- 最小本地工作规则（状态机、inbox/outbox 流程）
- 角色内在品质：思维姿态、质量底线、判断偏好、停止条件

**SOUL 不应该包含的：**
- 硬编码的 skill 列表、tool 列表、拓扑信息（这些是装配清单，不是身份）
- 具体数据文件名、领域特有字段说明、领域特有检查项
- 通用行为指南或教程

**关键区分：**
- SOUL 是 AgentBinding 的投影，不是真值源
- SOUL 是通用机器：只写通用行为，领域知识通过 skills 注入
- Skills = 可注册、可替换、按任务条件触发的方法文档
- **两种唤醒，两份提示词**：用户直连用 SOUL.md；系统派工（contract session）时 SOUL 被 `before_prompt_build` 替换为 wake 提示词。两份**同从 role-spec 派生** per-role 个性（persona/qualityBar/operatingPrinciples），**全英文同源**。详见 [wake 提示词数据驱动](../decisions/wake-prompt-role-driven.md)

**违规信号：** SOUL 中出现具体数据文件名、领域专属字段说明、领域特有检查项 → 说明领域知识泄漏进了身份层。

## 为什么存在

- Agent 需要知道自己是谁才能正确行为
- 但身份定义必须与能力定义分离 — 否则换一个 skill 就要改 SOUL
- SOUL 越薄，token 成本越低，Agent 越容易理解自己的角色
- 身份稳定才能在不同任务间保持一致的行为模式

## 和谁交互

| 概念 | 关系 |
|------|------|
| [Agent Binding](agent-binding.md) | SOUL 是 AgentBinding 的运行时投影 |
| [Skill Boundary](skill-boundary.md) | Skills 注入能力，SOUL 定义身份，二者分离 |
| [Token Economy](token-economy.md) | SOUL 瘦身直接节省 token |
| [Workspace Guidance](workspace-guidance.md) | SOUL 是 workspace 中优先级最高的文件 |
| [wake 提示词数据驱动](../decisions/wake-prompt-role-driven.md) | 系统派工时 SOUL 被 contract-override 替换；两份提示词同从 role-spec 派生，全英文 |

## 演化

1. 早期：SOUL 是大而全的"Agent 手册"，包含一切指导
2. 备忘录56：提出身份与能力分离
3. 备忘录68：确立三层语义切分（role-spec/SOUL、skill、runtime/hooks/harness）
4. 核心设计指标：通用机原则固化 — SOUL 只写通用行为
5. 持续瘦身中：把领域知识迁移到 skills
6. 2026-05-31：role-spec 与 SOUL 模板全英文化；系统派工 wake 提示词数据驱动接入 role-spec（per-role 个性 + outputDirectives），消除「6 role 只 2 种 wake 提示词」真值分裂，删死字段 dispatchInstruction（源: [wake 提示词数据驱动](../decisions/wake-prompt-role-driven.md)）

## 当前状态

**永久原则。SOUL 瘦身持续进行中。** 通用机原则已确立。领域知识向 skills 迁移仍在推进。
