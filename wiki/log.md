# Wiki Operation Log

## [2026-05-31] ingest | v120-stable 环自带 limit + skill 因果链沉淀 + 检测环≠受控loop

- concepts/loop.md — 是什么加「检测到的环≠受控loop」「环自带limit」两块；LoopSpec 增声明式 maxRounds；演化加 v120 行；当前状态加 registered loop 自带 round 上限兜底
- concepts/skill-boundary.md — 演化 6：skill 可从已验证成功 HarnessRun 自动沉淀（因果链 When/Pro/Con，EvaluationResult 评判非 LLM 自评，区别 Hermes 自评）
- concepts/self-governance-loop.md — 当前状态加 v120「能力固化」闭环末环（skill 随使用自增长）
- decisions/cycle-vs-registered-loop.md — 新建：有环=授权拓扑≠driven loop；前端不自动注册（entry/conclude 猜不出）；环自带 limit 复用 budget governance 不造第二套；否决自动注册/裸环并行 governor

代码核实（code wins）：`lib/loop/{loop-budget,graph-loop-registry,loop-round-runtime,loop-session-normalize}.js` + `admin-surface-graph-operations.js`（composeGraphLoop 转发 entry/信号/maxRounds）+ `dashboard-graph.{js,css}` + `automation-skill-precipitation.js`。全 gate 1544/1544，loop-spec 单测 7/7，loop-platform 结构 1/1，researcher1→worker-e→reviewer1 已注册 active maxRounds=4。
源: 备忘录120 + commit 3dd81b7（v120-stable）。

## [2026-05-31] ingest | wake 提示词数据驱动接入 role-spec（已实施，方案 A）

提案落地（见同日 proposal 记录）。wake/SOUL 全英文化 + role 个性数据驱动同源。

- decisions/wake-prompt-role-driven.md — 状态 提案→ACCEPTED；补收法决策（(b)+全英文）、改后数据流、实施结果（3 生产文件 + 7 测试英文化 + 2 mock 清理）、范围注记（范围 1）
- concepts/soul-identity.md — 关键区分加「两种唤醒，两份提示词」；和谁交互加 wake 提示词行；演化加 2026-05-31 行
- index.md — 决策表该行去「提案」前缀

代码核实（code wins）：
- `buildContractSessionSystemPrompt`（`hooks/before-prompt-build.js` 真实注入）从 role-spec 派生 `## Role` + `outputDirectives`；`getDispatchInstruction` 改前生产零消费（确认死字段）已删。
- 完整串行门 **1544/0**。范围(1)：executor/reviewer 产出 bullet 仍同，差异在 `## Role`；reviewer `[BLOCKING]` 格式块仍只在 SOUL。
源: 讨论 2026-05-31 + 本次实施 commit（待打 tag）。

## [2026-05-31] proposal | wake 提示词数据驱动接入 role-spec（待 review）

调研发现真值分裂：系统派工(wake)提示词与 role-spec/SOUL 设计脱节——wake 实际只 2 种(planner / 其余 5 个共用)，per-role 个性(reviewer 的 [BLOCKING]、researcher 的证据原则)在 wake 时全失效；`dispatchInstruction` 是死字段(仅 4 个测试消费，`lib/` 生产零消费，framework 不读)。

- decisions/wake-prompt-role-driven.md — 新增提案(方案 A)：`buildContractSessionSystemPrompt` 从 role-spec 数据驱动派生 per-role 个性段 + 用 `getDispatchInstruction(role)` 替代 `if(role===PLANNER)` 特化分支 + 死字段接活。否决 B(两套提示词合一，SOUL.md 文件 vs 内联替换载体不同需单独手术)/C(只清死字段，放弃 wake 设计)。
- index.md — 决策表加该提案行（标「提案(待实施)」）。

