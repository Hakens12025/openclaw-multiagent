# Wiki Operation Log

## [2026-04-12] protocol-sync | 备忘录106 协议命名与 delivery 真相对齐

更新 active wiki / active guide：
- concepts/three-layer-protocol.md
- concepts/delivery.md
- decisions/runtime-bridge-into-delivery.md
- decisions/separate-dispatch-and-graph-router.md
- decisions/graph-as-runtime-truth.md
- decisions/pipeline-dissolution.md
- status.md
- index.md
- schema.md

同步结果：
- dispatch / system_action / delivery / wake 的边界与代码一致
- runtime-bridge 不再被描述为仍受阻塞的独立路径
- active wiki 中的代码位置与当前文件名对齐到 `dispatch-entry.js / dispatch-transport.js / dispatch-graph-policy.js`

## [2026-04-09] init | Wiki 体系创建

创建 wiki 结构：schema.md、index.md、log.md、status.md。
首批编译：三层协议、硬软路径、传送带原则、dispatch/graph-router独立决策。
源: 与用户讨论 Karpathy LLM Wiki 模式的适配方案。

## [2026-04-09] ingest-full | 全量备忘录编译

一次性编译所有源材料：
- use guide/ 下 78 个活跃备忘录（备忘录15 ~ 备忘录100）
- Desktop/codex-memo/ 下 25 个 Codex 执行记录
- Desktop/零知识备忘录.md
- Desktop/OpenClaw备忘录演化分析_2026-03-31.md
- .codex/memories/openclaw-memory.md

产出：
- 29 个概念页 (concepts/)
- 11 个决策页 (decisions/)
- 更新 index.md（完整索引，按主题分类）
- 更新 status.md

覆盖的知识领域：
- 核心原则（6页）：硬软路径、传送带、上下文隔离、防御纵深、Token节约、交互最小化
- 系统架构（10页）：七层分层、三层协议、AgentBinding、Graph、Contract、Loop、Delivery、Session、WakeEvent、AgentGroup
- Agent与角色（6页）：SOUL、Skill边界、Planner、Evaluator、Operator、Workspace引导
- 执行与治理（4页）：Harness、评估结果链、自动化的自动化、零知识验证
- 前端与测试（2页）：Dashboard、测试系统
- 隐喻（1页）：大楼比喻
