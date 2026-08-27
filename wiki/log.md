# Wiki Operation Log

## [2026-08-28] lint | 活文档死代码路径清扫(wiki 包)

- 门 = `node scripts/check-doc-paths.js`(活文档死引用即红)。本批清 wiki 名下 11 文件全部失效路径引用:
  搬迁的改现路径(role-spec-registry→lib/prompt、brain-model-resolver→lib/llm、
  admin-surface-operations→lib/admin/operations、capability-registry→lib/management、
  formal-test-presets→lib/formal-runtime、workflow-trace-snapshot→run-tree-snapshot v199、
  contract-outcome→terminal-outcome v189、context-compression→upstream-guide v200、
  artifact-store→upstream-package-inflow v218、protocol-registry→lib/protocol);
  退役的去路径形留注记(harness 族 v226、loop 族 v215、dashboard-* 前端族 v233、soul-template-builder v164)。
- 页面级:`concepts/dashboard.md` 加 v233 整体退役页首注记 + 当前状态改「已废弃」(比照 harness/evaluator 惯例);
  其余页仅正文引用改写,历史语义保真,不删原貌。

## [2026-08-23] ingest | harness 判定账全退役 (v226)

- 承备忘录149 裁决（harness 全套删掉，只保留「标准化」设计思想）与备忘录150（评审链先删，
  harness 退役批化简为纯解耦）。`lib/harness/` 整目录（23 文件）删除；Path C 记录器停写；
  automation 与 HarnessRun/EvaluationResult 解耦（评价源恒 null，decision 回落既有
  terminalStatus/预算/指纹路径）；operator 观测面（harnessRuns/reviewerResults/规则④提案）与
  dashboard harness 站（页/路由/导航/i18n）同批下线；CLI inspect surface `inspect.harness_runs` /
  `inspect.harness_catalog` 摘除，health 下界同步下调到实测值（114/93/52）。
- 记录面从三本账（threads/trace/harness）变两本账：run-join 判定腿摘除；4596+ 条历史判定
  归档至 `archives/harness-runs-2026-08-23.tar.gz`。
- D-F 两道声明式沙箱守卫（guard.tool_access/scope）保留：`lib/security/declared-sandbox-guard.js`
  继续读 `contract.automationContext.harness.moduleConfig`（该透传形状保留）。
- 受影响页面：`concepts/harness.md`、`docs/system-blocks/harness-assurance.md`、
  `docs/harness-evidence-and-failure-class-2026-05-31.md` 等已加退役状态头（页面不删，
  「标准化」思想保留）；`index.md` / `status.md` 状态改口。

## [2026-08-19] ingest | 记录面收店 + 上游解析脱图 (v218)

- **两店退役**:`control-plane/artifacts/`(产物副本店,34M)与 `control-plane/conversations/`(旧跨 run 索引)整店删除。
  前者的数据源职责回到树 outbox 一处(已封包→symlink / 未封包→拷当前内容);后者的职责 thread 早已接管,
  它的 `priorContext` 读出来零下游消费者。`buildConversationId` 保留并内联进 ingress —— 它是 threadId 谱系种子。
- **翻出一个真 bug**:上游 producer 原本按**图入边**反查(`getEdgesTo`),把「投递授权」当成「产物来源」。
  2026-08-18 图夹具拆除后 reviewer 没有入边 → 评审包投递静默断掉三天,店照写、reviewer inbox 永远空。
  `concepts/artifact-handoff.md` 曾把这条后果当作**已知限制**记着 —— 它不是限制,是没人认领的 bug。
- **改法**:上游身份随合约走(`contract.upstreamProducers`),由派工收口 `applyUpstreamProducerPointer` 一次登记
  (传送带派工与动态派工在这里汇合)。图边从此只管投递授权。
- 受影响页面:`concepts/artifact-handoff.md`(交互关系与实现表改写)、`decisions/artifact-package-flow.md`
  (加 v218 升级标注,正文保留原貌)、`docs/system-map.md` L5 板块与附录归位清单。
- 模块改名:原 lifecycle 侧 artifact-store → `lib/delivery/upstream-package-inflow.js`。

## [2026-08-18] ingest | 回路(Loop)机制整体退役 — 文档/技能/定址真值收官

- 代码侧十批(B1-B10)删除回路全栈:`lib/loop/` 七文件、`suite-loop.js`、admin/CLI/HTTP 回路表面、
  agent_end 回路推进分支、automation 回路腿、控制面第 4 份结构真值、`loop` 测试预设。
  错误码 114→105;预设 14→13、`full` 13→12 suite;structure snapshot 4 真值→3 真值。
- **保留(用户明确要求)**:识环能力 —— `detectCycles` / `hasDirectedEdge` / `loadGraph`、
  `GET /watchdog/graph` 的 `cycles`、dashboard `normalizeGraphCycles`/`highlightCycles`/`isLoopBack`、
  提示词「当前显式回路」段,一个都没删。
