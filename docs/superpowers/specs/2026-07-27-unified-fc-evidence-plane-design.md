# 统一 FC 证据面 · 设计规格

- **日期**: 2026-07-27
- **状态**: 终审通过(全部决议经用户逐点确认,见 §11 决议记录)
- **参考**: 备忘录126/127/128(`use guide/`)· fc-flowmap.html(`docs/`,总图/例走/体检 50 发现)· agent-handbook PART 3(Artifact)
- **本规格回答**: agent 内 FC 与 agent 间协作如何统一进一条证据链;期望(应然)从哪来;考官怎么判;工具面开什么;phase 归位何处;拆什么留什么;按什么顺序建。

---

## 0. 目标与范围

**目标**:让系统对"每个 agent 实际做了什么、该做的做没做"从考古式猜测升级为账本式对账——判定确定、可重放、不冤枉。

**做**:证据面(桥/账/采集/考官)、协作 FC 工具面 v1、contract.expectations 字段、计划表达 L1 化、判决落地 EvaluationResult。

**不做(红线)**:不动传送带选路权(固定=图/代码,动态=agent 在授权内);不为测试改协议;不给 operator 强上 FC(apply 批式通道保持);不用 LLM 当考官;不做条件 DSL;不造 L2 fence for plans;四份内存视图本期不拆。

---

## 1. 双平面总纲

- **执行面,各回各家**:本地工具(read/write/…)在工具运行时内完成;协作动作(assign/wake/review)必须平台代办,唯一汇合点 `systemActionConsume`,之后授权/票据/投递/回流保持现状,只新增 L1 入口。
- **证据面,天然一家**:两类 FC 在 `after_tool_call` 钩子眼里同形,一座桥照单全收进同一条 trace,同一采集器、同一考官。一次协作 FC 产生两笔:执行面走 consume(干活),证据面进 trace(留档)。
- **依赖铁律**:执行层可**读**证据层(终态链读 trace),证据层**永不写** contract;期望是审计判据不是运行时指令(平台不因未履约拦会话)。

## 2. 事件模型

事件 = `{kind, channel, name, args摘要, result摘要|受理凭证, outcome, seq, ts, agentId, sessionKey, contractId?, synthesized?}`。

- **两根正交轴**:`kind: internal|collab`(作用面,决定执行走哪条路)× `channel: fc|fence|text`(表达通道)。合法矩阵:internal 仅 fc;collab 三格全合法。非法组合 schema 层拒绝。
- **outcome 单源** = `isToolOutcomeError`(全量真值:error 参数+result.status 等)。禁止新增第三个成败分类器(体检确认 timeline 与它意见不合是既有 bug,不迁就)。被拒调用(before_tool_call 拦截)也入账,`outcome: refused`。
- **摘要注册表**(per-tool,一表一行,未知工具走保守默认):write/edit→`{path,bytes,contentHash}`(hash 对脱敏前原文算);read→`{path,bytes}`;bash→前 200 字+exitCode;**协作 FC args+凭证全量不摘**;默认→keys+截断。
- **脱敏**:复用 before_tool_call 现有敏感规则集(单规则源两消费者:拦截+`[REDACTED:type]` 替换),不造第二套。
- **单源红线**(体检衍生):路径解析单一 resolver(现状 ~ 展开 15 处 2 正则族,不做第 16 处);digest 单 helper(现状 9 份私有);ID 铸造统一 mintId(prefix)。

## 3. 账本与完整性

- **存储**:会话级 append-only jsonl,control-plane 下;单会话单写者无锁;哈希链继承自 execution-trace-store(prevHash→hash,链在完整事件上)。
- **完整性自证**:`session_open` 哨兵 + 会话内单调 `seq` + `session_close` 哨兵(带 eventCount)。采集器纯代码校验(open/close/seq 连续/count/末行撕裂)→ 不过则案卷 `evidenceStatus: incomplete`。
- **失败语义**:桥失败**不阻塞执行**(证据面严格弱于执行面);"证据不足反复出现"升格为系统健康信号(E-码盯桥不盯 agent)。
- **顺序**:会话内 seq 全序;轮次案卷跨会话按 (ts, sessionKey);L2/L3 提取合成事件 `synthesized:true` 于 close 哨兵前追加,逻辑位置=会话末尾。
- **三态判决**:每条期望 `fulfilled / violated / not_provable`;diff 缺口落在证据不完整区间**一律 not_provable,永不判违约**(冤案会经 TRUST_LADDER 产生真实后果);not_provable 在 automation 中性处理。
- **幂等可重放**:判决按 (roundId, contractId) upsert;trace+contract 自包含 → diff 可重放可单测。

## 4. 期望体系

