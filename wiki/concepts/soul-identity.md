# SOUL & Identity

> SOUL.md 是**纯用户人格**（⑤层），系统永不重写；role 角色人格已拆到 IDENTITY.md（④层）。

## 是什么

经[六层装配](prompt-assembly.md)重构后，SOUL 与 role 是两个独立载体：

- **SOUL.md（⑤层，用户拥有）** —— 纯用户人格。无 managed marker，系统永不重写（`writeIfMissing` 只在缺失时种一个英文占位）。用户打开 SOUL 看到的全是自己写的内容。
- **IDENTITY.md（④层，平台托管）** —— role 角色人格的载体，由 `renderRolePersonaBlock(role)` 生成、带 marker、随 role 重生成（思维姿态 / 质量底线 / 决策倾向 / 默认准则）。

**SOUL 应该包含的：** 用户自定义的角色人格 / 偏好（用户自己的内容，任意语言）。

**SOUL 不应该包含的：**
- role 角色话术（思维姿态/质量底线等）—— 那是 ④role，住在 IDENTITY.md，不再烘焙进 SOUL。
- 硬编码的 skill 列表、tool 列表、拓扑信息（装配清单，不是身份）。
- 具体数据文件名、领域特有字段说明、领域特有检查项。

**关键区分：**
- ⑤SOUL = 用户内容；④role = 平台托管人格。两者解耦后各自独立演化。
- SOUL 是通用机器：领域知识通过 skills 注入。
- Skills = 可注册、可替换、按任务条件触发的方法文档。

**违规信号：** SOUL 中重新出现 role 话术或领域专属字段 → 说明 ④role/领域知识又泄漏回了用户身份层。

## 为什么存在

- Agent 需要知道自己是谁才能正确行为
- 但身份定义必须与能力定义分离 — 否则换一个 skill 就要改 SOUL
- SOUL 越薄，token 成本越低，Agent 越容易理解自己的角色
- 身份稳定才能在不同任务间保持一致的行为模式

## 和谁交互

| 概念 | 关系 |
|------|------|
| [Prompt 装配](prompt-assembly.md) | ⑤SOUL / ④IDENTITY 是六层装配里的两层 |
| [Agent Binding](agent-binding.md) | role（→IDENTITY）是 AgentBinding 的投影；SOUL 是用户内容 |
| [Skill Boundary](skill-boundary.md) | Skills 注入能力，SOUL/IDENTITY 定义身份，二者分离 |
| [Token Economy](token-economy.md) | SOUL 放装配末尾，服务前缀缓存命中 |
| [Workspace Guidance](workspace-guidance.md) | SOUL 用户拥有 / IDENTITY 平台托管 |

## 演化

1. 早期：SOUL 是大而全的"Agent 手册"，包含一切指导
2. 备忘录56：提出身份与能力分离
3. 备忘录68：确立三层语义切分（role-spec/SOUL、skill、runtime/hooks/harness）
4. 核心设计指标：通用机原则固化 — SOUL 只写通用行为
5. 持续瘦身中：把领域知识迁移到 skills
6. **本次重构：role 人格从 SOUL 拆出**，落到托管 IDENTITY.md（④层）；SOUL 重置为纯用户占位（⑤层）；一次性迁移闸 `scripts/migrate-soul-identity.js` 已对 9 个 agent apply。role 人格 + SOUL 占位**全部英文化**。见[决策](../decisions/role-soul-wake-decoupling.md)。

## 当前状态

**永久原则。role/SOUL 解耦已落地（单测全绿）。** ⑤SOUL=纯用户、④role=托管 IDENTITY 的分离已固化；领域知识向 skills 迁移仍在推进。
