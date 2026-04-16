# Defense in Depth

> 安全不依赖单一机制，多层保护纵深防御。

## 是什么

系统安全通过多个独立层级实现，任何单点失效都不会导致完整突破：

1. **before_tool_call hook** — 拦截敏感路径读取
2. **API key regex 匹配** — 阻止密钥通过 sessions_send 泄露
3. **路径白名单验证** (`isPathWithin`) — 防止目录遍历攻击
4. **exec 命令内容扫描** — 阻止通过 CLI 读取密钥
5. **所有安全在代码中（hard-path）** — 不依赖模型行为

核心原则：安全措施写在代码里，不写在 prompt 里。LLM 不可信赖为安全边界。

## 为什么存在

- LLM Agent 有能力调用工具、读写文件、执行命令 — 攻击面天然存在
- Prompt injection 可以绕过任何基于 prompt 的安全指令
- 单层防御总会有绕过方式；多层交叉覆盖才能提供实际保护
- 系统需要在不可信环境中运行（用户输入、外部 API 返回值都可能包含注入攻击）

## 和谁交互

| 概念 | 关系 |
|------|------|
| [Hard-Soft Path](hard-soft-path.md) | 安全属于 hard-path，不依赖 LLM |
| [Zero-Knowledge Verification](zero-knowledge-verification.md) | 验证机制不需要知道被验证内容的细节 |
| [Agent-System Minimal Interaction](agent-system-minimal-interaction.md) | 减少 Agent 与系统的接触面，间接减少攻击面 |

## 演化

1. 核心设计指标 §七：确立为永久原则
2. 早期：仅有路径白名单
3. 逐步增加层级：hook 拦截 → API key 扫描 → exec 内容扫描
4. 原则固化：任何新增的 Agent 能力必须同时评估安全影响

## 当前状态

**永久原则。已实现。** before_tool_call hook 活跃，API key 扫描活跃，路径验证活跃，exec 扫描活跃。所有安全层均由代码保证。