- **字段**:contract 结构化三部曲补第三块——`expectations: { requiredArtifacts: [{path}], expectedActions: [{intent, target, required: true|false}] }`。条件期望止于 required:false(optional 缺席不亮红),不做条件 DSL。
- **来源(方案 A,源头凝固)**:动态协作=派工方 LLM 在 assign_task 参数里填(翻译一次、在源头、由当事人);固定管线=**每跳派送时平台按图/规格为当前 assignee 重导出/覆写**;图未定义则该跳期望为空 → 考官只做产物兜底,不判 violated。
- **写入权**:**expectations 只归平台写**(建约抄参数/每跳重导出),执行者永不可触(submit_plan 只写 stagePlan)——"要求你什么"不可自改。
- **单一真源三消费**:①渲染进 assignee 开工简报(走 contract.json 数据通道+outputDirectives 一条静态指令,渲染层近零改动,合缓存裁定)②受理时校验(schema+授权,垃圾期望结构化拒绝)③考官审计 diff。
- **边界**:replyTo/deliveryTargets=平台义务(路由回传),不进期望表;期望只装 agent 自己该主动发起的动作。

## 5. 工具面

**协作 FC v1 = 3**(不可替代试金石:必须平台代办+组合不出):

| 工具 | 语义 | 回流 |
|---|---|---|
| assign_task | 派活(开新单腿工单;参数携带 task 原文+expectations+phases;期望翻译唯一通道) | deferred 票据回流 |
| wake_agent | 叫人(最轻激活原语,一句 reason 不投工单) | fire-and-forget |
| request_review | 请审(诚实标注:assign 特化;独立理由=授权粒度+既有 review_verdict 通道) | deferred |

**缓建**:create_task(等"先立项后派送"真场景)。**平台服务 FC 族**(不跨 agent、不走 consume、不查图边,均缓建):submit_output(等返工痛)/report_progress(等 UX 排期)/submit_plan(planner 升级批次)。

- **受理凭证语义**:tool_result={accepted, contractId, queuePosition}|结构化拒绝,**不是执行结果**;拒绝在受理时刻返回(当场可改道),同样入账。
- **授权单源**:collaboration-intent-policy 一表,四消费(工具暴露/受理校验/期望校验/考官意图词汇);role-policy 矩阵并入;**矩阵收回 planner 的 advance_loop**(planner 不指挥回路);编排权 start_loop/advance_loop 永不暴露;**resume_finalization 裁掉除名**(intent 词汇表 7→6,死分支删除)。
- **多动作**:L1 天然多动作(多次独立 call 各自凭证);**contract systemAction 单槽数组化为必做配套**,否则 FC 多动作存不下。

## 6. Phase 体系

- **本义**:phase=单 agent 内任务拆分,手段是列步骤,**目的是写好结构化 prompt**;UX 是副产品。**红线:不得用 phase 做跨 agent 分工**;多跳语义走角色分化(SOUL)/每跳期望/动态单腿工单。stagePlan/stageRuntime 作用域=单 agent 会话,交棒不推进。
- **三源**(按摸底深度分层):①派工先验(assign 带 phases,底线)②planner 上家跳③agent 自摸(plan mode)。**覆写规则:后到覆写先到,覆写事件入 trace 留痕**(信息量单调递增,真值面保持单值,历史进账本)。
- **现状(已测绘)**:[STAGE] 物化桥已存在且角色无关(agent_end 提取→materializeTaskStagePlan→contract.stagePlan+SSE);前端"有 plan 才显示 phase"门已实现(dashboard.js:612-629);planMode 配置零实现。
- **planMode 三态新家(planRequired 死字段清葬)**:off=不给工具+无期望;auto=submit_plan 可选自决;required=期望里写"应提交 plan",考官对账(plan_output_guard 的期望化替身,零新守卫)。**plan 阶段不限工具权限**(不做 feature gate;越权拦截已有 before_tool_call 守当)。
- **planner 升级 FC**:主升级=[STAGE]→submit_plan(schema 受理校验坏计划当场打回;会话中即物化前端立刻显示);planner 与 plan-mode **共用同一工具**(区分一句话:plan 的作者与受益人是否同一人);PLANNER_OUTPUT_DIRECTIVES 文案更新(plan 结构走 FC,brief 仍写文件);plan 层级只设 L1/L3。
- **标记家族对称**:[ACTION]/[STAGE]/[FINDING] = 各类结构化表达的 L3;FC 化是同一个故事讲三遍。

## 7. 考官与判决落地

- 轮次级、纯代码 diff(该跳期望 ↔ 该跳会话 trace),零 LLM 零 token 可重放。
- 四判据:完成判定升级(write 事件目击+contentHash 可复核盘上文件)/协作履约(该叫的叫没叫;期望在账上无→violated;期望与授权冲突时判 violated 并附 refused 证据,矛头指向派工配置)/过程合规(refused 事件、重试风暴、空转)/成本画像(调用计数、耗时,喂 automation)。
- 判决写回 **EvaluationResult**(终结 reviewerResult 原样转贴;过渡期保留 fallback);AutomationDecision/TRUST_LADDER/governanceSnapshot 后场一行不动。
- 声明可审计:report_progress 声明与 write 目击同账,虚报留痕("声明阶段2完成⚠未目击产物")。

