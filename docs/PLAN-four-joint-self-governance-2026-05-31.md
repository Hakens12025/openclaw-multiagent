# 计划书:四关节自治闭环(harness/CLI-system/operator/automation)

> 日期 2026-05-31 · 起点 v112-stable · 经 11-agent workflow(现状普查 + 三视角对抗审稿)产出
> harness=工具 · CLI-system=手脚 · operator=**meta-agent(系统运维优化的强权限 agent)** · automation=最终实现
> 状态:**规划稿,待用户拍板优先级/起点**
> 2026-05-31 校正:operator 是一个 agent(meta-agent),非"治理引擎";"去伪智能化"=拆掉 if-else 超级集合还原成真 agent,非限制其智能。详见 6.5/附录与备忘录120 附录。

## 0. 愿景
OpenClaw 长成「**会自己运维的系统内自治结构**」,而非「更好用的 agent 工具链」。脑-手-工具-自治四关节闭合成**一条带反馈的真值回路**:每跑一轮就把「怎么塑形/评得如何/怎么决策/能力是否值得固化」沉淀成正式对象,使下一轮 operator 优先选现成拼图、harness 复用已验证模块、小模型只填内容不背流程。**「用得越多越顺」= 系统级自适应自治**,不靠外部超级大模型或人工外科手术。

## 1. 关键修正(经代码核实,纠正直觉误判)
回路真实断点**不是**"action 无 dispatch"(action 已是 `status`/`nextWakeAt` 的派生投影,`cli-chain-e2e.test.js:391-396` 已声明它是 ProfileLifecycle 上游信号)。真死链是三处:
- **(a) reworkGuidance 零消费**:`automation-decision.js:123-135` 构造它,全仓 grep **0 处读** → 下一轮 dispatch 不带上轮失败信号 → 小模型不知哪错。
- **(b) CLI-system 无法真执行**:`apply`/`verify` 族 catalog **0 条目**、`operatorExecutable` 全仓 **=0**,而 executor 硬要求它 =true → 今天连 operator 都得走 admin-surface 旁路。
- **(c) governanceSnapshot 无读取合流点**:写了没人读(deriveDecision/computeImprovementState 现读 `spec.governance`)。

物理实现 = **把这三处断链接通**,而非给已工作的控制路径加第二开关。

## 2. 自治反馈回路(用得越多越顺)
```
①harness 工具      一次执行 → moduleRuns(guard/collector/gate/normalizer) → HarnessRun(唯一 run 级事实源)
        ↓
②evaluator         buildEvaluationResult(HarnessRun) → EvaluationResult{verdict,continueHint,score,confidence,findings}
        ↓
③automation 决策    deriveDecision → AutomationDecision{action,status,nextWakeAt,reworkGuidance}
        ↓           ├─ reworkGuidance 注入下一轮 dispatch entry.message(让教训进下一轮)【修(a)】
④CLI-system 手脚    operator/automation 经 cli-surface-executor(apply)→ admin-operations → verify 强制门【修(b)】
        ↓
⑤automation 自治    ProfileLifecycle 消费多轮历史 → 渐进硬化 trustLevel → 写 governanceSnapshot
        ↓           └─ resolveGovernance 合流点回灌下一轮 harness(每轮 governance 由上轮决策链算出,非定时器)【修(c)】
        ╰──────────────────────────── 闭环 ────────────────────────────╯
```
**闭环判据(E2E)**:provisional automation 连跑 3 轮全 pass → trustLevel 自动升 experimental → 下轮 harness 读到收紧的 governanceSnapshot;operator 可观测并经 `apply.update_automation_governance` 介入。

## 3. 对象链闭合(11 概念,尾段唯一未建)
| 段 | owner | schema 状态 | 消费点 |
|---|---|---|---|
| **HarnessRun** | harness 层(harness-run.js) | 已活,接口散在 4 处(P0 归一) | evaluator + operator(经 inspect.harness_runs) |
| **EvaluationResult** | evaluator(evaluator-result.js) | 10 字段已冻,缺 confidence+findings(P2 补) | deriveDecision + 未来 loop/stage policy |
| **AutomationDecision** | automation(automation-decision.js) | 已冻 | runtime.lastAutomationDecision + operator 投影;reworkGuidance 待接通(P1) |
| **ProfileLifecycle** | automation 演化层 | **唯一未建=扩展点**(cli-chain-e2e.test.js:400 已标) | P4 新建:消费历史现算 streak → 写 governanceSnapshot |