状态：待用户 review 批准；批准+实施后升 ACCEPTED 并编译 concepts/soul-identity.md（补「wake 时 SOUL 被 contract-override 替换、且该提示词同样应从 role-spec 派生」缺失事实）。
调研真值：`lib/contract-session-prompt-override.js` / `lib/role-spec-registry.js` / `lib/soul-template-builder.js` / `lib/agent/agent-session-system-prompt.js`；消费链 grep 确认 `getDispatchInstruction` 生产零消费。

## [2026-05-31] ingest | v115 四关节自治回路物理闭合（三死链全修）

备忘录120 计划的回路落地：三死链全部接通，端到端闭环已断言。

- concepts/self-governance-loop.md — 三死链表从"待修"→"v115 全部闭合"（标各修复机制与代码位置）；回路图改为"已实接"；E2E 判据补测试文件名；新增安全阀段（熔断 governanceSnapshotDisabled / retired 复活）；当前状态改为"回路物理闭合"
- concepts/automation-of-automation.md — 演化加 v115 行（ProfileLifecycle 已建 / resolveGovernance 合流点 / reworkGuidance 接通 / 安全阀）；当前状态缺口改为"核心回路已闭合"
- concepts/harness.md — 新增「灵魂落地」节（Run-Shape Map / soft 反逼 / Meta-harness 严格闸，P0/P0.5）

代码核实（code wins，纠正两处）：
1. reworkGuidance 现 8 处消费（原 0），resolve-governance.js / profile-lifecycle.js / run-shape-map.js / soft-guidance.js 均存在；governanceSnapshotDisabled 安全阀真实。闭环测试 `automation-profile-lifecycle-closed-loop-p4.test.js` 断言 provisional+连3pass→**stable**→resolveGovernance 读到收紧值。
2. **死链(b)实修法 = 裁定 admin-surface 为唯一 apply 真值源**（apply 链路本就活，纠正"手全瘫"误判）；catalog 里 `apply.*`/`verify.*` 仍 0 条目、operatorExecutable 仍 0——apply/verify 走 admin-surface 层（admin-change-set-commit-gate.js + admin-change-set-verification.js），不是 cli-surface catalog 条目。wiki 据此如实记，未写"operatorExecutable 翻 true"。
3. 闭环判据用 **stable**（非备忘录120 旧记的 experimental）——以测试断言为准。

同步：index.md 刷新注记到 v115 + 自治闭环行状态改「回路闭合」。
源: `docs/PLAN-four-joint-self-governance-2026-05-31.md`（全阶段）+ 各阶段 commit。

## [2026-05-31] ingest | operator 定位认知校正（之前理解反了）

纠正之前把 operator 写成"治理脑/治理引擎/只读观测者/不当第二 planner"的反向理解。

- concepts/operator.md — 定位改为 **meta-agent**（系统运维优化的 LLM 驱动 agent，非治理引擎/代码逻辑/只读观测者）；新增「去伪智能化正解」节（=拆 if-else 还原真 agent，非削弱智能；约束在落地纪律=apply/verify 落地+可审计回滚+brain 不可用如实说明）；作废"不当第二 planner/advice_only/受确定性约束"措辞；演化加 2026-05-31 校正行；当前状态改为"if-else 已拆但手仍瘫（operatorExecutable=0）"
- concepts/self-governance-loop.md — P5 改为"还原为真 meta-agent + 配好接口/知识/落地通道"；红线 6 改为"operator 是真 meta-agent 非 if-else 引擎，约束在落地纪律非剥夺智能"

代码核实（code wins）：`lib/operator/` 已有 brain/executor/knowledge-library，`operator-runtime.js` 当前仅 63 行薄壳（历史 1677 行 if-else 已拆）；`operatorExecutable` 全仓 =0（手仍瘫，待 P2.5/P3/P5）。

同步：
- index.md operator 行状态改为「认知校正」+ 刷新注记

源: 备忘录120 附录 / `docs/PLAN-four-joint-self-governance-2026-05-31.md` §6.5,P5,红线6。

