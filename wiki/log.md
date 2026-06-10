# Wiki Operation Log

## [2026-06-10] ingest | test-runner 大修决策页

- 新决策页 `decisions/test-runner-overhaul-2026-06.md` — CheckResult 四态/E-码单源注册表/failures-first 报告/19→8 预设/verify 门 single→dispatch;含否决方案(保留 single id/CLI 本地降级/精确计数 pin/独立 mutation 预设)与落地当天三个实战检出(E-GRAPH-003 真图缺边/E-SCHEDULE-001 真 cron edit --json bug 当场修/E-CONTRACT-003 provider 故障归因)。
- index.md 决策表 +1。(概念页 test-system.md/index/log 的同步由实施 workflow 的 docs agent 先行完成。)

## [2026-06-10] ingest | 提示词六层装配 + role/SOUL/wake 解耦 + 英文化

编译本次重构（role/SOUL/wake 解耦 + 提示词英文化，原子核未提交）的 WHY 进 wiki。

产出:
- 新概念页 `concepts/prompt-assembly.md` — 六层装配模型（①框架/②工具/③skill头/④role/⑤SOUL/⑥wake）+ 两条装配路径（用户直连 / 系统派工，sessionKey 判定）+ 缓存裁定（SOUL 末尾、contractId 不内联）。引代码 `lib/role-spec-registry.js`/`workspace-guidance-writer.js`/`contract-session-prompt-override.js`。
- 更新 `concepts/soul-identity.md` — 修正与代码冲突的旧描述（SOUL 不再含 role 品质）：⑤SOUL=纯用户、④role→托管 IDENTITY.md；加演化条目 + 决策内链。
- 新决策页 `decisions/role-soul-wake-decoupling.md` — 含否决方案：role 烘焙进 SOUL（迁移闸 `scripts/migrate-soul-identity.js` 拆开 + 删 `lib/soul-template-builder.js`）/ 框架 append system 区块不可行（只能整体替换→watchdog 字符串拼接）/ contractId 内联破缓存。
- 同步 index.md（「Agent 与角色」+1 概念，决策表 +1 行）。

诚实记录:live-complex 全派发实测仍被空 agent-graph(0 edges) 挡着（运行态阻塞，非提示词代码问题），单测全绿、网关单跑 FULLY INITIALIZED。

## [2026-06-09] ingest | 知识库/RAG 子系统 + 122 三档 land 决策(v145-162)

编译备忘录122(高星 AgentRAG 调研三档落地)+ 123(三计划真值层协调)+ 会话内 RAG 实现(v145-v162)的 WHY 进 wiki。

产出:
- 新概念页 `concepts/knowledge-rag.md` — 知识库/RAG 检索子系统(hybrid qwen3+BM25-lite+RRF、多库、时序元数据+分歧派生、recall/faithfulness 评测、per-agent 消费),含 v145-162 演化脉络。引代码 `lib/operator/wiki-rag-*.js`/`knowledge-*.js`,引备忘录122/123。
- 新决策页 `decisions/rag-land-2026-06.md` — 四决策含替代方案:① embed→qwen3-embedding:0.6b(A/B +37.5pp recall@1,否决 BGE-M3 降级/ColBERT 爆炸) ② rerank=LLM listwise 默认关(ollama 0.21 无 rerank API + qwen3-reranker tag 不存在=专用 reranker 不可用;质量 +16.7pp 但 60s/query 延迟劝退默认开) ③ faithfulness 生成侧度量 judge 注入(recall 证检索对、faithfulness 证用对=验证前提) ④ RAG 不建 meta-agent + knowledge≠真值(传送带反对增殖 agent;KB=内容/数据不进快照,knowledge_remove 假回滚)。
- 同步 index.md(新增「知识库与检索 (RAG)」节 + 决策页行)。

纪律印证:122「改 embed 先跑 fixture recall delta、有正向才切」全程遵守;诚实记录环境阻塞(reranker 不可用)与延迟权衡(rerank 默认关),不盲从自动「建议默认开」。

