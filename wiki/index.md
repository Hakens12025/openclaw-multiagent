# Wiki Index

> OpenClaw 知识库索引。LLM 新 session 从这里开始导航。
> 首次编译: 2026-04-09，覆盖备忘录 15-100 + codex-memo + 桌面分析文档。
> 活跃刷新: 2026-04-14，已对齐到备忘录114/115 的四层联动编译版与 Harness 接口冻结入口。

## 核心原则 (永久)

| 页面 | 摘要 |
|------|------|
| [硬路径与软路径](concepts/hard-soft-path.md) | 第一原则：代码管流程，LLM 管内容 |
| [传送带原则](concepts/conveyor-belt.md) | 唯一 transport 原语：inbox→处理→outbox→停止 |
| [上下文隔离](concepts/context-isolation.md) | 多 Agent 存在的核心理由，worker 间不直接通信 |
| [防御纵深](concepts/defense-in-depth.md) | 多层安全防护，不依赖单一机制 |
| [Token 节约](concepts/token-economy.md) | 每个 token 都有成本，最小化无效消耗 |
| [Agent-系统交互最小化](concepts/agent-system-minimal-interaction.md) | 规则12：Agent 写内容，系统提取结构 |

## 系统架构

| 页面 | 摘要 | 状态 |
|------|------|------|
| [七层系统分层](concepts/system-layering.md) | L0内核→L1通讯→L2控制面→L3执行→L4评估→L5治理→L6投影 | 概念稳定 |
| [三层通讯协议](concepts/three-layer-protocol.md) | dispatch / system_action / delivery 三条业务协议族，wake 只是 transport | 稳定 |
| [AgentBinding](concepts/agent-binding.md) | 装配真值：绑定 role/skills/tools/model/policies 到 agent | 设计冻结 |
| [Graph Edge](concepts/graph-edge.md) | agent 间协作授权，运行时强制执行 | 稳定 |
| [合约 (Contract)](concepts/contract.md) | 任务载体，携带 assignee/replyTo，DRAFT 已消除 | 核心稳定 |
| [Loop](concepts/loop.md) | 传送带重复投递，pipeline 正在溶解 | 半完成 |
| [投递 (Delivery)](concepts/delivery.md) | 统一结果回送：terminal + system_action return variants | 稳定 |
| [Session 管理](concepts/session-management.md) | 合约独立 session，运行时主链已支持 deterministic session key | 部分实现 |
| [CLI System](concepts/cli-system.md) | 正式可操作表面层：hook / observe / inspect / apply / verify | 第一版实现 |
| [按需唤醒 (WakeEvent)](concepts/wake-event.md) | 运行时状态驱动的控制面唤醒机制 | 待实现 |
| [AgentGroup](concepts/agent-group.md) | 图原语：空间封装，与 Loop 的时间重复正交 | 待实现 |

## Agent 与角色

| 页面 | 摘要 | 状态 |
|------|------|------|
| [SOUL 身份化](concepts/soul-identity.md) | SOUL 只写通用行为，领域知识通过 skill 注入 | 永久原则 |
| [Skill 边界](concepts/skill-boundary.md) | 三层语义：role-spec(身份) / skill(方法) / runtime(保障) | 术语冻结 |
| [Planner](concepts/planner.md) | planMode 使任何 agent 成为规划者，DRAFT 消除 | 进行中 |
| [Evaluator](concepts/evaluator.md) | 去特殊化三桶拆解，worker + review 能力 | 设计完成 |
| [Operator](concepts/operator.md) | 运行时前台操作员，去伪智能化 | 部分实现 |
| [Workspace 引导](concepts/workspace-guidance.md) | agent 文档层级：SOUL优先，上下文按需 | 部分实现 |

## 执行与治理

| 页面 | 摘要 | 状态 |
|------|------|------|
| [Harness](concepts/harness.md) | 执行塑形层：当前优先冻结模块接口，而不是继续扩张术语 | 接口冻结中 |
| [评估结果链](concepts/evaluation-result-chain.md) | HarnessRun→EvaluationResult→AutomationDecision→ProfileLifecycle | 部分存在 |
| [自动化的自动化](concepts/automation-of-automation.md) | 长期演化层：消费正式运行结果与治理结果 | 方向稳定 |
| [零知识验证](concepts/zero-knowledge-verification.md) | Hook 观测约束下的可验证执行（执行轨迹+承诺检测） | 部分实现 |

## 前端与测试

| 页面 | 摘要 | 状态 |
|------|------|------|
| [Dashboard](concepts/dashboard.md) | NASA-Punk 前端，SVG 交互拓扑，纯 vanilla JS | 功能可用 |
| [测试系统](concepts/test-system.md) | test-runner.js 唯一入口，五层测试模型 | 功能可用 |

## 隐喻与框架

| 页面 | 摘要 |
|------|------|
| [大楼比喻](concepts/building-metaphor.md) | 系统=大楼，前台=controller，办公室=agent，包裹=contract |

## 决策页 (decisions/)

| 页面 | 结论 | 日期 |
|------|------|------|
| [dispatch 与 graph-based policy 保持分层](decisions/separate-dispatch-and-graph-router.md) | dispatch 族内继续分层，不退化成 god object | 04-02 |
| [SOUL 作为通用机](decisions/soul-as-generic-machine.md) | 不硬编码领域知识，通过 skill 注入 | 03-26 |
| [Agent 即分类器](decisions/agent-as-classifier.md) | 删除 regex 预分类，LLM 自然判断 | 03-18 |
| [Graph 作为运行时真值](decisions/graph-as-runtime-truth.md) | 运行时强制执行，不只是 UI 装饰 | 03-19 |
| [God Role 消除](decisions/god-role-elimination.md) | 只保留 bridge+worker，其余为 policy+skill 组合 | 03-31 |
| [Pipeline 溶解](decisions/pipeline-dissolution.md) | 删除 1717 行，loop-session 吸收 | 04-03 |
| [统一控制面](decisions/unified-control-plane.md) | 六路分发收敛为 graph+ingress+conveyor+lifecycle+loop | 03-26 |
| [Agent-系统交互最小化](decisions/agent-system-interaction-minimization.md) | [ACTION] 标记替代 JSON 文件协议 | 04-07 |
| [外部参考吸收策略](decisions/external-reference-absorption.md) | DeerFlow=执行层参考，AutoGenStudio=作者体验参考 | 03-28 |
| [Wiki 替代纯备忘录](decisions/wiki-over-memo-only.md) | code=WHAT, memo=RAW, wiki=WHY | 04-09 |
| [runtime-bridge 收编进 delivery](decisions/runtime-bridge-into-delivery.md) | delivery:terminal + system_action return variants | 04-08 |

## 状态与元信息

- [当前项目状态](status.md) — 活跃 initiative、阻塞、下一步
- [Wiki Schema](schema.md) — wiki 维护规则
- [操作日志](log.md) — 编译/lint 操作记录