- **两族同名不同物,一并在文档里钉死**:① 执行硬停(`lib/runtime/execution-hard-stop-registry.js`、
  `[LOOP DETECTED]`、`loop_warning`/`loop_detected`);② 自治回路/工具回路
  (`autonomy-loop-semantics`、`self-governance-loop.md`、`knowledge-toolface.js`)。两族都不是图回路。
- 改动:`concepts/loop.md` 整页改写为**已退役历史页**(不删文件);
  `decisions/cycle-vs-registered-loop.md` 标 SUPERSEDED(上半句升为唯一真值、下半句作废);
  `index.md`(Loop/AgentGroup/Operator/三条决策行状态);`concepts/{agent-group,conveyor-belt,three-layer-protocol,
  cli-system,system-layering,agent-binding,operator,harness,wake-event,dashboard,graph-edge,agent-workspace,
  comparison-autogen-langgraph,system-blocks}.md`;`status.md`;
  `decisions/{pipeline-dissolution,unified-control-plane,graph-as-runtime-truth,dynamic-collaboration-leaves-graph,
  oh-my-pi-borrow-2026-06,external-reference-absorption,test-runner-overhaul-2026-06}.md` 逐条加退役注记。
- 同批(wiki 外):`docs/system-map.md` 定址真值(L2 板块 / §5 归位清单 / 计数)、
  `CLAUDE.md` / `SYSTEM_MAP.md` / `README.md` / `CODEX.md`、7 份 skills、
  System Block `loop-stage` → **`stage`**(含 `docs/system-blocks/stage.md` 改名)。

## [2026-08-12] sync | 测试预设改名同步进活文档

- 代码侧预设改名后同步 wiki 名词:dispatch→single、system-action→collab、harness→automation-eval、agent-group→group,providers 并入 model;新增 concurrent/model/unit;共 14 预设,`full` = 13 suite;verify 门预设现为 `single`(`lib/admin/admin-surface-registry.js`)。真值在 `lib/formal-runtime/formal-test-presets.js`。
- 改动:`concepts/test-system.md`(计数/`--case` 范围/verify 门/演化+1 条)、`concepts/graph-edge.md`(collab 预设)、`concepts/dashboard.md`(预设按 live 表渲染)、index.md 决策表行注记。历史决策页 `decisions/test-runner-overhaul-2026-06.md` 与既往 log 条目保持原貌(历史记录)。

## [2026-06-10] ingest | test-runner 大修决策页

- 新决策页 `decisions/test-runner-overhaul-2026-06.md` — CheckResult 四态/E-码单源注册表/failures-first 报告/19→8 预设/verify 门 single→dispatch;含否决方案(保留 single id/CLI 本地降级/精确计数 pin/独立 mutation 预设)与落地当天三个实战检出(E-GRAPH-003 真图缺边/E-SCHEDULE-001 真 cron edit --json bug 当场修/E-CONTRACT-003 provider 故障归因)。
- index.md 决策表 +1。(概念页 test-system.md/index/log 的同步由实施 workflow 的 docs agent 先行完成。)

## [2026-06-10] ingest | 提示词六层装配 + role/SOUL/wake 解耦 + 英文化

编译本次重构（role/SOUL/wake 解耦 + 提示词英文化，原子核未提交）的 WHY 进 wiki。

产出:
- 新概念页 `concepts/prompt-assembly.md` — 六层装配模型（①框架/②工具/③skill头/④role/⑤SOUL/⑥wake）+ 两条装配路径（用户直连 / 系统派工，sessionKey 判定）+ 缓存裁定（SOUL 末尾、contractId 不内联）。引代码 `lib/prompt/role-spec-registry.js`(时在 lib 根,后随目录重排迁入 lib/prompt/)/`workspace-guidance-writer.js`/`contract-session-prompt-override.js`。
- 更新 `concepts/soul-identity.md` — 修正与代码冲突的旧描述（SOUL 不再含 role 品质）：⑤SOUL=纯用户、④role→托管 IDENTITY.md；加演化条目 + 决策内链。
- 新决策页 `decisions/role-soul-wake-decoupling.md` — 含否决方案：role 烘焙进 SOUL（迁移闸 `scripts/migrate-soul-identity.js` 拆开 + 删 soul-template-builder,原 lib 根）/ 框架 append system 区块不可行（只能整体替换→watchdog 字符串拼接）/ contractId 内联破缓存。
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
3. **planner 可靠性批次** — single-retry（`callPlannerWithSingleRetry` @ operator-brain.js:244，abort/GLM-socket 首次即重抛不掩盖）/ resilient step-drop normalize（`normalizeOperatorBrainPlanResult` @ operator-plan.js:285，丢坏单步保全盘）/ glm-socket dispatcher + 截断 JSON 修复（`repairTruncatedJsonText` @ llm-planner.js:70）/ GLM-5.1 fallback（`resolveOperatorBrainModel` @ `lib/llm/brain-model-resolver.js`,时在 lib 根,后随目录重排迁入 lib/llm/）。同步：concepts/operator.md（新增「可靠性」节）。
4. **agent-map 紧凑片段** — `operator-knowledge.js` `buildAgentMapFragment`（:157）是 operator 读结构的视图。同步：concepts/operator.md「可靠性」节。
5. **inspect surface 22→26（静态 catalog）** — 实测 `lib/cli-system/cli-surface-catalog.js` inspect.* = 26；v112 后新增 `inspect.profile_lifecycle` / `inspect.agent_groups` / `inspect.structure_preview`。apply/verify 族**已编目**（`apply-rest.js`/`agents-apply.js`，family 经 `cli-surface-registry.js` `normalizeAdminSurface` 从 `stage` 字段派生，非缺 catalog）。同步：concepts/cli-system.md（inspect 清单/演化/当前状态）。