## [2026-06-02] ingest | v116→v132 stale 修复：operator 手已通 + designer-only + 对象落地

对抗式审计（本会话 live 比对代码）发现 v115 后的 wiki 滞后约 13 个 tag，多处 load-bearing 谎言。逐项据代码（code wins）修正：

1. **operator designer-only 重定义** — operator = 结构设计者，不替用户跑具体任务：build plan 终态 = 结构 active + `inspect.structure_preview`，**绝不**末尾 emit `runtime.loop.start` 携带用户任务（跑由用户/ingress 下游触发）。代码核实 `lib/operator/operator-brain.js`:~210（"You DESIGN the control plane; you do NOT run..."）+ `operator-knowledge.js` `new-task-workflow` 片段（`skills/operator-new-task/SKILL.md`）。同步：concepts/operator.md（新增「设计者 vs 运行者边界」节 + 演化行）。
2. **operator 手已通（SUPERSEDES v115「operatorExecutable=0 / 手仍瘫」）** — 38 个 `operatorExecutable` surface 上线（`lib/admin/catalog/apply-rest.js` 28 + `agents-apply.js` 10，实测 grep -c=28/10）；`operator-executor.js` `executeOperatorExecutablePlan` 真跑 plan：per-step `executeCliSystemSurface`（`actor:'operator'`，executor 行 22 硬要求 `operatorExecutable !== true` 则拒）+ explicit-confirm 闸 + `captureStructureSnapshot`/`restoreStructureSnapshot` 原子回滚 + `forceVerify=true` after-apply + soft-fail（`{ok:false}`）也回滚。死链 (b) 闭合。同步：concepts/operator.md（当前状态/演化）、cli-system.md（line ~67 谎言重写）、self-governance-loop.md 经交叉链接对齐。
3. **planner 可靠性批次** — single-retry（`callPlannerWithSingleRetry` @ operator-brain.js:244，abort/GLM-socket 首次即重抛不掩盖）/ resilient step-drop normalize（`normalizeOperatorBrainPlanResult` @ operator-plan.js:285，丢坏单步保全盘）/ glm-socket dispatcher + 截断 JSON 修复（`repairTruncatedJsonText` @ llm-planner.js:70）/ GLM-5.1 fallback（`resolveOperatorBrainModel` @ `lib/brain-model-resolver.js`）。同步：concepts/operator.md（新增「可靠性」节）。
4. **agent-map 紧凑片段** — `operator-knowledge.js` `buildAgentMapFragment`（:157）是 operator 读结构的视图。同步：concepts/operator.md「可靠性」节。
5. **inspect surface 22→26（静态 catalog）** — 实测 `lib/cli-system/cli-surface-catalog.js` inspect.* = 26；v112 后新增 `inspect.profile_lifecycle` / `inspect.agent_groups` / `inspect.structure_preview`。apply/verify 族**已编目**（`apply-rest.js`/`agents-apply.js`，family 经 `cli-surface-registry.js` `normalizeAdminSurface` 从 `stage` 字段派生，非缺 catalog）。同步：concepts/cli-system.md（inspect 清单/演化/当前状态）。