## [2026-05-31] ingest | 角色重定义(planner=简报/worker=加厚)+ 模型适配结论

接产物整包流转：补 `decisions/artifact-package-flow.md` 的「配套」节。
- 角色重定义：planner 产工作简报 +「STAGE」阶段计划（理解/大纲/约束/该交付什么），worker 据上游简报产真交付物；修了 worker 复读。
- **模型适配诚实记录**：MiniMax-M2.5 + 提示词做不到「planner 纯提纲」——三级强化（SOUL 原则→提纲模板→dispatch 重构）后仍产完整正文，最狠版还让 planner 只写 runtime_result 不产简报（complex-02 协作丢失）。回退到「结构化首版→worker 加厚」可靠版（用户拍板接受）。
- 落地 v113-stable：artifact-store 整包 + preserve_artifact 单交付物回退 + role-spec/soul-template 角色重定义 + 正向文案守卫。线上 multi/complex 各 3/3 实证。

## [2026-05-31] ingest | 备忘录120 四关节自治闭环系统计划

新建 `concepts/self-governance-loop.md`（脑-手-工具-自治四关节闭合成带反馈真值回路）：
- 愿景（用得越多越顺=系统级自适应自治）
- 三处真死链（经代码核实，纠正"action 无 dispatch"误判）：reworkGuidance 零消费 / cli-system 无法真执行(apply/verify catalog 0、operatorExecutable=0) / governanceSnapshot 无读取合流点
- 自治反馈回路 + E2E 闭环判据；对象链尾段 ProfileLifecycle 唯一未建
- 阶段计划 P-1→P7（建议起点 P-1+P0+P1）+ 11 条红线纪律

交叉链接：evaluation-result-chain / harness / cli-system / operator / automation-of-automation / conveyor-belt。

增量更新：
- concepts/automation-of-automation.md — 演化加 2026-05-31 行 + 缺口指向 self-governance-loop
- concepts/cli-system.md — **代码核实纠正**：inspect.* = 23（非旧记 22，漏记 v112 的 session_system_prompt），全族编目 28 条；补 apply/verify catalog 0 + operatorExecutable 全仓 0 的事实（死链 b）

同步：
- index.md 「执行与治理」节加四关节自治闭环入口 + 刷新注记到 2026-05-31

性质=规划稿（待用户拍板优先级），非已落地真值。源: 备忘录120 / `docs/PLAN-four-joint-self-governance-2026-05-31.md`。

## [2026-05-31] ingest | 产物随合约整包流转（协作断裂修复）

新建 `decisions/artifact-package-flow.md`：上游产物以「包」（全部文件 + manifest）随 contract 流到下游 `inbox/upstream/<producer>/`，agent 只读自己 inbox，系统按 graph 搬运。
- 根因：planner 扩展产物没流给 worker，各 agent 从零重做 = 协作断裂。
- 多文件：单 content.md 不可行，整包搬 outbox 全部文件。
- 否决：wake-embed（跨路径推送，已撤）、单 content.md、manifest 指定路由（抢 graph 真值）、靠 SOUL 自觉。
- manifest 由 runtime_result 演进、只引 contractId（不造第二真值）；outbox 收集早已支持多文件，只补"流到下游"缺口。

同步：
- `concepts/conveyor-belt.md` 加"产物也走传送带"条 + 交叉链接（产物维度的传送带延伸）。
- index.md 决策页表加入口（05-31）。
- 落地 v113 工作线（artifact-store / preserve_artifact / routeInbox / role-spec dispatch 指令）；决策稿 `docs/decision-dual-file-package-flow-2026-05-31.md`。

## [2026-05-31] ingest | 沉淀外部系统对比作设计参照