## 4. 阶段计划(2026-05-31 修正终稿:依赖链硬约束重排 + operator 校正 + 死链 b 纠错)
> **关键纠错(real-first)**:之前口头叙述说"operator 手全瘫、apply 一次都执行不了、operatorExecutable 全仓=0"是**错的**——那是只 grep 了静态 `cli-surface-catalog.js`(28 条 hook/inspect/observe,operatorExecutable=false 是正确范畴),漏看了 admin catalog 动态注入。运行时合并集(`cli-surface-registry.js:83-92 buildCliSystemSurfaceList`)实测:**admin 有 28 个 operatorExecutable:true 的 apply surface,经 executor 四道门 + operator-executor.js:26 已完整可执行**(与本文 §6.5 line 97"apply 28/44 可执行"一致;§1 line 14 的"0"叙事作废,以此为准)。**死链 b 的真相 = verify 环断 + 静态/admin 两源真值边界未裁定,不是"手全瘫"。**
> **机读 DAG(无环已验证)**:P-1→{P0,P2.5,P6a,INT-pkg};P0→{P0.5,P1,P2};P1→P2;P2.5→{P3,P5};P3→{P4,P5};P2→P4(软);{P4,P5}→P7;P6a→P6b。

| 阶段 | 关节 | 状态 | 目标 | 依赖 |
|---|---|---|---|---|
| **P-1** 现状基线普查(用运行时合并集) | cross | ✅done | 盘点真值(用 buildCliSystemSurfaceList 含 admin 注入,非 grep 静态)。实测 apply 28 可执行、verify 环断、死链 c 属实(resolveGovernance lib 无定义) | — |
| **P0** HarnessModule 接口归一 | harness | ✅done `07d66d4` | 5 对象契约+schema 归一+evidence/failure_class 词汇+schemaVersion 槽 | P-1 |
| **P1** 接通 reworkGuidance→下一轮(修死链 a) | automation | ✅done `4fca9ad` | rework 写 runtime→entry.message 注入;回归门 test:77 断言 reworkTarget 真进下轮(已锁死) | P0 |
| **P0.5** 拼图性+反逼性补位(harness 灵魂) | harness | ▶next | ① Run-Shape Map 升正式对象(现仅 coverage 字段)被消费 ② coverage 完整性校验(不声明报警)③ soft/freeform 段反逼(normalizer 给 soft 产建议模板,现只追 hardShaped)④ Meta-harness 校验(新 module 接入被问 kind/io/evidence/failure/层,扩 validateHarnessModuleDefinition 现仅校 id/kind/hardShaped)。守红线:不碰 graph/loop/delivery/commit | P0 |
| **P2.5** 裁定 surface 真值边界+证 apply 链路活着(死链 b 上半,**收窄为轻量**) | cli-system | ▶next | **纠正:apply 已通,非从零打通**。block-check;画 static(读层 0apply)/admin(写层 44apply)/operator-surface-policy(过滤视图)三源流向,确认"一源多视图"非真值分裂;裁定 admin-surface 即唯一 apply 真值源+文档化分层契约(不删 static 读层);**不去翻静态 inspect surface 的 operatorExecutable**(范畴错误);端到端跑通 operator 经 executor 真执行一次已存在 admin apply 证链路活着;applyDecisionAction lib 不存在→"否决旁路"为文档项 | P-1 |
| **P3** verify 暴露为正式表面+强制 apply→verify 门(死链 b 下半=**手的真缺口**) | cli-system | ▶next(关键路径) | verify 骨架已存在(admin 3 个 stage:verify + admin-surface-registry.js:217 buildVerificationCapability + admin-change-set-verification 字段链)。真缺口=经 cli-surface-registry 暴露为正式 verify 表面 + apply 后强制插入 verify 门 + 回写既有 verificationHistory/lastVerificationStatus(不造第二套)。verify 须答 验什么/证据从哪/成功标准/失败归因;不过 verify 不能 commit | P2.5 |
| **P2** EvaluationResult 历史+confidence/findings | automation | later | recentEvaluationResults[] 环形+findings.artifactRef 代码从 HarnessRun evidence 提取(找不到拒收)。锦上添花,让位 P2.5/P3 | P0,P1 |
| **P4** ProfileLifecycle 尾段+resolveGovernance 合流点(修死链 c,**从零建**) | automation | later | 注意 resolveGovernance lib 无定义=从零建函数+合流点(非接通已有)。ProfileLifecycle 现算 streak→渐进硬化 trustLevel→写 governanceSnapshot→resolveGovernance 回灌+全局熔断+retired 复活 | P1,P3 |
| **P5** operator 配齐知识/接口/落地通道(经 CLI 闭环) | operator | later | **去伪拆 if-else 已完成**(operator-runtime.js 63 行薄壳+brain/executor/knowledge-library 已分)。本阶段=给已还原的真 meta-agent **配**知识库注入+正式 inspect 接口+经 cli-system apply→verify→回灌落地通道。它本职就该规划,**不限制其智能**;保留 operator-brain.js advice_only 诚实兜底(无可执行 surface 时如实说明=合法纪律,非旧框架) | P2.5,P3 |
| **P6-Phase0** 建通用机制(不删 contractor) | cross | later | 深读 85/86 后修正:agent-group 是严格三阶段,非"清残留+macro 两步"。Phase0 先建**通用 binding policy 机制**(executionPolicy{planRequired,timeoutAction}/outputPolicy{format,aggregateGroup}/dispatchOrigin/plan-dispatch-service/inboxPolicy.preserveDrafts),**不删 contractor 只建替代品**(executionPolicy 今天不存在于 agent-binding-store.js,这是第一步)。与自治回路无数据依赖,可独立并行 | P-1 |
| **P6-Phase1** 迁真劫持点→policy(God-role 清理,**调研后收窄**) | cross | ▶next | 调研纠正(P6-Phase0):contractor 点名硬编码已迁完(剩 15 处全在 formal-runtime 测试 fixture),executionPolicy/helper/dispatchOrigin 已建。`role===X` 属性查表**合法保留**(role 是 agent 合法属性)。**只迁真·劫持非预期角色流转的点**:① reworkTarget 回退(reviewer-verdict:45 isSpecializedExecutor/isResearcherAgent)② executor_contract handler matchAgent(handler-registry:23)③ heartbeat actionable-work(heartbeat-gate:41,50)。迁到 outputPolicy.canReceiveRework / preset flag / policy。其余 6 处 role 查表(soul 模板/intake/notify/bridge hook 等)合法保留 | P6-Phase0 |
| **P6-Phase2** AgentGroup 宏展开 + 前端画框 | cross | later | 备忘录85/86:**AgentGroup 是宏非 runtime 对象**——internalEdges 展开成 EdgeSpec(带 metadata:{groupId})+ outputMode→outputPolicy + GroupSession 追踪(类比 loop-session-store);三输出 passthrough/aggregate/race;space×time 与 loop 正交可嵌套。**复用 graph 授权+排队不造新 transport,组内走显式 EdgeSpec 不开免授权暗门**。否决:team config 当真值/隐形编排器/硬编码团队/group 自带 dispatch | P6-Phase1 |
| **INT-pkg** 双文件包流转接入 | cross | 在途(task#24)。降级为 integration checkpoint:就绪即接入作 harness collector 证据源,不阻塞也不被阻塞 | P-1 |
| **P7** 演化/兼容/可调试收尾 | cross | 填 schemaVersion 演化逻辑、runtime checkpoint(复用 governanceSnapshot 存储)、observe 编程入口。标"评估非建设",有真消费者才建 | P4,P5 |

## 5. 未建功能归位(16 项)
- **P0-critical**:ProfileLifecycle 对象 / resolveGovernance 合流点 / reworkGuidance 注入 / CLI-system 真执行打通
- **high**:verify 族 / operator 验证反馈(复用 EvaluationResult)/ 全局自治熔断+retired 复活 / inspect.profile_lifecycle 观测面 / 双文件包流转(在途)
- **medium**:EvaluationResult confidence+findings / God-role 清理 / Agent-Group 空间原语
- **low**:HarnessRun 版本演化 / observe 形式化查询 / runtime checkpoint(time-travel,对标 LangGraph)
- **deferred**:外部 agent 联邦 + workspace alias(备忘录103/102 待决,不排主线)

## 6. 红线纪律(11 条,不可违)
1. **概念预算≤11**:否决新建 OperatorEvaluationResult(第 12 概念,与 EvaluationResult 重叠);operator 验证结论复用 EvaluationResult 加 source=operator。
2. **一条路径**:否决 applyDecisionAction 旁路(action 已是 status/nextWakeAt 派生);apply 必须裁定 cli-surface vs admin-surface 唯一路径(P2.5)。
3. **不造第二真值**:contract=路由/状态、graph=授权、HarnessRun=run 级唯一事实源;verify 回写既有 verification 字段;findings/streak 是派生量;observe 是 inspect 视图;ProfileLifecycle 只写 snapshot 不改 spec。
4. **写了必被读**:新增 runtime 字段必须指明唯一读取合流点(否则=reworkGuidance/action 式死字段);回归门断言"信号真传到下一轮"而非"字段被写入"。
5. **代码管流程/LLM 管内容**:resolveGovernance/reworkGuidance 注入/verify 门/硬化规则全是代码;evaluator/operator agent 只产内容,findings.artifactRef 由代码提取。
6. **operator 是真 meta-agent,不是 if-else 引擎**(校正):operator 该理解/判断/规划(本职),"去伪"=拆 if-else 还原成真 agent,非限制其智能。约束在**落地纪律**(代码护栏)而非剥夺其智能:经 cli-system apply/verify 落地(不直写真值/不绕 handler/不直改代码)、读正式 inspect(非散乱查询)、改动可审计可回滚、brain 不可用时如实说明而非伪造确定性计划。management 精妙=配好接口/知识/落地通道。
7. **automation 不退化成定时器**:轮次已由 status/nextWakeAt 驱动;真改进=reworkGuidance 进下一轮+governanceSnapshot 由证据链算出;只读 formal object 不爬日志。
8. **先普查后定义、增量、不跳步**:P-1 是所有缺口定义的事实地基;接口→reworkGuidance→历史→执行→verify→尾段顺序。
9. **传送带纪律**:graph=授权非时序,loop=重复投递非新协议,replyTo 回传;禁硬编码 agent 名(P6a 先清);包流转/Agent-Group 复用 graph 授权+排队不造新 transport。
10. **安全阀非可选**:全局熔断(异常 snapshot 一键回 spec 默认)+retired profile 经 operator 复活;并发裁定 profile↔automation 基数,trustLevel 升降经 apply 串行化。
11. **scope/质量红线**:surgical;每阶段附"使哪些代码失效"清单(尤其 reviewerResult legacy fallback 退役表);god object 拆分;UTF-8 无 BOM;跨 3+ 板块先 block-check。

## 6.5 harness 灵魂深读(备忘录78/113)与落差(2026-05-31 补)
> 深读用户 harness 设计后补入,修正 P0 做窄的问题。

**拼图性**:harness=标准拼图块(guard 约束/collector 采集/gate 判别/normalizer 塑形)到处复用、自由组装;四层 Module→Profile→Coverage→Run-Shape。动机:① 真实系统永远同时有"能硬化/没硬化/不该硬化"三段,先工业化能工业化的;② 为小模型减负——系统扛流程,9B 只填内容。
**标准化反逼性**:硬管(timeout/schema/test/artifact→gate 卡关,不过不能往后推)/软管(memo/findings 模板,要结构留弹性)/开放(research,硬化即退化);Meta-harness=标准化拼图倒逼未来新 harness 继续标准化(新模块接入被问 kind/io/evidence/failure/层)。
**红线(备忘录61)**:harness 只碰执行塑形(输入标准化/隔离/调度/产物/封装),绝不碰 graph/edge/loop 下一跳/replyTo/delivery/lifecycle.commit。

**落差(设计 vs 实现,带 file:line)**:
| 设计 | 现状 | 缺口 |
|---|---|---|
| Run-Shape Map 正式对象 | 只在 HarnessRun.coverage 字段(harness-run.js:43,56),无独立对象/无完整性校验 | ❌ P0.5 |
| soft/freeform 反逼 | runner 只追踪 hardShaped+gate(harness-module-runner.js:38-82),soft/freeform 无校验无建议 | ⚠️ P0.5 |
| Meta-harness 倒逼 | 仅 validateHarnessModuleDefinition 校 kind,无"接入被问全套"机制 | ❌ P0.5 |
| 拼图自由组装 | profile 写死 frozen array(harness-registry.js:42-113),buildHarnessSelection 支持 moduleRefs 自定义(半成立) | ⚠️ 后期 |
| verify 成体系 | 只 3 个二阶 verify surface、operatorExecutable 全 false → 脑-手-工具闭环的 verify 环断 | ❌ P3(红线四:verify 须答 验什么/证据/成功标准/失败归因) |
| ProfileLifecycle | 0%(profileTrustLevel 只是静态标签 harness-registry.js:22-26) | ❌ P4 |

**四关节实现度(深读评估)**:harness 工具 ~部分(拼图/反逼有缺)、operator meta-agent ~已拆 if-else(brain/runtime 薄壳/executor 分离),但**它的"手"(经 cli-system apply/verify)还瘫**(见下行)→ 这个强 agent 想改系统却落不了地、verify 不了、知识库/接口还没配全;CLI 手 ~70%(apply 28/44 可执行,verify 环断);automation 自治 ~初期。**关键:operator 拆 if-else≠完成,它作为 meta-agent 的接口/知识/落地通道(P2.5/P3/P5)才是本计划要补的。**

## 7. 建议起点
**P-1(现状普查)+ P0(接口归一)+ P1(接通 reworkGuidance)** 是最小可见闭环增量:让"上轮教训进下一轮"先跑起来——这是"用得越多越顺"的第一个可观测信号,且不碰写路径(低风险)。P2.5/P3(打通 cli-system 真执行+verify)是手脚地基,P4(ProfileLifecycle)是闭环收口。Agent-Group(P6)与自治回路无数据依赖,可独立并行。
