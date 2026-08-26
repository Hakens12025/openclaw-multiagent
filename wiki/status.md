# 项目状态

> 最后更新: 2026-08-09（v181-stable = `3dd428a`；此后 `cabf494` 知识切分器 A/B 定案已入库；`_manifest.json` 机制删除批 + 本次知识清扫在飞未提交）

## 当前位置

- **v179-stable · 动态协作解绑图边 + FC 接线全通**:图退回**固定管线**的定义,动态协作自己指定目标(约束回到角色策略),`metadata.pipeline` 让一张图两种读法;新建 agent 按角色派生 FC 工具(此前 `createAgentDefinition` 根本不写 tools,新 agent 生来零协作工具);`ls`/`grep` 三处同步发放;真正的教学面是 `skills/system-action/SKILL.md`(工作区文档对 executor/researcher/reviewer/planner 不生成),已从教 `[ACTION]` 改成教工具;降级写法挂进结构化拒绝。两个 live 实验:新提示词下 L1 受理 100% 通过;故意堵死 FC 后 planner 自己找到降级路并写出合法标记。源: 备忘录135
- **平台解耦两刀(已落地)**:判据="没读过文档的新 agent 进来能不能干活"。刀2 上游取件条带清单 `{path,producer,files[],primary}`(`50cd0dc` artifact 侧 + `50caf46` prompt 侧);刀1 采集取消 `runtime_result.json` 提交令牌(`b2a98a0`,拆开看它只有 `status:failed/awaiting_input` 承重)。**刀3(primary 取消猜测档)未做**,触判决面。**`submit_output` 工具尚未建**,所以承重职责仍悬在降级路上。源: 备忘录136
- **`_manifest.json` 机制彻底删除(工作区在飞,未提交)**:agent 不该写平台账本;上游包清单改由平台在拷贝时直接产出。同批含 `/simplify` 修掉的两处自伤(`explicitRuntimeResult` 硬编码 true 曾让硬停闸的两个析取项恒真;`primary` 可能指向被溢出裁掉的文件)。源: 备忘录137
- **层级口径纠正**:`[ACTION] {json}` 是 **L2**(自完善),`[ACTION] delegate x — y` / `[STAGE]` 这类自然语言才是 **L3**。此前长期把 JSON 叫 L3

- **统一 FC 证据面(spec 2026-07-27)**P2-P6 全部完成****:P2 授权单源+证据面主干(批次一)、评审腿 contract 化+systemAction 数组化+协作 FC 工具面 v1+expectations 字段+B5 终态链读 trace(批次二)均已落地并 live 验收——回流链后半段(verdict 车道→票据 resolve→worker exact-session resume)四轮实验修通。P4 binding(工具面挂载+L1 全链 live 验收:中场工具调用→凭证→collab 证据→B5 合成→verdict 回流全环闭合)。P5 preset 三层化(四案三层合约会话探针,基线 11/26→28/34,L1 两案连续全绿;残余闪断=L0 插件多实例分脑+collectOutbox 静默吞错,已停靠)。P6 考官落地(纯代码期望↔trace 三态判决,幂等判决账本 evaluation-verdicts.json,collector.trace/guard.tool_access 换真证据,EvaluationResult 转正)。蓝图主线完结,后批工具按需解锁。详见备忘录128 三点一〇〇。

- **operator 手已通**：operator-executor 落地经 CLI apply（`operatorExecutable` surface，2026-08-09 抽样 50 个）+ structure-snapshot 原子回滚 + forceVerify-after-apply。死链 (b) 闭合。废弃旧记「operatorExecutable=0 / 手仍瘫」。
- **operator 旗舰硬化（designer-only）**：operator 设计结构 active 即终态，跑由用户下游触发（把任务投进入口 agent inbox）。配套 planner 可靠性：single-retry / resilient-normalize（坏 step 丢单步保全盘）/ feasibility 预检 / GLM-socket 区分（abort/socket 失败不被 retry 掩盖）。进行中任务 #57 / #58。
- AgentGroup（v119 宏展开）、ProfileLifecycle（`lib/automation/profile-lifecycle.js`，streak→trustLevel→governanceSnapshot）均**已落地**。HarnessModule **已随 harness 全退役删除（v226，2026-08-23，备忘录149/150）**。
- **2026-05-30 全面修复完成（W0-W8）**：核心正确性/安全/真值/架构已修，卫生层 god-object 部分拆分（64→约 28 非测试 JS），详见备忘录119。
- 系统真值 v5.1 主线已落地：managed guidance、typed wake、pending-signal registry、execution epoch、controller/operator 边界、QQ `[ACTION]` 收口、bare max tool budget 退休。
- runtime graph 是**固定管线拓扑**真值（不是协作授权真值——协作授权在 `collaboration-intent-policy` 角色表）；queue、claim、drain、heartbeat actionability 均由 runtime 状态决定。
- `prompt-craft` 已收口为 OpenClaw Prompt Standard：minimal useful prompt，协议真值留在 runtime 对象与正式 surface。
- CLI system / Harness / Operator / Automation 继续按四层联动看待：执行塑形、可操作表面、治理消费、长期演化。

