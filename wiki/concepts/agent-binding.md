# AgentBinding

> 将 role/skills/tools/model/policies/router 绑定到一个 agent 的唯一装配真值源。

## 是什么

AgentBinding 是 9+1 对象模型中 Assembly 层的核心对象，负责将一个 agent 的所有组成部分绑定为一个整体。

**9+1 对象模型（4 层）**：

| 层 | 对象 |
|----|------|
| Semantic | RoleSpec, SkillSpec, ToolSpec |
| Assembly | **AgentBinding**, EdgeSpec, LoopSpec |
| Runtime | ContractSpec, MessageEnvelope |
| Projection | ProjectionSpec |
| 派生 | EffectiveProfile（系统计算，不可手编） |

**AgentBinding 绑定内容**：
- role — 角色定义（RoleSpec 引用）
- skills — 技能集合（SkillSpec 引用列表）
- tools — 工具权限（allow/deny）
- model — 使用的 LLM 模型
- policies — 执行策略
- router — 路由配置

**关键原则**：
- SOUL.md、AGENTS.md、agent-card.json、前端卡片都是 **投影**，不是真值源
- EffectiveProfile 是系统从 AgentBinding + 上下文计算得出的，禁止手工编辑
- executionPolicy schema（god-role 消除期间引入）：planMode, noDirectIntake 等字段

## 为什么存在

- 消除 "agent 定义散落多处" 的混乱：以前 AGENTS.md 说一套、agent-card.json 说一套、代码又是一套
- 建立单一真值源：所有关于 "这个 agent 是什么 / 能做什么 / 怎么做" 的问题都在 AgentBinding 回答
- 支持 god-role 消除：executionPolicy 让每个 agent 有明确的执行约束，不再依赖 controller 万能角色

## 和谁交互

- [System Layering](./system-layering.md)：AgentBinding 是 L0 Kernel 原语
- [SOUL/Identity](./soul-identity.md)：SOUL.md 是 AgentBinding 的投影，不是来源
- [God-role Elimination](./god-role-elimination.md)：executionPolicy 是消除万能角色的关键机制

## 演化

1. 备忘录57 正式定义 9+1 对象模型，确立 AgentBinding 为装配核心
2. God-role 消除过程中引入 executionPolicy schema，赋予每个 agent 独立执行约束
3. 备忘录86 进一步完善 AgentBinding 与 EffectiveProfile 的计算关系

## 当前状态

**设计冻结**。实现部分完成——executionPolicy 已存在并在运行时生效，但完整的 binding combiner（从 AgentBinding 自动计算 EffectiveProfile 的流程）尚未构建。当前仍有部分 agent 配置散落在 AGENTS.md 等投影文件中。