新建 `concepts/comparison-autogen-langgraph.md`（OpenClaw vs AutoGen Studio vs LangGraph）：
- 三种"谁来编排流程"哲学：LangGraph 图=控制流+共享 State+checkpoint；AutoGen v0.4 异步 actor+LLM 选 speaker+Studio；OpenClaw 传送带（图边=授权非时序）+contract 唯一真值+代码管流程/LLM 管内容
- 关键轴对比表（控制流/状态真值/agent 定义/代码 vs LLM/循环/持久化调试/部署）
- OpenClaw 独特点（授权与时序解耦、代码/LLM 严格分离）+ 取舍（不要共享 typed state/checkpoint、故意不让 LLM 编排时序）
- 可学差距（time-travel/checkpoint、可视化 IDE）+ 落到工作流页（拓扑+SSE≈图执行态，独有：提示词拼装+终端投递）

交叉链接：传送带原则、cli-system、operator、harness、external-reference-absorption 决策页。页尾列外部 URL 来源（AutoGen Studio / AutoGen v0.4 / Victor Dibia / LangGraph Graph API）。

同步：
- index.md 在「隐喻与框架」节加该参照页入口
- 性质=外部系统认知参照，非本系统真值，故不进 status.md

## [2026-05-30] ingest | v112 (P-WF1~4) dashboard 工作流页 + 可观测后端

新增 dashboard「工作流」页特性编译进 wiki。

更新概念页（增量）：
- concepts/dashboard.md — 新增「工作流页」节：`/watchdog/workflow-view` 缩略图/拓扑/session 三区联动；workflow 定义=agent-graph 连通分量（computeAgentWorkflows）非注册 loop；后端经 inspect 家族可观测；演化/状态加 v112 行
- concepts/cli-system.md — inspect 节补 v112 HTTP 投影 `GET /watchdog/inspect`（403 挡 apply）+ `POST /watchdog/reveal-file`（白名单防逃逸）；surface 19→22（agent_workflows / agent_sessions / session_transcript）；演化/状态加 v112 行
- concepts/session-management.md — 新增「会话 transcript 真相」节：`.jsonl` 已内嵌文件全文（非指针）；session-clean 会清 sessions/；agent_end 前 snapshotInboxToTrace 补 inbox 副本缺口；演化加 v112 行

同步：
- index.md 刷新注记到 v112 + cli-system（22 surface）/ dashboard（工作流页）行

