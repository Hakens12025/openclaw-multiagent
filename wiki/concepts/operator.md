# Operator

> 系统运维优化的 meta-agent：一个 LLM 驱动的 agent，理解系统全貌→判断→规划→经 CLI-system 落地。

## 是什么（2026-05-31 认知校正）

**Operator 就是一个 agent（meta-agent）**，和 worker / planner 一样是 agent，**不是治理引擎、不是代码逻辑、不是只读观测者**。与普通 agent 的区别只在：

- **任务不同**：系统运维与优化，不碰具体业务任务。
- **有系统访问接口**：能改系统回路（普通 agent 不能）。
- **有了解系统全貌的知识库 + skill**，能力更强、权限更高。

「修改系统回路」只有 agent（LLM 驱动）能做到——需要理解、判断、规划。它**该**规划，这是本职，不是越权。

代码结构已还原成 agent 三件套：`lib/operator/operator-brain.js`（LLM 脑）/ `lib/operator-runtime.js`（薄壳，当前 78 行，叠在 `operator/operator-brain.js` + `operator-executor.js` + `operator-plan.js` 之上）/ `lib/operator/operator-executor.js`（落地）。知识库见 `operator-knowledge-library.js`。

当前主要读侧：`lib/operator/operator-snapshot.js` / `operator-surface-policy.js`。

## 零旁路红线（北极星）

operator **不得绕过 [CLI System](cli-system.md) 直读 runtime store**。

v109-stable 达成：`operator-snapshot.js` 原先 13 处直读 runtime store（harness-run / graph-loop / loop-session / schedule / agent-join / test-runs / agent-graph / guidance-drift / delivery-ticket / pending-signal / work-items / admin-change-sets / automation-runtime）全部改经 `inspectCliSystemSurface(...)`（14 个 `inspect.*` surface），行为等价。

余下跨模块 import 皆合法：纯算法（detectCycles）、静态配置、LLM planner、常量（runtime-status / capability-registry / normalize）。