## 当前活跃拓扑

controller + planner + worker + worker2/worker-N。operator 是隐藏 runtime control agent，入口在 runtime operator surface，不进入主 agent 视角。

## 当前最直接的架构债务

1. **god-object 剩余约 28 个**（前端 9 个 dashboard IIFE/闭包态；qqbot gateway.ts=1593 行；少数后端纠缠）— 需先补测试基础设施再拆。
2. **OUTBOX_COMMIT_KINDS 单源化** — 格式变更/循环依赖，需独立任务。（原并列的「Path B（loop-session）完全引用化」随 2026-08-18 回路退役自动消解。）
3. **reviewPolicy schema、WakeEvent** — 骨架未落地，按 Q1 搁置。（AgentGroup 已于 v119 落地，移出此项。）
4. **automation trustLevel / profile-lifecycle 治理链** — 已落地（v115），闭环 E2E 已断言。
5. ~~**agent-graph.json 补边**（worker-3/4/operator/reviewer 不可达）~~ — **已作废**：动态协作不再查图边，"不可达"不再阻断协作。仍需注意的只有产物包：目标没有图入边时上游包不入仓。
6. **HarnessModule 与 CLISurface schema 仍需完全冻结** — 接口对象已经存在，schema / docs / guard 需要继续收口。

## 阻塞关系

```
prompt 标准未被 guard 化
  → agent-facing 文案容易重新承担 runtime truth

queue 并发证据不足
  → live simple/complex 稳定性难以区分系统故障与模型故障
```

## 方向已冻结、接口待实现的重要对象

| 对象 | 来源 | 状态 |
|------|------|------|
| WakeEvent / typed wake envelope | 备忘录84 / 118 | typed envelope 主线已落地，持续清理旧 string 语义 |
| ExecutionObservation + TerminalOutcome | 备忘录100 | 主干已部分落地，仍待消费面继续统一 |
| AutomationDecision + ProfileLifecycle | 备忘录80 | **已落地**（v115，`profile-lifecycle.js` + `inspect.profile_lifecycle`，闭环 E2E 已断言） |
| reviewPolicy schema | 备忘录88 | 概念设计完成 |
| AgentGroup 图原语 | 备忘录85 | **已落地**（v119 宏展开，`agent-group-spec.js` + `inspect.agent_groups`） |
| HarnessModule formal interface | 备忘录115 | **已退役 v226（2026-08-23）**，随 harness 全退役删除（备忘录149/150） |
| OpenClaw Prompt Standard | 2026-05-04 清洁批次 | 已落到 `skills/prompt-craft/SKILL.md`，guard 已接入 |

## 下一步建议（2026-08-09 重排，按解锁价值而非工作量）

**未做事项全清单见 [备忘录137](../use%20guide/备忘录137_[主]_未做事项全清单与过时知识清扫_2026-08-09-1700.md)（15 项，带前置依赖）。** 摘要：

1. **submit_plan spec §9 三点裁决** — 无技术前置，几分钟，一次解锁 submit_plan required 态与刀3 的 expectations 第①档。依赖链上成本最低的解锁点。
2. **补齐 wiki 三个概念页（P0-2）** — 全清单里唯一没被任何封存挡住的事项；`platform-agent-decoupling.md` 至今挂着 `three-system-boundary.md` 的幽灵链接。
3. **两处死文本 + 两个既有缺陷** — 均无前置：`GRAPH_COLLABORATION_BLOCKED` 零消费者死常量、`health-node.js` 触发条件已满足的回落注释；`sessionStartMs` 被 executor handler 吞掉（陈旧文件隔离退化成 fail-open）、`.stale` 目录混进 readdir 名单（copyFile EISDIR）。
4. **`submit_output` 工具** — 平台/agent 解耦的收尾；不建它，新 agent 就仍必须知道一个私有约定文件名才能表达失败。
5. 判决面那批（拆 `contract-outcome.js` → `OPENCLAW_DISABLE_JUDGMENT` 开关 → 三套判据收敛）须按「建新址→逐板块改消费者→拆桥」三段式走，单 commit 过不了 block-check。