其他同步页（据代码核实）：
- concepts/agent-group.md — 「未开始/概念阶段/god-role 前置」全翻为「设计冻结 + v119 宏展开已落地」；cite `lib/agent/agent-group-spec.js`（`normalizeGroupSpec` members≥2 + `internalEdges` 两端必须成员 line 33-34 无免授权暗门 + `OUTPUT_MODES` passthrough/aggregate/race + `expandAgentGroup` + `buildOutputPolicies`）、`group-session-store.js` / `group-session-normalize.js`（**在 lib/agent/ 非 lib/loop/**）、`agent-workflow-grouping.js`；observable via `inspect.agent_groups`；移除 god-role 前置；tasks #38/#46 done。
- concepts/evaluation-result-chain.md — 「ProfileLifecycle 尚未实现」改为「均已实现（v115）」，cite `lib/automation/profile-lifecycle.js`（TRUST_LADDER experimental/provisional/stable，连 2 fail→retired）+ `resolve-governance.js` + 闭环 `tests/automation-profile-lifecycle-closed-loop-p4.test.js`；与 self-governance-loop.md 对齐。
- concepts/loop.md — 新增「环自带 limit（v120）」（`loop-budget.js` DEFAULT 3/30，`resolveLoopStartBudget` 优先级 DEFAULT<LoopSpec<runtime<config，超限复用既有 budget governance force-conclude）+「reviewer 控制环（v121）」（artifact-branch idle 误判修复=已绑定 contract 即有活干，`lib/heartbeat-gate.js` `hasActionableHeartbeatWork`:62-72）；演化加 v120/v121。
- concepts/harness.md — 正式入口强调 `harness-module-catalog.js`（10 模块/4 kind：guard.budget/tool_access/scope · collector.artifact/trace · gate.artifact/schema/test · normalizer.eval_input/failure，`freezeCatalog` 经 `validateHarnessModuleDefinition`）；当前状态→接口已冻结(v109)+v115 灵魂落地完成；新增 operator 装 harness 层（operator 侧 operator-harness-recommend 模块——后随 harness 全退役 v226 删除——只挑 moduleRef 粒度不当第二 planner + `skills/harness-build/SKILL.md` + `automations.create`）；演化加 v109/v115。

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

代码位置已 lint 校验：agent-workflow-grouping.js / agent-session-store.js / agent-session-transcript.js / agent-reveal-file.js（均 lib/agent/）/ workflow-trace-snapshot.js（实际在 **lib/lifecycle/**，非 lib/agent/）/ routes/api.js / dashboard-workflow 前端模块（后随 v233 前端整删）。
实测：inspect.* = 22；`/watchdog/inspect` 校验 family==="inspect" 否则 403；reveal-file 白名单 = {workspaces,control-plane,contracts,agents} + startsWith(root+sep) + execFile open -R。
源: 备忘录112/113/114。

## [2026-05-30] ingest | v111-stable (P-H) CLI-system 全族收口

接 v110，本轮把 CLI-system 五族真值边界全部裁定并收口。

更新概念页（增量，仅 cli-system）：
- concepts/cli-system.md — 旧「inspect 一条路径」段升级为「全族收口」段：五族真值边界表 + observe（读经 inspect、推送=transport、无需独立 dispatch）+ apply 边界裁定（admin-operations=真值边界，executor=operator 专用守卫通道，~42 admin POST 不收口）+ verify 0 旁路 + owner-vs-observer 全族统一判据 + 死路由 `/watchdog/graph/edge` 删除 + inspect 16→19（tracking_states / recent_task_history / capability_registry）；演化/状态加 v111 行

同步：
- index.md 刷新注记到 v111 + cli-system 行状态（全族收口，19 surface）

代码位置已 lint 校验存在：cli-surface-inspector.js / routes/dashboard.js / routes/operator-catalog.js / routes/api.js / lib/admin/operations/admin-surface-operations.js（executeAdminSurfaceOperation）/ lib/management/capability-registry.js（后两者已随目录重排迁至现址,原在 lib/admin/ 根与 lib/capability/）。
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
- 源：本次重写无备忘录（代码先行），代码真值见 `extensions/watchdog/lib/formal-runtime/formal-test-presets.js`（时在 lib 根,后随目录重排迁入 lib/formal-runtime/）

## 2026-07-27 Ingest — 统一 FC 证据面 P3 批次二

- `status.md` 置顶更新:P2+证据面主干与 P3 全量落地并 live 验收;回流链后半段修通(评审腿 contract 化)
- 关键决策已入 spec(§11)与备忘录128 三点一〇〇:评审 verdict 派生不猜散文(false-approve 险案 live 实证)、DIRECT 信封无正本文件→标记结果走内存镜像、agent_end 单 stage throw 全链死为已知债
- 源:备忘录128 三点九七~一〇〇;代码真值 extensions/watchdog/lib/{system-action,routing/delivery,lifecycle,evidence,contract}

## 2026-08-06 Ingest — 产物交接理念白皮书入库

- 新增 `concepts/artifact-handoff.md`:把产物交接从"若干散落决策"编译成一个概念——七条不变式(agent 只有 inbox/outbox、不知下游、平台搬运、完成看文件系统证据、缺料必须可见、产物不打断主链、留存早于派工)及其自洽链
- 补齐此前从未成文的五个关键设计选择:`contract.output` 对 agent 不可见(事故驱动,拒绝提示词教育)/ 有界注入共享池 + 降级而非丢弃 / 完成 = 文件系统证据非自我宣告 / 产物子系统吞错不抛(代价有意识认下)/ 不造第二条搬运协议
- 边界划清:整包流转决策仍归 `decisions/artifact-package-flow.md`,回送腿仍归 `concepts/delivery.md`,本页只拥有"整套机制赖以成立的不变式"
- 记账:动态 assign 腿零产物交接判定为**实现缺口非设计**(规格从未写过"动态派工不带产物");四类实现债明细见备忘录130
- 源:备忘录129 §二、备忘录130;`docs/artifact-flow-static-audit-2026-07-27.md`、`docs/artifact-flow-recheck-2026-08-05.md`;代码真值 `extensions/watchdog/lib/{lifecycle/artifact-store.js,routing/mailbox,delivery,contract}`

## 2026-08-06 Ingest(增补)— 有界注入预算决策推翻

- `concepts/artifact-handoff.md` 关键设计选择②标注**已被推翻待下线**:根本错误是把「搬运字节」与「上下文字节」当同一个量(产物是文件、agent 按需 Read,GB 数据表必须搬但可能零字节进上下文)
- 负载实测支撑:真实 agent 产物 p99 15.3KB / 峰值 19.4KB / 单合约最大 33.5KB,**达到 2MB 预算的合约 0 个**,预算超实际负载 60 倍;`COMPRESSED_MANIFEST.md`+`_MISSING.md` 817 次注入 0 命中 = 两条分支生产中从未运行
- 最硬的删除理由不是"没触发",而是 `_MISSING.md` **违反第一原则**——把拷贝失败写成自然语言交给 LLM 决策,硬路径失败泄漏进软路径
- 替代:枚举→拷贝→对 manifest 自查(数量+大小)→齐则写指针(指针即回执)/缺则重拷/超限报框架错误并阻止派工。**不变式 5 改由代码保证而非 marker 告知 LLM;不变式 6 需拆细为生产侧 vs 消费侧**
- 记账:尺寸小是结构性的(LLM 逐字写出,一轮上限十几 KB);真正的重新设计触发条件是"产物不再由 LLM 逐字写出"(脚本产数据/web_fetch 落盘/二进制)
- 源:备忘录130 §十(前两版结论已在文内标注作废);代码真值(当时) delivery 侧 context-compression(已按本决策于 v200 拆除,COMPRESSED_MANIFEST 导览化为 `lib/delivery/upstream-guide.js`)与 lifecycle 侧 artifact-store(v218 改名 `lib/delivery/upstream-package-inflow.js`)

## 2026-08-06 Ingest — 概念上提:产物交接 → Agent 工作空间

- 新增 `concepts/agent-workspace.md` 作为**父概念**;`concepts/artifact-handoff.md` 上挂并重新定性:**交接是空间隔离模型的推论,不是独立系统**(隔离 → 必须搬运;若共享目录则退化成导航)。判断交接类改动的新标尺:先问是否动摇空间模型
- **查证旧设计(用户"记得以前设计过")**:确有,但结论相反 —— `核心设计指标` **第三条永久原则**明写"不同 Agent 的文件分目录,**不共享 workspace**",且共享区(contracts/output)"由系统代码管理,Agent 不直接操作"。备忘录104 的 WorkspaceAlias 是旧工作区**残留治理**,非共享空间设计
- **记账两条未决张力**:①搬运成本(GB 级/大量小文件逐字节拷贝)②AgentGroup **名不副实** —— 被定义为"空间原语"但 GroupSpec 只有 `{id,members,entry,internalEdges,outputMode,metadata}`,**零空间维度**
- **关键技术事实**:`control-plane` 与 `workspaces` 同属一个文件系统(`/dev/disk3s5`)→ **硬链接可行**。硬链接在目标路径上就是真实文件(同 inode、零拷贝),读白名单解析得到的是 inbox 路径**不会像软链那样被拒** → **性能问题可在不碰隔离原则的前提下解决**
- **划清界线**:读共享(今天已由拷贝实现,硬链接只换实现)≠ 写共享(新能力,**推翻永久原则三,需显式决策**)。若真要做,AgentGroup 是唯一有原则的作用域(组即共享边界),四个待答问题已记入概念页
- 源:备忘录130、`核心设计指标_2026-03-08-1543`、备忘录85(AgentGroup)、备忘录104

## 2026-08-08 · 平台解耦两刀 + 图边语义纠正(v179-stable 后)

- **重写 `concepts/graph-edge.md`**:旧页一句话定义"没有边就不能交互"、以及"assign_task/wake_agent/request_review 各需 A→B 显式有向边"**全部作废**。图是**固定管线**的定义;动态协作自己指定目标。新增 `metadata.pipeline` 的两种读法说明(选路只认标记边且要求唯一;授权读全部边)
- **新增 `decisions/dynamic-collaboration-leaves-graph.md`**:记录三处证据(spec §0 红线的"固定=图/代码,动态=agent 在授权内"、spec §5 授权单源是角色表、`runtime-authority.js:26` 绕图机制本就存在只是没接到 FC 受理),以及自毁论证(要让 FC 够得着就得连成网,连成网固定管线全歧义;实测加边后 dispatch 0 pass/2 fail/6 blocked)
- **`decisions/graph-as-runtime-truth.md` 标注继任**:未删除,顶部加块说明"协作授权那半已被取代,固定管线那半仍成立"
- **新增 `concepts/platform-agent-decoupling.md`**:判据="没读过文档的新 agent 进来能不能干活";列清今天仍存在的私有协议清单与耦合/解耦形态对照
- **更新 `concepts/artifact-handoff.md`**:取件条带清单(此前只给目录,下游只有 read 拿到目录名等于没入口);不变式③补一段——既然 `status:completed` 本就不被信任,要求该文件在场才肯采集就只是把记账义务外包给 agent
- **反向证据值得记**:FC 被故意堵死后,planner 从**拒绝信息**里现学降级写法一次写对(教程刻意不在提示词里)。平台在需要时递知识 > 要求 agent 事先背下来
- **一条过程教训**:刀1 第一版 12 条测试红,我先判断成"锁旧行为",**错了——10 条是真回归**(删了 `parsed` 变量导致每次采集静默抛错)。A/B(stash 掉改动跑同一条)+ 临时探针定位。12 条红时不要先假设是行为锁
- 源:备忘录135、备忘录136

## 2026-08-09 · 过时知识全库清扫 + 未做事项汇总(v181-stable 后)

- **确立处置规则**:活文档(wiki 概念页/CLAUDE.md/skills/提示词模板/工具 schema)**改正文**;历史记录(全部备忘录、本 log、带日期的审计快照)**只加顶部标注,正文一字不动**。理由:备忘录拥有 RAW,改它们等于毁掉演化脉络那一层
- **判据表驱动,不自由发挥**:把本轮推翻的 10 条列成表交给扫描(图边≠协作授权 / 令牌非必需 / `_manifest` 已删 / 主路是工具 / **JSON 是 L2 不是 L3** / `upstreamPackages` 变对象 / 返工语义作废 / 新 agent 自动拿工具 / 执行层四角色只有三份托管文档 / 目录重排已执行)。"什么算过时"因此有客观标准
- **优先级按危害排**:活指令面 > wiki > docs。LLM 直接照做的东西过时一条就让 agent 走错路;`docs/` 多是快照,标注即可
- **`docs/system-map.md` 是最大单点**:354 个文件路径里 **132 个指向 v171/v172 重排前的旧址**。它被当定址真值用,路径烂掉比单句过时更致命 → 按 basename 唯一解自动修正 190 处;§3/§4 标注为重排前快照;`runtime-contract-output-alias` 整块删除(功能已随 alias 机制废止)
- **发现两处指针必然扑空**:`semantic-skill-registry` 的 `platform-map` 是 `forced_platform` 注给全体的,toolRefs 却指向 `BUILDING-MAP`/`COLLABORATION-GRAPH`/`DELIVERY`/`PLATFORM-GUIDE` —— 而这 4 份正被 `EXECUTION_LAYER_CLEANUP` 从执行层四角色的工作区**主动删除**;`system-action` 的 toolRefs 列了 `start_loop`/`advance_loop` 两个 `exposedAsTool:false` 的东西。已收敛
- **三条驳回(核实为"其实没过时")**:`hasDirectedEdge`/`authorizeDispatchEdge` 在**传送带投递**一侧仍然活着(`dispatch-graph-policy.js:85`,`:196` 注释原话 `"edge = authorization" is untouched`),正确处置是**限定作用域**而非删除;`separate-dispatch-and-graph-router.md` 字面正确;`platform-tools` 提 `runtime_result.json` 不算过时——推翻的是"不写就不采集",不是文件本身
- **一条过程教训**:改 skills 与根托管文档时撞上 `prompt-composition-minimal.test.js` 的**正向文案守卫**(`不要`/`禁止`/`Do not`/`Never` 等词直接红),以及"边跑 npm test 边改 wiki 会让 RAG 增量复用断言变红"——后者是自己造的,不是回归
- 源:备忘录137

## 2026-08-09（二）· 死码清理批 + 过时 wiki 二轮

- **判据不是「零 import」，是「它服务的那个机制已被拆掉」**。按机制退役时间点反查尸体：v179 图边闸 → `EVENT_TYPE.GRAPH_COLLABORATION_BLOCKED`；v181 提交令牌 → 采集侧残留分支；v136 tracker 超时改走 force-fail → late-completion 租约 arm 侧整条；v171/v172 重排 → 转发空壳与幽灵路径
- **删掉的**（全部经"独立复搜 + 试图证伪"两轮）：8 个 `cli-system` 孤岛工作区文档（那个 agent 早已不存在，且**从未被 git 跟踪**，是纯运行时残渣）· `EVENT_TYPE` 两个死事件 · `SYSTEM_ACTION_STATUS` 三个死状态（旧的"agent 写 system_action.json 平台读文件"协议遗物）· `state-constants` 10 个消费方已删的常量 · late-completion 租约 arm 侧 5 函数 + `lease-manager` 4 个 · `infra.js` 4 个旧黑盒测试助手 · `operator-knowledge-library.js` 整文件（v133 检索源改 wiki 时就该退役）· 硬编码 agent-id 回落表三张（正是总纲"禁止在回路里硬编码 agent 名"要清的） · `getRoleSpec`/`getSystemActionEnabledRoles`/`buildReviewerTransition` 等 7 个零消费者函数 · `preserveInbox` 恒 false 链
- **一个活 bug 顺手修了**：`package.json` 的 `files` 白名单里 `dashboard-*.js`/`*.css` 是 v171 重排前的死 glob，而重排后的 `dashboard/` 目录**不在白名单** → 打出来的包不含任何前端资源，`routes/dashboard.js` 全线 404。补 `dashboard/` 后 53 个前端文件才真正进包
- **另一个待宿主确认**：`openclaw.plugin.json` 的 hooks 数组缺 `before_prompt_build`，而 `hooks/before-prompt-build.js` 确实注册了它（挂着 contract-session 提示词覆写）。若宿主拿该数组做投递门控则是静默失效。已补上（补了无论如何不亏）
- **驳回没删的**（存疑一律判活）：`buildHopExpectations()` / `submit_output` 族 / `create_task` 空 roles / `start_loop`+`advance_loop` —— 这些是**未做功能的占位，不是死码**；`resumeRuntimeFollowUpLease`（`hooks/before-agent-start.js:143` 真在调）；`suite-link-cases` 的字符串形态兼容分支（实测 1058 份历史 trace 是字符串形态，删了 E-CONTRACT-006 全体误判）；`completionCriteria`（测试用例名写着 "still honors"）；`proposal-tier.js`（服务端危险分级真值，删了前端一绕就无闸）
- **我上一轮写错的一条已纠正**：`COLLABORATION-FALLBACK.md` 同样被 `isExecutionLayer` 挡住，执行层四角色实际只拿 **IDENTITY + HEARTBEAT**。连带修掉 `semantic-skill-registry` 里指向该文件的死指针——那是注给全体角色的技能，指过去对四个角色必然扑空。**降级写法真正可靠的递送面是结构化拒绝回执本身**
- **wiki 二轮**：0 页删除（wiki 是 WHY 层，过时的是页面里的若干行事实而非页面存在的理由）；`system-layering.md` 加两套 `L{n}` 编号的消歧横幅（职责模型 7 层 vs 定址坐标系 11 层，此前无人说明）；16 处代码路径按重排后真址修正；evaluator/planner/cli-system/contract/test-system/pipeline-dissolution 的过时计数与状态按实测更新；4 页加过时标注
- 源: 备忘录137

## 2026-08-09（三）· 平台服务 FC 族裁决

- **用户裁定三点**：① `submit_plan` 先不做 ② stages 上限机制可做（硬拒不截断，数值待定）③ **`report_progress` 与 `submit_plan` 是同一功能的两半**——plan 报 N 个 stage → agent 完成第 n 个报 `report_progress(n)` → **前端实时给 stage 打勾**，因此一起缓建
- **一条被推翻的建议**：我原本判 `report_progress` 是"没有已知承重职责的想法，不该占位"。**错了**——它有明确机制，只是我没问清它与 plan 的从属关系。**教训:判一个未建符号该不该占位,先问它属于哪个功能,别看它自己有没有需求**
- **连带作废一个判断**：先前把 `submit_plan` spec §9 称为"依赖链上成本最低的解锁点"随之失效。plan 一缓建它就不再是任何东西的前置；新的解锁点是 **`submit_output`,而它现在没有前置**
- **新建决策页** `decisions/platform-service-fc-family.md`：submit_output 先行（扛着 `failed/awaiting_input/hold` 这三件平台不可知的事）；plan+progress 成对缓建；服务表词表一次成型、缓建行 `exposedAsTool:false`（与 `create_task` 同款，避免动两次表——该表要被 before_tool_call 的并集对称消费）
- **两条连带影响记账**：① 刀3 原压在 `buildHopExpectations` 上，随 plan 缓建而更远 → 可退成**两档式**（唯一文件直接用 / 多文件不猜），今天即可做且严格于现状；② `buildHopExpectations()` 恒 `return null` 确认为**已裁定的边界而非待接线**，须在代码里写明，否则每轮死码扫描都会误报（本轮已误报一次）
- 源: 备忘录137、`docs/superpowers/specs/2026-08-06-submit-plan-design.md` §9

## 2026-08-10 · 判决面拆除落地(demolition, commit 699d31d)

- **~900 行判定机器删除,判决面收敛为一个 120 行文件** `lib/judgment/expectation-check.js`:机械核对甲方期望(requiredFiles 逐条 stat),零 LLM;零期望返回空——**不冒充 fulfilled**(旧考官 241 条里 185 条死在这一步)
- **删除**:`contract-outcome.js`(287 行五路优先级+判决语汇派生)/`stage-witness-engine.js`(323 行,从产物反推阶段完成)/交接门全家(自 cut1 起恒弃权的死门)/三个存在性谓词(`hasProtocolSemanticPayload` 族——正是让门死掉的那类"判字段存在"谓词)/`resolveAuthoritativeHardStopOutcome` 与两份平行 summary 拷贝
- **收口改为纯事实三源**:agent 声明(工具>文件,平台不代填——采集侧默认合成的 completed 不当声明采信)→ 中断事实(halted+无声明→FAILED,产物可能是半成品;halted+声明 completed→采信)→ 盘上交付物(非空+非控制载荷=平台对「有产物」的机械定义)
- **阶段推进改自报**:报 completed 即推进,指名别的阶段不推进(防冒领);坏修订照拒。witness 反推整套删除
- **测试面跟随**:witness 锁删除或改锁自报语义;"硬停但有产物→照样转发"锁**反转**(旧行为骑在死谓词上);新建 `terminal-close-facts.test.js` 锁四条幸存语义(声明失败终局/自称完成要产物/contract.output 默认落点/requiredFiles 缺一点名)
- **验收**:单元 2225/2225;live health 74(仅先前既有 reachability)、dispatch 8/8、pipeline 12/12;system-action 40/43——**三红全在 l1-assign-expectations 的 resume 段,已定位为既有 L0 双实例分脑闪断**(证据:双实例都开 tracker 而 agent_end 单侧可见;昨日全绿轮同样的子合约同样 FAILED,探针不断言子合约状态);**复跑 43/43 全绿,flake 判定成立**
- 源: 备忘录138(三分模式), 用户裁定"拆除不是修复,破坏也无所谓"

## 2026-08-10(二)· AWAITING_INPUT 整体删除(v190-stable)

- **删的是一个假等待态**:crash-recovery 把它列终态永久跳过、全库零恢复通路、TASK_AWAITING_INPUT 事件零消费者——合约进去即对平台停止存在,却自称在等。删除只是把既成事实正式化
- `CONTRACT_STATUS`/终态表/L3 枚举/`DECLARABLE_STATUSES` 全面移除;**submit_output 只剩 completed/failed 两词**;缺外部信息 = `failed` + reason 写清缺什么
- BUSY 派发失败从"假等待"改记普通失败,重试归调用方;harness 的 `provide_missing_input_then_resume` 建议词一并删(给一个从未存在的 resume 提建议)
- 测试**重锁不迁就**:a2a 与 QQ 文案安全锁(内部诊断文本不得外泄)实质保留,只换 failed 夹具
- 源: 备忘录138 §8.1(用户裁定"输入中断设计直接删掉,目前没用")

## 2026-08-11 · 执行面取经 + 声明面挂载补齐

- **备忘录139【参】**:五家执行机制对照(OpenAI SDK 二分/Anthropic 扇出/LangGraph checkpoint 反面教材/Temporal 三纪律/A2A 背书),五条可取之经按价值排;`comparison-autogen-langgraph.md` 增补对应节
- **submit_output 挂载 0/10 → 10/10**(v191 后发现:声明面 L1 纸面是法律、现实零 agent 够得着;openclaw.json tools.allow 补齐+网关重载,health 73/74)
- **幂等辨析定调**:它不是判决面——判别键是"拔掉后是可接受降级还是正确性破坏";与文件归属(mtime)、合约认领、close 哨兵同族,全是**身份/记账事实**
- **"多实例分脑"旧标签被实证推翻**:单进程、单份内存(`resuming existing tracking` 铁证),真机制=宿主 gateway 与 pi-embedded **两条 hook 总线重复投递同一事件**(且非纯重复,砍一条会丢事件)。修法收敛为「hook 入口幂等铺满」+ 投递/唤醒幂等键;"会话单写者/实例认领"方案作废。40/43 的真正卡点在共享内存模型下**尚无解释**,待带目标复现
- 源: 备忘录139

## 2026-08-24 · 记录面终态:文件账退役,DB 唯一真值(v232)

- **用户裁决**:查明记账消费方后,全部搬 SQL 侧,文件侧退役——跳过双写验证期直切终态
- **侦察清点**(Explore agent 穷尽式):文件账消费方 = 10+ 读方(投影编译/GC 关账门/boot 孤儿恢复/collab 事实/健康巡检/inspect/dashboard/对账器)+ 2 写方;账/物边界按 148 §1.4(threads 树内 contracts/participants/投影/索引 = 物,不迁)
- **四批施工**(锚点 `v231-pre-sql-cutover`):①schema 演进(trace 身份键 hash→seq)+真值写/查询面 ②读面全切 DB(垫片全删,badLines 转兼容字段) ③写面转正(文件写路径/哈希链/链尖断言删除,group commit 平移为单 DB 事务,失败纪律分层入册) ④沙箱清理+文档
- **双写者防线换代**:`(sessionKey,seq)` 唯一索引当场拒第二次 seq 发行——D-H 事故形态从"静默入土"变"撞约束报警",哈希链随之退役
- **对账器转型**:文件↔DB 对账腿随文件账退役,转为库完整性体检(序连续/拒收计数/全局序水位/因果校验)
- **施工中抓到并修掉一个真 bug**:IN 子句匿名/命名参数混用导致查询抛错,crash-recovery 的 fail-safe 把"查询失败"当真孤儿,误杀排队信封(测试当场拦下)
- 测试:9 文件重写锁新语义,全量 2466/2465/0/1 与基线一致,连跑两遍幂等
- 源: 备忘录152

## 2026-08-25 · 前端重制收口:批3+批4 全清,旧 9 页入土

- **批3(92f95e5)**:管理区五子页迁入新架构(agents 装配卡/knowledge 按库评测+检索+维护/control-plane operator 快照+变更集/devtools 模型注册表+测试预设)+ 双语即时切换按钮;协议契约逐一对齐老页(kb 选择/eval-run/reindex/add 载荷)
- **批4(32c3fdf)**:旧 9 页 HTML + dashboard/ 54 文件 + 23 旧测试整删(−27k 行);版本字符串改写 hack(versionDashboard*)入土——新 SPA no-store 直发;**/watchdog/ 转正为新 SPA**(/next 为别名,progress 302 带参跳转);protocol-registry.js 迁 lib/protocol/(协议 id 真值本就该在 lib)
- 同日追加裁决落地:全谱 NASA-punk 上色(推翻 08-24 限色)+黑色系回调+读数带单条带重设计+编排图交互三件套(拖动/连线=逻辑投递/右键或圆钮+Delete 删边/环红警/布局 localStorage 与老页同键继承)
- 施工事故与修复:首帧空态冻结布局表(数据到达全节点抛错)、IAB 双标签 pane 状态干扰排查(应用无恙)
- 验证:全量 2334/2333/0;live 三区手验;旧页 404;SSE 原样
- 源: docs/superpowers/specs/2026-08-24-frontend-rebuild-design.md(已标记完工)