v110-stable 起，HTTP 投影（`routes/api.js` 的观测 read-route）同样经 inspect surface —— operator 与 HTTP 是同一条观测读路径的两个消费者，判据见 [CLI System](cli-system.md#inspect-surface--观测读取唯一碰-store-的入口一条路径)。

## 「去伪智能化」的正解（纠正反向理解）

之前误把 operator 写成 **if-else 超级集合**（确定性代码假装智能，历史 `operator-runtime.js` 曾 1677 行）。

**「去伪」= 拆掉 if-else 还原成一个真 agent**（brain / runtime 薄壳 / executor），**不是限制或削弱它的智能**。约束在**落地纪律**（代码护栏），而非剥夺智能：

- 经 [CLI System](cli-system.md) 的 apply / verify 落地，不直写真值、不绕 handler、不直改代码。
- 读正式 inspect 派生视图，不做散乱查询。
- 改动可审计、可回滚（全局熔断一键回 spec 默认）。
- brain 不可用时如实说明，**不伪造**确定性计划。

management 的精妙 = 给这个强 agent 配好接口 / 知识 / 落地通道，**不是**把它降级成代码。

> ❌ 作废措辞：「operator 不当第二 planner」「只能 advice_only」「受确定性约束」——那是把"拆 if-else"误读成"限制 agent 智能"。它该规划。

## 为什么存在

- 给系统一个能自己运维优化的 meta-agent —— 改系统回路需理解/判断/规划，只有 agent 能做。
- 让它的动作走 formal surface 落地，而不是手写补丁或直改代码。
- 读真值也走 surface：runtime truth 只有一条对外读路径，operator 无法形成第二真值视角。

## 和谁交互

- 吃 runtime truth
- 通过 [CLI System](cli-system.md) 操作系统
- 消费 [Harness](harness.md) 的证据
- 结果可继续喂给 automation

## 设计者 vs 运行者边界

operator 是**结构设计者**，不是任务运行者。它 DESIGN 的是结构 + agent 内容：`agents.create` / `agents.role` / `agents.tools` / `skills.create`（领域方法作为 skill 编写）+ `agents.skills` / `graph.edge.add` / `graph.loop.compose` / `graph.group.compose`。

一次 build plan 的**正确终态** = 结构 active（授权边 / LoopSpec 存在但尚未运行）+ `inspect.structure_preview` 给用户预览。operator **绝不**在 build plan 末尾 emit `runtime.loop.start` 携带用户的具体一次性任务——「跑」是用户的下游动作（线性管线由 ingress 把任务随 contract 投进入口 agent inbox；回路由用户显式触发 `runtime.loop.start`）。判据见 `lib/operator/operator-brain.js`:~210 + `operator-knowledge.js` 的 `new-task-workflow` 片段（`sourcePath: skills/operator-new-task/SKILL.md`）。

## 可靠性

planner 调用做了多重兜底：

- **single-retry**：`callPlannerWithSingleRetry`（`operator-brain.js`），但 abort / GLM-socket 失败首次即重抛，retry 不掩盖 provider 故障。
- **resilient step-drop normalize**：`normalizeOperatorBrainPlanResult`（`operator-plan.js`）只丢掉无法执行的坏 step、保留有效步骤并附 warning，不再因一个幻觉 step 而整盘丢弃（EXECUTE 路径仍严格）。
- **glm-socket dispatcher + 截断 JSON 修复**：`lib/llm-planner.js`（`repairTruncatedJsonText` 修 glm-style 截断流 + dispatcher 处理 reasoning 模型长耗时）。
- **GLM-5.1 fallback**：`resolveOperatorBrainModel`（`lib/brain-model-resolver.js`）。
- **紧凑 agent-map 片段**（`operator-knowledge.js` 的 `buildAgentMapFragment`）是 operator 读结构的视图。

## 演化

| 阶段 | 事件 |
|------|------|
| 备忘录 45 | 定义 operator 为系统级 agent |
| 备忘录 55 | 明确 operator 的管理端点和能力边界 |
| 备忘录 59 | De-pseudo-intelligence：拆 if-else 超级集合，**还原成真 agent**（brain/薄壳/executor），非削弱智能 |
| v109-stable | 零旁路收口达成：13 处直读 runtime store 全改经 `inspectCliSystemSurface`。源: 备忘录112/113/114 |
| 2026-05-31 | **认知校正**：operator = meta-agent（非治理引擎/只读观测者）；「去伪」正解 + 作废"不当第二 planner"措辞。源: 备忘录120 附录 / PLAN §6.5,P5 |
| v119-stable | AgentGroup 宏展开本体上线，operator 可经 `graph.group.compose` 设计组 |
| v120-stable | LoopSpec 自带 maxRounds/maxExperiments，operator 可建带预算的回路 |
| v121-stable | loop reviewer 环节卡死修复（heartbeat artifact-branch 认已绑定 contract=有活干） |
| 本会话 | **手已通**：38 个 operatorExecutable surface 上线 + executor 真跑 plan（structure-snapshot 回滚 + forceVerify）；明确 **designer-only** 边界（设计结构+agent 内容，不替用户跑任务，不 emit `runtime.loop.start`）；planner 可靠性批次（single-retry/resilient-normalize/glm-socket/GLM-5.1 fallback） |

## 当前状态

- 实现：if-else 已拆、brain/薄壳/executor 已分离；**「手」已通**——38 个 `operatorExecutable` surface 已上线（`lib/admin/catalog/apply-rest.js` 28 + `agents-apply.js` 10）。`operator-executor.js` 的 `executeOperatorExecutablePlan` 真跑 plan：逐步 `executeCliSystemSurface`（`actor='operator'`）+ explicit-confirm 闸（破坏性 surface 需显式确认）+ 多步 structure-snapshot 原子回滚 + forceVerify-after-apply + soft-fail（`{ok:false}`）也回滚。自治死链 (b) 已闭——见 [四关节自治闭环](self-governance-loop.md)。
- 边界：designer-only——建好结构 active + `inspect.structure_preview` 即交付完成，跑由用户下游触发。
- 红线：不绕 CLI system 直读/直写真值（读侧已收口）。

相关概念: [system-layering](system-layering.md) | [agent-binding](agent-binding.md) | [hard-soft-path](hard-soft-path.md) | [四关节自治闭环](self-governance-loop.md)