## 8. 终态链与回流

- **B5**:agent_end 读本会话 trace 过滤 kind:collab 拿"事实索引+动作 ID",拿 ID 查 **delivery-tickets JSON(真 ledger;"runtime-ledger"模块是纯推导,勿混)** 取现状;文本路动作仍提取在手,两路合流进现有终态优先级链。trace 缺失/不完整→退回现行行为,永不崩。127 的"回执回填通道"方案作废不建。
- **前置验证(P3 开工硬条件)**:live 复现 deferred 回流链(followUpLease 零处 arm 属遗留消费通道,回流实际靠 delivery 侧 exact-session 唤醒+3 次确认重试)。

## 9. 拆除与不拆

**拆/换/裁**:recordDelegationIntent+delegationReceipt 消费分支(死桥)/commitments.systemActionSeen(永假)/execution-trace-store 内存 Map(退役并入新store,initTrace 期望提取上移)/collector.trace 查身份实现(换真采集)/gate.test 口令匹配、gate.schema 永 skip(退役或换证据源)/guard.tool_access·scope 查声明(换对账实际用量)/回执回填通道(不建)/EvaluationResult 转贴逻辑(转正)/resume_finalization(裁掉除名)/planRequired 死字段(清葬)/planner-v3 死元数据(清理)。

**不拆及理由**:四份内存视图(范围纪律,远期退化为正本投影)/L2·L3 文本路(降级容错)/offTrack 预警(有用)/固定管线自动选路(第一性原则)。

## 10. 实施蓝图

- **P2 授权单源**:collaboration-intent-policy 一表四消费;role-policy 矩阵并入+advance_loop 收回+resume_finalization 除名。验收:三处查询一致。
- **P3 工具库**:3 工具+handler 汇入 systemActionConsume+受理凭证;**配套必做**:systemAction 单槽数组化、终态链读 trace(B5);**前置**:live 验证回流链。
- **证据面主干(独立并行,不依赖 P3)**:桥+统一 trace+完整性哨兵;摘要注册表+脱敏复用。
- **P4** binding 挂载(工具面进 agents.list tools.allow)。
- **P5** preset 三层化(顺带终结 system-action 12/26 常红——L1 不经提取门,hook 会话可发协作 FC)。
- **P6** 考官+collector.tool_trace+EvaluationResult 接线。
- **后批**:submit_plan(planner 升级)/submit_output/report_progress/create_task 按"等什么再开"逐个解锁。
- **测试**:每期扩 test-runner(CheckResult/E-码入注册表),证据链新 E-码;报告 failures-first。

## 11. 决议记录(全部经用户确认)

1. 统一范围=仅事件+审查层,选路权不动;2. 双平面(执行各回各家/记录同进一本账);3. 三层递进保留,文本路合成事件入账;4. kind×channel 两轴+refused 入账;5. 判据四类全选;6. 期望来源 A(B 排除,C 留演进);7. contract 三部曲补第三块;8. 单一真源三消费;9. replyTo 平台义务/expectations agent 义务;10. 审计判据非运行时指令;11. 两座桥职责隔离;12. B1 三态判决+完整性哨兵;13. B2 摘要+脱敏单源;14. B3 顺序语义;15. B4 幂等可重放;16. B5 读 trace 废回填;17. B6 条件期望止于 required;18. 工具面 3+缓建(127 五工具面作废);19. 载荷四件套;20. 按跳期望重导出/空则兜底✅(终审);21. phase 本义修正+作用域单 agent;22. 三源+覆写规则(后到覆写先到+留痕;期望只归平台写)✅(终审);23. planMode 三态由工具+期望吸收;24. plan 阶段不限权✅(终审);25. planner/plan-mode 共用 submit_plan(作者=受益人之辨);26. advance_loop 从 planner 矩阵收回;27. resume_finalization 裁掉除名✅(终审);28. outcome 单源=isToolOutcomeError。

## 12. 风险与验证要求

- **最大风险**:B5 依赖的回流链带病(followUpLease 死簿记)——P3 前 live 验证,不通则先修回流再上工具。
- **静态误判教训**(contract.output 镜像事故):核心运行时判定落地前 live 复现,不静态猜。
- **性能预算**:桥增量=一次摘要(亚毫秒)+一次异步 append(O(1)),为 after_tool_call 现有工作量的零头;考官轮末批处理零 LLM。
- **独立债不混入**(已记账 29 条,另行排期):loop LRU 淘汰 hard-stop 标志、provenanceNonce 零写入、task-state.md 并发互踩、路径 resolver 四胞胎、错误正则双份、canonicalize 三胞胎、QQ 死副本假绿测试等。