其他同步页（据代码核实）：
- concepts/agent-group.md — 「未开始/概念阶段/god-role 前置」全翻为「设计冻结 + v119 宏展开已落地」；cite `lib/agent/agent-group-spec.js`（`normalizeGroupSpec` members≥2 + `internalEdges` 两端必须成员 line 33-34 无免授权暗门 + `OUTPUT_MODES` passthrough/aggregate/race + `expandAgentGroup` + `buildOutputPolicies`）、`group-session-store.js` / `group-session-normalize.js`（**在 lib/agent/ 非 lib/loop/**）、`agent-workflow-grouping.js`；observable via `inspect.agent_groups`；移除 god-role 前置；tasks #38/#46 done。
- concepts/evaluation-result-chain.md — 「ProfileLifecycle 尚未实现」改为「均已实现（v115）」，cite `lib/automation/profile-lifecycle.js`（TRUST_LADDER experimental/provisional/stable，连 2 fail→retired）+ `resolve-governance.js` + 闭环 `tests/automation-profile-lifecycle-closed-loop-p4.test.js`；与 self-governance-loop.md 对齐。
- concepts/loop.md — 新增「环自带 limit（v120）」（`loop-budget.js` DEFAULT 3/30，`resolveLoopStartBudget` 优先级 DEFAULT<LoopSpec<runtime<config，超限复用既有 budget governance force-conclude）+「reviewer 控制环（v121）」（artifact-branch idle 误判修复=已绑定 contract 即有活干，`lib/heartbeat-gate.js` `hasActionableHeartbeatWork`:62-72）；演化加 v120/v121。
- concepts/harness.md — 正式入口强调 `harness-module-catalog.js`（10 模块/4 kind：guard.budget/tool_access/scope · collector.artifact/trace · gate.artifact/schema/test · normalizer.eval_input/failure，`freezeCatalog` 经 `validateHarnessModuleDefinition`）；当前状态→接口已冻结(v109)+v115 灵魂落地完成；新增 operator 装 harness 层（`lib/operator/operator-harness-recommend.js` 只挑 moduleRef 粒度不当第二 planner + `skills/harness-build/SKILL.md` + `automations.create`）；演化加 v109/v115。

同步元页：
- index.md — 刷新注记到 ~v132-stable（2026-06-02）；cli-system 行 22→26 inspect surfaces；operator 行→designer-only + 手已通；AgentGroup 行「待实现」→「已落地」；新增 ORPHAN 页 `concepts/runtime-dispatch-queue.md` 入口（此前无任何页链接它）。
- status.md — header→2026-06-02；替换「operatorExecutable=0/手仍瘫」为「手已通」；AgentGroup/ProfileLifecycle/HarnessModule 移出「待实现」表入已落地；新增 operator 旗舰硬化 designer-only + planner 可靠性活跃行；引用任务 #57/#58 in-progress。

性质=据 v132-stable live 代码快照修正 wiki 滞后（code wins）。Verified live counts：inspect family 44 / apply 48 / verify 3 / operatorExecutable 38 / static inspect catalog 26。

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

---

## 2026-06-09 Ingest — 本会话工作（v161 兜底链 + 协调设计）

来源：备忘录123（真值层协调）、备忘录124（使用场景大楼模型）、备忘录125（oh-my-pi 借鉴 + provider 兜底链）。

产出：
- 新概念页 `concepts/provider-fallback-chain.md`（v161：有序就绪链 + provider/内容错误边界）
- 新决策页 `decisions/oh-my-pi-borrow-2026-06.md`（oh-my-pi 分层借鉴 T1/T2/SKIP + Harness 镜子教训）
- 新决策页 `decisions/truth-seam-coordination.md`（D-α 协调缝 + D-δ meta 旁路；D-β/D-γ 已并入 rag-land）
- 更新 `concepts/building-metaphor.md`（两种工作模式 A/B + 融合 + 会话键，源备忘录124）
- 更新 `decisions/external-reference-absorption.md`（加 oh-my-pi 第三参考）
- 更新 `index.md`（+1 概念 +2 决策）

注：log 在 2026-04-09 与本次之间未被同步（rag-land 等只更 index 未更 log）= 既有 lint gap，非本次引入。

## 2026-06-10 Ingest — 测试系统 CheckResult 重写（19 预设 → 8）

- 重写 `concepts/test-system.md`：8 预设（health 默认零 LLM 体检 / dispatch / pipeline / loop / system-action / operator / knowledge / full）、CheckResult 四态（pass/fail/skip/blocked）、E-* 错误码单一注册表 `lib/formal-runtime/error-codes.js`、failures-first `.txt` + `.json` 镜像报告、verify 门预设 single→dispatch
- 更新 `index.md` 测试系统摘要行
- 源：本次重写无备忘录（代码先行），代码真值见 `extensions/watchdog/lib/formal-test-presets.js`
