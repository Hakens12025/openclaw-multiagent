# 系统分层 (System Layering)

> OpenClaw 的 7 层架构模型，定义每层职责边界，禁止跨层替代。

## 是什么

7 层自底向上的系统架构划分：

| Layer | 名称 | 核心对象 / 职责 |
|-------|------|-----------------|
| L0 | Kernel | AgentBinding, Contract, MessageEnvelope, EdgeSpec, LoopSpec, LoopSession, PipelineState, AutomationRuntimeState, ticket/ledger/lock/store — 系统原语，不含业务逻辑 |
| L1 | Communication | ingress.normalize（入口归一化）, conveyor.dispatch（传送带分发）, return routing（回程路由） |
| L2 | Control Plane | graph collaboration（图协作授权）, loop advancement（循环推进）, pipeline progression（流水线推进） |
| L3 | Execution Shaping | harness run, modules, profiles, evidence, failure classification — 塑造单次执行的质量 |
| L4 | Evaluation | EvaluationResult, judgment semantics — 对执行结果做判定 |
| L5 | Governance | AutomationDecision, ProfileLifecycle, capability evolution — 自动化治理与能力演化 |
| L6 | Projection | dashboard, devtools, operator UI — 只读投影层，不写回系统状态 |

**核心约束**：任何层不得跨越边界替代另一层的职责。L6 只读，L0 不含业务逻辑，L3 不做 L4 的判定。

## 深水区四层联动（交叉视图）

7 层模型继续有效。  
`Harness / CLI system / Operator / Automation` 不是对 7 层的替代，而是一条跨层交叉视图：

| 对象 | 在 7 层里的主要位置 |
|------|-------------------|
| Harness | L3 Execution Shaping |
| CLI system | 站在 runtime truth 之上的正式可操作表面，横跨 L2/L6 的消费面 |
| Operator | 治理消费者，主要读 L6 投影与 formal surface |
| Automation | L5 Governance |

编译版入口见 `备忘录114`。

## 为什么存在

- 防止职责混淆（历史上 pipeline-engine 同时做 L2 控制 + L3 执行 + L4 评估，导致 god object）
- 为渐进式重构提供方向：每次只清理一层的边界
- 让新 agent / 新功能知道自己该落在哪一层

## 和谁交互

- [AgentBinding](./agent-binding.md)：L0 原语之一
- [Hard/Soft Path](./hard-soft-path.md)：L1-L3 的执行路径选择
- [Harness](./harness.md)：L3 执行塑造的主要机制（如已存在）
- [EvaluationResult Chain](./evaluation-result-chain.md)：L4 核心对象链
- [Automation of Automation](./automation-of-automation.md)：L5 治理决策

## 演化

1. 备忘录77 首次提出 7 层模型
2. 备忘录92 审查确认分层合理性，指出 pipeline dissolution 应按层推进
3. 备忘录98 重申分层原则，确认 L6 只读约束

## 当前状态

概念模型稳定。当前新增风险不在“缺分层”，而在“跨层对象过多、接口冻结落后于名词扩张”。