代码位置已 lint 校验：agent-workflow-grouping.js / agent-session-store.js / agent-session-transcript.js / agent-reveal-file.js（均 lib/agent/）/ workflow-trace-snapshot.js（实际在 **lib/lifecycle/**，非 lib/agent/）/ routes/api.js / dashboard-workflow.js。
实测：inspect.* = 22；`/watchdog/inspect` 校验 family==="inspect" 否则 403；reveal-file 白名单 = {workspaces,control-plane,contracts,agents} + startsWith(root+sep) + execFile open -R。
源: 备忘录112/113/114。

## [2026-05-30] ingest | v111-stable (P-H) CLI-system 全族收口

接 v110，本轮把 CLI-system 五族真值边界全部裁定并收口。

更新概念页（增量，仅 cli-system）：
- concepts/cli-system.md — 旧「inspect 一条路径」段升级为「全族收口」段：五族真值边界表 + observe（读经 inspect、推送=transport、无需独立 dispatch）+ apply 边界裁定（admin-operations=真值边界，executor=operator 专用守卫通道，~42 admin POST 不收口）+ verify 0 旁路 + owner-vs-observer 全族统一判据 + 死路由 `/watchdog/graph/edge` 删除 + inspect 16→19（tracking_states / recent_task_history / capability_registry）；演化/状态加 v111 行

同步：
- index.md 刷新注记到 v111 + cli-system 行状态（全族收口，19 surface）

代码位置已 lint 校验存在：cli-surface-inspector.js / routes/dashboard.js / routes/operator-catalog.js / routes/api.js / lib/admin/admin-surface-operations.js（executeAdminSurfaceOperation）/ lib/capability/capability-registry.js。
实测：inspect.* = 19；新 3 surface 在编目内；bare /graph/edge 已无，仅余 /add + /delete。
源: 备忘录112/113/114。

## [2026-05-30] ingest | v110-stable (P-G) 系统级旁路收口

接 v109 operator 零旁路，本轮把观测读取全系统收口到 inspect surface。

更新概念页（增量，未碰其他页）：
- concepts/cli-system.md — 新增「inspect surface = 观测读取唯一碰 store 的入口」段（operator + 10 HTTP read-route 都经它）+ 观测视图/owner 旁路判据表 + 新增 2 surface（14→16：active_loop_session / runtime_state）+ capability-registry 刻意不收口（truth-assembler + TDZ 循环依赖）+ guard 把守上移到 cli-runtime-inspector
- concepts/operator.md — 零旁路段补一句：HTTP 投影同样经 inspect surface，operator 与 HTTP 是同一条观测读路径的两个消费者

同步：
- index.md 刷新注记到 v110 + cli-system 行状态（收口完成，16 surface）

代码位置已 lint 校验存在：cli-surface-inspector.js / cli-runtime-inspector.js / routes/api.js（14 处 inspectCliSystemSurface）/ routes/operator-catalog.js / capability-registry.js。
catalog 实测 inspect.* = 16 个。
源: 备忘录112/113/114。

## [2026-05-30] ingest | v109-stable 接口冻结 + operator 零旁路收口

本轮 restructure/openclaw-multi-agent-system（v108→v109-stable）结论编译进 wiki。

更新概念页（增量，未碰其他页）：
- concepts/cli-system.md — 五类 surface family 表 + 读写双路径对称（inspector/executor）+ `validateCliSurface` 冻结 + 14 个 inspect surface 清单
- concepts/operator.md — 新增「零旁路红线」：13 处直读 store 全改经 `inspectCliSystemSurface`，余下 import 合法（纯算法/静态配置/常量）
- concepts/harness.md — `validateHarnessModuleDefinition` 模块接口冻结 + 对象链 + e2e 样例引用
- concepts/automation-of-automation.md — 对象链四关节接上 + ProfileLifecycle 概念预算未满足本轮不建

同步：
- index.md 刷新 cli-system / operator / harness 三行状态 + 刷新注记
- 包装为正式插件 openclaw-multi-agent-system（运行时 id 仍 watchdog，零外部依赖）未单建概念页：属打包事实，归 README/package.json，wiki 不复制

代码位置已 lint 校验存在：cli-surface-inspector.js / cli-surface-executor.js / cli-surface-schema.js / cli-surface-catalog.js / cli-surface-registry.js / harness-module-schema.js / operator-snapshot.js / tests/cli-chain-e2e.test.js。
串行门 1186→1265 pass / 0 fail；网关重启确认 operator-snapshot + 14/14 surface 线上跑通。
源: 备忘录112/113/114。

## [2026-05-30] repair-audit | 全面修复完成，状态更新

8 波修复（W0-W8）收尾。核心正确性/安全/真值/架构已修；god-object 部分拆分 64→约 28。
串行门 1186 pass / 0 fail。分支 repair/audit-2026-05-29，尚未 push/tag。
- status.md 更新当前位置与债务清单
- 备忘录119 记录执行全程（事实 + 经验 + 保留债）
- index.md 无需新增条目（无新概念页）

## [2026-05-20] system-blocks | formal project block board

新增 `concepts/system-blocks.md`，把 memo 87 的协作切片从 worktree 执行约定升级为正式项目板块。

同步结果：
- index.md 增加 System Blocks 入口
- 板块真值由 `extensions/watchdog/lib/dev/system-block-registry.js` 机器可读维护
- `scripts/openclaw-block-check.js` 支持按 primary block 检查当前改动
- `docs/system-blocks/` 作为 agent 接任务时的板块 handoff 入口

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
首批编译：三层协议、硬软路径、传送带原则、dispatch 与 graph policy 分层决策。
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
