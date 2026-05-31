# Operator

> 系统运维优化的 meta-agent：一个 LLM 驱动的 agent，理解系统全貌→判断→规划→经 CLI-system 落地。

## 是什么（2026-05-31 认知校正）

**Operator 就是一个 agent（meta-agent）**，和 worker / planner 一样是 agent，**不是治理引擎、不是代码逻辑、不是只读观测者**。与普通 agent 的区别只在：

- **任务不同**：系统运维与优化，不碰具体业务任务。
- **有系统访问接口**：能改系统回路（普通 agent 不能）。
- **有了解系统全貌的知识库 + skill**，能力更强、权限更高。

「修改系统回路」只有 agent（LLM 驱动）能做到——需要理解、判断、规划。它**该**规划，这是本职，不是越权。

代码结构已还原成 agent 三件套：`lib/operator/operator-brain.js`（LLM 脑）/ `lib/operator-runtime.js`（薄壳，当前 63 行）/ `lib/operator/operator-executor.js`（落地）。知识库见 `operator-knowledge-library.js`。

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

## 演化

| 阶段 | 事件 |
|------|------|
| 备忘录 45 | 定义 operator 为系统级 agent |
| 备忘录 55 | 明确 operator 的管理端点和能力边界 |
| 备忘录 59 | De-pseudo-intelligence：拆 if-else 超级集合，**还原成真 agent**（brain/薄壳/executor），非削弱智能 |
| v109-stable | 零旁路收口达成：13 处直读 runtime store 全改经 `inspectCliSystemSurface`。源: 备忘录112/113/114 |
| 2026-05-31 | **认知校正**：operator = meta-agent（非治理引擎/只读观测者）；「去伪」正解 + 作废"不当第二 planner"措辞。源: 备忘录120 附录 / PLAN §6.5,P5 |

## 当前状态

- 实现：if-else 已拆、brain/薄壳/executor 已分离；但它的**「手」（经 CLI-system apply/verify）仍瘫**（`operatorExecutable` 全仓 =0）——强 agent 想改系统却落不了地。
- 待补：接口/知识/落地通道（见 [四关节自治闭环](self-governance-loop.md) P2.5/P3/P5）。
- 红线：不绕 CLI system 直读/直写真值（读侧已收口）。

相关概念: [system-layering](system-layering.md) | [agent-binding](agent-binding.md) | [hard-soft-path](hard-soft-path.md)
