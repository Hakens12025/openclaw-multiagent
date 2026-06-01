# Skill Boundary

> 三层语义切分：role-spec/SOUL（身份）、skill（可复用方法）、runtime/hooks/harness（硬保证）。

## 是什么

明确区分系统中三个经常被混淆的概念层级：

**三层语义切分（备忘录68）：**

| 层级 | 内容 | 职责 |
|------|------|------|
| role-spec / SOUL | 身份定义 | 我是谁、思维姿态、质量底线 |
| skill | 可复用方法文档 | 可注册、可替换、可复用的能力描述 |
| runtime / hooks / harness | 硬保证 | 代码级强制行为，不依赖 LLM |

**术语辨析：**

- **Skill**: 可注册、可替换、可复用的能力文档。**不是** 权限、工具、边、或身份
- **Tool**: 有明确 I/O 的可执行接口。**不是** 角色或协作关系
- **Capability**: 平台视角的有效能力（装配结果）。**不是** 身份定义

**实现组件：**
- `role-spec-registry.js` — 角色规格注册
- `semantic-skill-registry.js` — 语义 skill 注册
- `agent-card-composer.js` — Agent 卡片组装

**被否决的方案：**
- 创建四个自动注入的"行为准则 skill"（planner-conduct, executor-conduct 等）— 会把角色身份降级为"可选插件"

**platform-map skill：**
- 导航地图，告诉 Agent 去哪里看、往哪里写、什么时候用 system_action

## 为什么存在

- 没有清晰边界时，身份、能力、权限容易混在一起 — 改一个影响全部
- Skill 必须可替换：换掉一个 skill 不应该改变 Agent 的身份
- 身份必须稳定：Agent 在不同任务间应保持一致的行为模式
- 硬保证必须在代码中：不能依赖 LLM 自觉遵守规则

## 和谁交互

| 概念 | 关系 |
|------|------|
| [SOUL & Identity](soul-identity.md) | SOUL 是身份层，skill 是能力层，二者分离 |
| [Agent Binding](agent-binding.md) | AgentBinding 装配 SOUL + skills + tools |
| [Operator](operator.md) | Operator 定义 Agent 的运行约束 |
| [Hard-Soft Path](hard-soft-path.md) | 硬保证层 = hard-path |

## 演化

1. 早期：SOUL 包含一切，没有分层
2. 备忘录44：开始讨论能力与身份的分离
3. 备忘录56：正式提出 skill 作为独立概念
4. 备忘录68：三层语义切分确立，术语冻结
5. 注册机制实现：role-spec-registry, semantic-skill-registry, agent-card-composer

## 当前状态

**术语已冻结。通过注册机制实现。** 三层切分是系统设计的基础共识，不再变更。
