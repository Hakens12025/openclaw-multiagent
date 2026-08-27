# 产物交接流转系统 — 终检报告（2026-08-05 02:1x，基于 HEAD `39ba009` + 未提交工作树）

> ⚠️ **历史快照,勿当现状读**(标注于 2026-08-09)。此后已落地:动态协作不查图边(v179)、协作主路从 `[ACTION]` 标记换成 FC 工具、采集不再要求 `outbox/runtime_result.json` 提交令牌(v181)、`upstreamPackages` 升格为 `{path,producer,files[],primary}` 对象、`_manifest.json` 机制已删除。正文保留当时原貌。

## 0. 读前必读：本次"HEAD"是活动靶

`git log` HEAD=`39ba009`，但 `git status` 有 **38 个已改 + 5 个未跟踪**文件，mtime 集中在 **01:45–02:09**，而我开始复核是 02:0x、现在 02:12 — 代码在审计期间仍在被写。三点后果：

- **committed tree ≠ 运行的代码**。F3 facet 判 `assign_task` 工具面缺 `expectations/phases` 为真，我复核时它已在工作树里落地（`lib/system-action/collaboration-toolface.js:26-61`，`git log -S expectations` 该文件零命中 = 从未进过 commit）。同一条债，读 committed 是"仍开"，读工作树是"已修未提交"。
- **本报告一律按工作树（=实际会跑的代码）判定**，行号以工作树为准；凡与两份先验文档行号差 2–4 行的，是文件被改过，不是先验数错。
- **`lib/evidence/*` 8 个文件里 5 个在 01:45–01:54 被改**，证据面正处在改动中段，第 6 节的结论保质期最短。

---

## 1. 一句话结论

**固定管线的产物交接是健康的、可信的、并且在 7/27 那波修复后被真实流量（18 个两跳合约 + 725 组探针）证伪过——幽灵包从 06-01 起彻底归零；真正有病的是三处接缝：动态派工腿的产物交接从未接线（是漏接线不是设计否决）、新证据面按 sessionKey 跨合约共账本导致执行面被污染、以及新落地的 P6 转正层让一个恒为空的期望集覆盖了真实评审结论。**

---

## 2. 已知问题状态台账

### 2.1 我的 7/27 静态审计（该文档已系统性过期：H2/H3/H4/M1/M4/L1/L19 在其成文后 1 小时的 `f5c8e39`/`77af649` 中修掉）

| 编号 | 问题 | HEAD 状态 | 证据 |
|---|---|---|---|
| H1 | inbox/upstream 永不清理→跨合约污染 | **已修** | `lib/routing/mailbox/runtime-mailbox.js:49` `rm(inbox/upstream,{recursive,force})` 在 copy 之前、`if(contractId)` 之内（`14703d6`）。修复位置比我当时建议的 artifact-store.js 内清理**更对**：它覆盖了 `artifact-store.js:255-259 perProducer.size===0` 早返回那条路径。盘面：81 个工作区 `find -name upstream` **零命中** |
| H1' | 残留：清场闸在 `if(contractId)` 内 | **部分修（窄）** | `resolveStagedContractId` (:13-23) 两源皆空→null→不清。且 `runtime-mailbox-transport.js:70 if(!entry.isFile()) continue` 使 cleanInbox 从不删目录 → upstream/ 全库**只有这一个**清理点。⚠️ 但不要按"把 rm 无条件前移"修：`inbox-handlers.js:140-144` 在"同 agent 另一 tracker 在跑"时 contractId=null，会误删**执行中** session 的包 |
| H2 | 控制噪声分类器误杀长交付物 | **已修** | `runtime-user-facing-output.js:5-8` 锚定组 / `:14-24` 200 字闸 + 非锚定组 / `:75-81` 先锚定再长度闸。`node -e` 实测：4034 字含"runtime 语义"→null；边界在 **201**（先验写 204/205 不准）。残留窄口见 N6 |
| H3 | handoff 完成门不覆盖 loop 分支 | **已修（结构性）** | `agent-end-graph-route.js:151-173` `runHandoffGate` 统一收口 + `:148-150` 防复发注释；4 个转发站点（:399 loop / :538 / :550 hard-stop / :570 常规）全过门；另 2 处 `routeAfterAgentEnd`（:455/:580）经核不构成绕行。测试 11 例，我实跑 15/15 pass |
| H4 | 空产出回退 contract.output→幽灵包 | **已修** | `agent-end-stage-definitions.js:269-280` 新鲜度门（seam H4 注释）+ `execution-observation.js:165-175 isPathFreshForSession`。阶段序独立验过：transport.js:29 不传 opts、preserve(264) 早于 terminal(452)。盘面见第 4 节 |
| H4' | 防线只剩"阶段顺序"这一层隐式不变式 | **新隐患（修复自带）** | `primaryOutputPathSource`（execution-observation.js:56/103）**生产侧零消费者**；:269 写的是 `obs.primaryOutputPath \|\| null`。任何人给 transport.js:29 补 fallback 参数，门即静默失效 |
| M1 | normalize 把采集失败反转成 collected:true | **已修** | `execution-observation.js:112-116` OR 链已删两条错误置真通道，:70-83 分离 source/fallback 派生量。`node -e` 实测四例全对 |
| M2 | outbox 提交非事务化 + 永不清理 | **仍开** | `runtime-mailbox-outbox-helpers.js:156-174` 循环顺序一字未改；:284 无条件删 runtime_result。**高频触发器是 :232-234**（agent 写了 md 却没写 runtime_result.json → 早退不删任何文件 → 残件永久滞留 → 下次被 :249 无 mtime/无合约归属地采走 → 镜像进下一份合约的 contract.output）。这是唯一能绕过全部新鲜度门的通道 |
| M3 | producer 包只增不清、manifest 只描述最后一次 | **仍开** | `artifact-store.js:156-171` 全函数无 unlink；下游取包走 `:247 listPackageFiles` 目录枚举而非 manifest。盘面 4 例 dir≠manifest（教科书例：`TC-1780286807197-969547/researcher1` 目录里 `__r1__`+`__r2__` 两轮并存，manifest 只列 r2），全是 06-01 老数据 |
| M4 | E-CONTRACT-006 证明不了注入 | **已修（漂亮）** | `suite-link-cases.js:66-72` 删 producer 侧 artifacts 证据源、:113/:153/:159 cid 定界、:122-125 指针不列即记 mismatch；`error-codes.js:61` 注册表明文同步。**我 7/27 说"这道门的绿灯不能当证据"这条限制可以解除** |
| L1/L19 | contract-output-alias 模块 / 硬编码工作区路径 | **已修（删除）** | `lib/delivery/` 现只剩 `context-compression.js` + `runtime-user-facing-output.js`，全库零引用 |
| L2 | saveAgentArtifact 全链零可观测 | **仍开** | `artifact-store.js` 四条静默出口（:154/:168-170/:172/:194-197），调用点 `stage-definitions.js:288-295` 丢弃返回值。注意吞错本身是红线设计（:16 + :130 双重注释），要补的是日志不是抛错 |
| L15/L16 | requireDefaultOutputArtifact 零写点 / retryable 零消费点 | **仍开（半套）** | 前者 `contract-outcome.js:91` 唯一读点；后者写入 7 处、`.retryable` 的**读**只有 `terminal-outcome.js:39` 一次归一化，无任何分支消费——而 H3 的门正在给每个拦截写 `retryable:true` |
| L17 | FAILED 对外交付四字空壳 | **仍开，且是两个站点** | `delivery-terminal-runtime.js:76` 与 `delivery-terminal.js:55` 都固定 `"❌ 任务失败\n任务未完成。"`，两站分工（QQ 目标 / 内部 agent replyTo）。**先验只找到前者，照它修完内部回传腿依旧瞎**。同文件 AWAITING_INPUT 分支写法正确，照抄成本≈0 |
| L18 | writeUpstreamPackagesPointer 非原子 + 不刷缓存 | **仍开** | `runtime-mailbox.js:66-78` 裸 readFile/writeFile；隔壁 `inbox-handlers.js:97` 用 atomicWriteFile。且现在 M4 的新探测**依赖这个指针做判据**，指针写失败会把正确投递记成 mismatch |

### 2.2 备忘录129（P1-P10 + 三条 still-open high）

**先纠一个元事实**：memo129 提交于 `c9548e2`(07-28 04:33)，`git diff --name-only c9548e2 HEAD | grep '\.js$'` 为**空**。所谓"SINCE THEN ~30 commits"（P2-P6 证据面、P5 预设分层、/simplify 波）全部落在 memo129 **之前**（07-27 22:19 ~ 07-28 03:41）。**"这 8 天顺带修掉了哪几条"的答案是零**——一行 .js 都没提交。唯一在动的是当下这批未提交改动。

| 编号 | 问题 | HEAD 状态 | 证据 / 纠正 |
|---|---|---|---|
| P1 | outbox 残件跨轮污染 | **部分开（memo 表述需纠）** | memo/F2 称"平台从不清 outbox"**不成立**：`outbox-helpers.js:168 removeFileQuietly(src)` 成功路径清得干净（盘面 4 个 outbox 目录全 0 文件）。残件**只来自** :229/:233 两条早退（发生在 materialize 之前）→ 与 P2 同根，修 P2 即消 P1 |
| P2 | collectOutbox 静默返回 | **仍开** | `runtime-mailbox.js:84/:92-94/:101-103` 三条零日志（:96-98 empty 有 info）；helpers :228-230/:232-234 两条带 error 字段但零日志。`executionObservation.error` **全库零消费方** |
| P3 | tracker-store 纯内存、重启失忆 | **仍开** | `lib/store/tracker-store.js` 488 行，`writeFile\|readFile\|persist` 零命中 |
| P4 | control-plane/output 无 cid 分桶 | **仍开，且应升级** | 67 个扁平裸名文件。见 N5 |
| P5 | assign 去程零产物交接 | **仍开**（工具面 expectations/phases 已在工作树落地） | 见第 5 节 |
| P6 | staging/缺料语义、并集修复 | **部分修** | `fede51d` 的 preserved∪manifest 并集是真修复（见第 4 节盘证）；三态歧义仍开 |
| P7 | 独立留存无配对保留期 | **仍开，但归因错** | contracts/ **不是被某次重置清空的**，是 `lib/formal-runtime/infra.js:194-215 cleanTestArtifacts()` 每跑一次测试就清一次（数组含 CONTRACTS_DIR/OUTPUT_DIR/各 agent inbox·outbox，**不含 artifacts**）。⚠️ **memo/F2 提议的"artifacts 在 contracts 里查无此约即候删"必须驳回**——任何一次测试后它会把 100% 产物（含刚落盘的生产包）判为候删 |
| P8 | status 默认 completed + 新鲜度 fail-open | **部分修** | 调用方 `stage-definitions.js:293` 已传 `obs.stageCompletion?.status \|\| "completed"`，按 html 原文再改会覆盖更准的来源。真残留只剩两点：preserve_artifact stage **无 match**（对比 graph_route :308-310 有 `event.success===true`），失败会话照样入包；`execution-observation.js:171 since<=0` fail-open。⚠️ 后者**有专测钉死**（`control-payload-misclassification.test.js:85` 断言 `isPathFreshForSession(f,0)===true`），改 fail-closed 要先确认设计意图 |
| P9 | saveAgentArtifact 静默丢弃/静默失败 | **仍开** | :163 `seen.has(name) continue`、:168-170 空 catch、:157 mkdir 先于 copy、:172 空则 return（→ 零文件零 manifest 空包目录，全库 1 例） |
| P10 | 指针写非原子 | **仍开** | 同 L18 |
| **高1** | provenanceNonce 零写入 | **仍开** | 全库仅 `stage-definitions.js:359-362` 两处**读**点，:359 注释自认 "stays null until SOUL injection"。⚠️ 但"防伪完全失效"高估了：`action-marker-parser.js:200` 结构化 ```action 通道在无 nonce 时是 **fail-CLOSED**，:155/:191 引用块跳过，:151-153 非 action 围栏不透明。裸奔的只有"未引用、未入围栏的正文行内 [ACTION]" |
| **高2** | contractPathsById 无共享路径守卫 | **仍开（存疑级）** | `contract-store.js:29-37 isSharedContractPath` 定义完整但唯一使用点是 :154 的**列举过滤器**，索引写入 :55-57 对任意路径无条件执行。中毒读取点先验都没点全：`removeInboxContractIfExists` **自身第一行** `inbox-handlers.js:60` 就是 `preferCache:false` 读，:61-63 direct_request 分支 return 不 evict → 污染读+不清理的完整序列。危害端 `outbox-handlers.js:20 readContractSnapshotById(id)` 不传 hint。**仍判存疑**：`inbox-handlers.js:98` 缓存的是**未投影全量对象**，常态读仍带 output；v133 有静态误判前科 |
| **高3** | collectOutbox 三条静默 | **仍开** | 同 P2 |
| 附 | review 腿 role-fallback 断链 | **证伪** | `collaboration-policy.js:139-162` 的 `hasDirectedEdge` 硬闸在 staging **之前**，无边直接 INVALID_STATE + 广播 GRAPH_COLLABORATION_BLOCKED，合约不建、包不存在。当时的评审 lane 语义测试 `review-lane-semantics.test.js:285-341`(已随 v225 评审链退役删除)把这条语义钉死 |
| 附 | staged 包 manifest 身份错误 | **仍开，但危害应降级** | `artifacts/DIRECT-1785134198487-c946d0/worker/manifest.json` 的 contractId 写着源约 `TC-1785134137963-ad5789`（盘证）。但 `producer` 字段是对的，且**全库无代码读 manifest.contractId**（`agent-session-transcript.js:66` 只取 primary/producer/producedAt/summary），`artifactDir(cid)` 在 lib/ 下零消费方。是溯源脏，不是消费方拿错 |
| 附 | 判决①"固定管线语义齐全" | **应下调** | `artifact-store.js:233/:245/:253` 三态（本腿无上游 / 上游未产出 / 包存在但空）在下游 inbox 完全同相，且 :86 `failures.length===0 return` 使三条都不落 _MISSING.md。memo 自己的 P6 建议①与判决①互相打脸。正确表述："搬运机制齐全，缺料语义不齐全" |

---

## 3. 本次新发现（仅两份先验都没有、且经复核确证的）

### N1 · 证据账本按 sessionKey 跨合约共用，且读取全程不按 contractId 过滤 —— 已越界进执行面【最高优先】

**坏在哪**：`sessionTraceFile(sessionKey)`（`session-trace-store.js:32-36`）只按 sessionKey 分文件，一个 session 跨合约被复用时，多份合约的事件**追加进同一本账**。而两个读取方都整文件读、只按 kind 过滤：

- `session-trace-reader.js:11-37 readSessionCollabFacts` — 只 `filter(kind===COLLAB)`，**每条记录都带 contractId 却不用**
- `session-examiner.js:35-53 collectWriteEvents/collectCollabFacts` — 同样不过滤

**盘面**：`control-plane/trace/` 74 个账本里 **10 个含 2 个以上 contractId**。实例 `agent_planner_contract_tc-1785147248776-fcc003-72e46d67.jsonl` 逐行是：
```
seq0 session_open   TC-...fcc003
seq2 collab request_review ok  TC-...fcc003   ← 受理凭证
seq3 internal write ok outbox/review_receipt.md
seq4 session_close
seq5 session_open   DIRECT-1785147292465-920cce   ← 换了合约，同一本账
seq7 session_close
```

**失败场景**（三条，前两条在执行面）：
1. `stage-definitions.js:393 filterMarkersAgainstTraceFacts` → 第二个合约里 planner 真的写了 `[ACTION] request_review→reviewer1`，因为**上一个合约**已有同 (intent,target) 的 accepted 事实，本轮标记被静默丢弃，日志还写 "already executed via collab FC"。**无任何缓解**。
2. `stage-definitions.js:378 synthesizeTraceSystemActionResults` → 上一合约的受理凭证被合成进本合约 `systemActionResults`，`selectPrimarySystemActionResult`（ledger.js:39-45）优先取 deferred/首个有 status 的 → 本合约主结果 = 上一合约的动作。缓解：`trace-merge.js:28-38` 会按票据现状把已 resolved 的 deferred 翻回 false，所以"终态被推成 COMPLETED-deferred"多数被挡住，但条目仍进账。
3. 考官为合约 B 出具合约 A 的产物/动作证人（今天因期望恒空未兑现，见 N2）。

**修法**：三处读取各加一行 `record.contractId === contractId` 过滤（数据已在，零结构改动）。**静态可改，~30 分钟**。

### N2 · P6 转正无条件让"恒为空期望"的考官判决压过真实 reviewerResult【高】

**坏在哪**：`automation-finalize.js:131` `const evaluationSource = examinerVerdict ? {...} : (reviewerResult ? {...} : null)` —— 考官判决**只要存在就赢**。而 `buildHopExpectations()`（`contract-expectations.js:95-97`）恒返回 null，动态腿也基本不带 expectations（盘面 4/4 assign 子约 `expectations=null`），于是 `session-examiner.js:223-224` 的零期望兜底恒返回 `verdict:"fulfilled", expectationChecks:[]` → `EXAMINER_EVAL_VERDICTS` 映射成 **`verdict:"pass"`、`testsPassed:true`**。

**失败场景**：reviewer 给出 `verdict:"fail"`，但本轮 trace 完整 → 考官 fulfilled → EvaluationResult 变 pass → `automation-decision.js:221` 的 `verdict==="fail"` 分支（reviewer_fail_retry / reviewer_fail abandon）**永不触发**，automation 按"通过"收尾。缓解只有一条：`:137` continueHint 回落 reviewerResult，若 reviewer 写了 `rework` 仍会救回（:212）。

**修法**：`examinerVerdict.expectationChecks.length === 0` 时不得转正为 primary，或让考官零期望返回 `not_provable`（映射 inconclusive）而非 fulfilled。**静态可改，~1 小时**（要动一条被注释声明为 spec §7 语义的分支，改前值得先确认设计意图）。

### N3 · open 哨兵只在 before-agent-start 写，主会话 agent 的账本永久 incomplete【中高】

**坏在哪**：`openSessionTrace` 全库唯一调用点是 `hooks/before-agent-start.js:242`；`closeSessionTrace` 唯一在 `stage-definitions.js:69`。而 `evidence-bridge` 的 record* 是无条件追加的。

**盘面**：74 个账本里 **6 个 open=0 且 close=0**，恰好是主会话 agent（`agent_agent-for-kksl_main` 37 行、`agent_controller_main` 22 行、`agent_operator_main` 6 行、`agent_viz-master_main` 17 行）+ 2 个 DIRECT 会话。

**失败场景**：`validateSessionTraceContent:123` "missing open sentinel" → 考官恒 `not_provable`（`session-examiner.js:208`）；`readSessionCollabFacts:23-25` 直接 `return []` → **B5 两源合流对这些 agent 永久关闭**，L1 工具中场执行的协作动作不入 systemActionResults，重复派工保护（`filterMarkersAgainstTraceFacts`）也随之失效。有讽刺意味的是这也顺带屏蔽了 N1 在这些 agent 上的污染。

**修法**：resume/复用路径补写 open 哨兵，或在 reader 侧改为"首条非 open 时按缺 open 降级但仍解析"。**静态可改，~1 小时**；需要确认 before_agent_start 的哪些分支被跳过（见第 8 节）。

### N4 · 锚定 ALLCAPS 控制文本模式无长度下限，17 字节合法交付物被判 FAILED；同轮产物账本却写 completed【中】

**证据**：`artifacts/DIRECT-1785143648262-5400ef/worker/` 里 `assign_result.txt` 内容 = `CHILD_ASSIGNEE_OK`（18 字节），`manifest.json` 的 `status:"completed"`；同一合约 `workflow-trace/.../inbox/contract.json` 的 `terminalOutcome.reason = "contract.output invalid_semantic_payload:control_text"`、`status:"failed"`。命中的是 `runtime-user-facing-output.js:6` 的锚定模式 `/^[A-Z][A-Z0-9_:-]{2,}$/`（锚定组不受 200 字闸保护，这是 H2 修复刻意保留的语义）。

**失败场景**：任何以短 ALLCAPS token 作交付物的合约（状态码、枚举值、`OK`/`PASS` 型结论）恒判 FAILED。更值得记的是**产物账本与合约终态各说各话且无对账**——manifest 说 completed，合约说 failed，没有任何检查会发现这个矛盾。

**修法**：给锚定 ALLCAPS 模式加"整文件仅此一行且无其它内容"的额外约束，或在 preserve 阶段把 manifest.status 与 terminalOutcome 对账并 warn。**静态可改，~1 小时**。

### N5 · control-plane/output 是扁平共享可变命名空间，且它正是打包数据源 —— 一条绕过 H4 的跨合约内容替换通道【中】

**坏在哪**：`outbox-helpers.js:159` `const dest = join(OUTPUT_DIR, fileName)` —— fileName 是 **agent 自选裸 basename**，无 cid 前缀、无冲突检测、无条件覆盖；:162 把这个共享路径推进 artifactPaths，`stage-definitions.js:288-295` 的 saveAgentArtifact 随后从它 copy 进 `artifacts/<cid>/<producer>/`。

**盘面证据（碰撞面已被反复行使）**：三个不同合约各产出过一个叫 `brief.md` 的交付物、内容互异（`TC-1785090800705-3c6338/planner` md5 d5c991fb 999B、`TC-1785133067220-2873cb/planner` 66a91113 1699B、`TC-1785181390382-299b50/planner` 4b449b54 1750B），三者全部途经同一个 `control-plane/output/brief.md`。output/ 现存 67 个文件里 `answer.md`/`answer.txt`/`artifact.txt`/`brief.md` 等通用名密集。

**失败场景**：两个 agent 并发 agent_end 且 basename 相同 → 后者覆盖 → 前者的 artifacts 包装进别人的内容，产出与 18 个历史幽灵**同形态**的包。**H4 管不到这条路**（H4 只守 contract.output 回退，而 contract.output 是 cid 限定的 `<id>.md`，反倒是安全的那条）。今天靠 agent_end 串行躲过。

**修法**：OUTPUT_DIR 按 cid 分桶，或 dest 加 cid 前缀。**静态可改，~2 小时**（要同步改 artifactPaths 消费方与 P4）。

### N6 · 零标记 approve 的协议自相矛盾：任务文本与提取器互相打脸【中，review 腿专属】

**证据**：平台发给 reviewer 的任务文本 `system-action-request-review.js:177` 白纸黑字"**零阻塞问题即视为通过**"；而提取侧 `stage-definitions.js:192` 是 `if (findings.length > 0)` 才派生 reviewerResult，紧跟着 `:209-211` 的注释**明确反对**这条协议（"live 实测 reviewer 会用散文写拒绝，把无标记当通过会造 false-approve"）。

**失败场景**：reviewer 认可产物、按任务文本写了零标记结论 → 无 reviewerResult → `review-verdict.js:116-121` 退化为普通投递 → `contract.reviewVerdict` 从不落约 → automation gate 与 evaluation 看不见这次"通过"。**只有 reject 会被机器识别，approve 系统性丢失**。

**修法**：把 :177 改成"通过也必须写一条标记"，二选一，别让两处继续各说各话。**静态可改，~15 分钟**。

### N7 · 临时 loop 工作区永不回收，24 个残留 inbox/contract.json 是索引中毒的常驻燃料【低中】

**盘面**：81 个工作区里 **66 个是 loop-* 单轮探针 agent**（07-27~28 时间戳），**24 个仍残留 inbox/contract.json**，其 cid 在 contracts/ 已无正本（被 cleanTestArtifacts 清掉）。代码侧零回收（`rm(agentWorkspace|cleanupWorkspace` 全库零命中）。

**失败场景**：任何 `preferCache:false` 读命中它们（`inbox-handlers.js:60` / `runtime-direct-envelope-queue.js:47`）→ `contract-store.js:55-57` 把 cid→inbox 路径**永久**钉进索引，而 `:145-146` 的共享路径兜底只在 knownPath 为 null 时可达 → 该 cid 此后永远读到被剥离的投影。这让"高2"的危害从条件性变成常驻。

**修法**：loop 轮次结束回收 ephemeral 工作区，与 P7 保留期合并。**静态可改，~2 小时**。

---

## 4. 盘面实况（是否正常运行）

我用与文件名无关的**全量内容 md5** 独立重算（不沿用 7/27 的 `<cid>.md` 命名法签名，那个判据在近期 era 已失明）：

| 指标 | 数值 | 判读 |
|---|---|---|
| artifacts cid 总数 / 体积 | 4668 / 43M | 其中约 1892（40%）是 TC-PROTOCOL-*/TC-LOOP-ROUTE 探针 cid |
| 多 producer 合约 | 802 | — |
| 跨 producer 同内容组 | 743 | 其中 **725 组首 40 字节含 `# synthetic stage output`** = formal-runtime 循环探针，按构造相同，假阳性 |
| **真幽灵包** | **18，与 7/27 完全一致，零新增** | 全部落在 **2026-05-31 17:16 ~ 06-01 04:39**，三种配对（worker/worker2、worker-e/reviewer1、researcher1/reviewer1）。**06-02 起为 0** |
| 07-27 之后新增合约 / 其中多 producer | 182 / 64 | 拆开看：38 个合成 loop 探针（25B/57B 罐头文案，两 producer 同内容属设计内）+ 真实 agent 两跳 18 个 |
| dir≠manifest 漂移（M3） | 4 例 | 全部 2026-06-01 12:12~13:04 老数据 |
| 零文件零 manifest 空包目录（P9） | **全库 1 个** | `DIRECT-1785139312146-e61ca0/worker`，07-27 16:01，**早于 fede51d(17:53) 约 2 小时** = 修前遗留 |
| 工作区 upstream/ 残留 | **0**（81 个工作区全扫） | H1 的污染现场已彻底清空 |
| outbox 文件 | **0**（4 个 outbox 目录全空） | M2 机制完好但此刻未触发 |
| contracts/ | **0 个**，mtime 08-05 01:53 | 每跑一次 test-runner 被 `infra.js:194-215 cleanTestArtifacts` 清一次；**不是重置事故** |
| control-plane/output | 67 个扁平裸名文件 | 见 N5 |
| 残留 inbox/contract.json | 24 | 见 N7 |

**趋势判读**：真实产物流量止于 **07-28 03:44**；07-28 之后到 08-05 只有单 producer 的 TC-PROTOCOL-*/TC-LOOP-ROUTE 健康探针（08-05 01:53 跑过一次）。所以"修后零新增幽灵"这条结论的**样本是 18 个真实两跳合约、一天窗口，且零个跑过 worker-e→reviewer1 / researcher1→reviewer1 这个恰恰产生了全部 18 个原始幽灵的三跳拓扑**——请不要在文档里写成"H4 已被盘面充分验证"。抽查 `TC-1785181390382-299b50`：planner/brief.md 与 worker/testing-principles.md 内容互异、下游包不含上游主产物，是干净交接该有的形状。

**一句话**：正常运行，且比 7/27 干净得多（污染现场清零、幽灵零新增）；但近一周没有真实多跳流量，"干净"里有一部分是"没跑"。

---

## 5. 动态腿判决

### assign_task —— **接线漏了，不是设计否决**

三条硬证据：(a) 评审腿有现成同款配方 `stageReviewUpstreamPackage`；(b) 图边 planner→worker 由 `collaboration-policy.js:140` 强制存在，包一按子 cid 物化 `copyUpstreamArtifactsToInbox` 立即生效；(c) 通用消费指令 `role-spec-registry.js:17` 早就写好，去程修复**零提示词改动**。spec §5 只把 assign 回流定义为"deferred 票据回流"，从未写"不带产物"——是规格缺口。

- **去程零包**：`system-action-runtime.js:250-277` 建约后直接 enqueue，一次 staging 都没有；父包在 `artifacts/<父cid>/<父>/` 而子约是全新 DIRECT id，`artifact-store.js:245 existsSync` 必然落空。
- ⚠️ **但盘面证不了这条机制**：4 个 assign 子约的**父包一个都不存在**（探针提示词 `system-action-chain.js:56-62` 免除了简报/runtime_result，且 L1 中场调用早于 preserve_artifact）。cid 换代只在 **L3 marker assign** 上才是绑定约束，而 `SYSTEM_ACTION_CASES` **没有 l3-marker-assign 用例** → 该机制**至今零次被观测**。修之前应先补探针。
- **回程**：`delivery-result.js:218` `summarizeDeliveryResult(text, limit=1200)`，:321/:337 两分支都用默认值；`readRuntimeResultContent:185-193` 只读**一个**文件。**但"父方零感知"是错的**——`delivery-system-action-runtime-result.js:224` 把子约整份 executionObservation（含完整 artifactPaths[]）挂上回投合约，且 DIRECT 信封写盘**不过** `TASK_FACING_INBOX_ALLOW_KEYS` 投影（`runtime-direct-envelope-queue.js:249` 整体 JSON.stringify → :162 rename 成 inbox/contract.json）。准确表述是"**路径在线上但无人指路**"：任务文本不提、是子约工作区绝对路径（与 SOUL"只用相对路径"冲突）、planner 角色没被告知去读（`role-spec-registry.js:9-14` 的 PLANNER 集缺 upstreamPackages 读取句）。
- **回程还有图约束**：`resolveUpstreamAgents` 只遍历入边（`artifact-store.js:200-209`），图上无 worker→planner，照抄评审腿配方会得到"包物化了但下游读不到"的**静默假修复**（copyUpstream 走 :245 continue，无日志）。
- **范围提醒**：`delivery-system-action-runtime-result.js:80` 的 `execution` variant 与 assign variant **共用同一 handler**，create_task/嵌套执行回程有一模一样的病。别只修一半。
- **回投工单第一句与真值相反**：`:133` `header: 受托 agent ${agentId} 已完成 ${desc}。` 是无条件字符串，盘面 4/4 工单开头是"受托 agent worker 已完成 assign_task 子任务。\n子任务失败。…状态: failed"。一行修法：header 按 terminalStatus 分支。
- 盘面 4 个 assign 子约全 failed，但**成因是探针设计**（3 个 `collected:false` 压根没产出，1 个产出 `CHILD_ASSIGNEE_OK` 撞 N4），不是交接 bug——先验里"完成门锚在受托方从未写的路径"的说法我不采信。

### request_review —— **搬运骨架健康，缺口在选人 / 可读性 / 缺料标记**

- **健康的**：没有造第二条搬运协议（staging 只落包，入仓仍由 `copyUpstreamArtifactsToInbox` 沿图入边完成，B8 预算/COMPRESSED_MANIFEST/_MISSING 全套照常生效）；图授权闸门无旁路且有测试钉死；`fede51d` 的 preserved∪manifest 并集是真修复（盘证：`DIRECT-1785145407509-51be4c/planner` 修前只有 preserved 的 review_request.md、缺 [ACTION] 显式声明且当时确实存在的 .js；两次 post-fix 探针 reviewer 正常给出 [BLOCKING]）。
- **缺口 1（真 bug 但今天不可达）**：`hasReviewCapability` 只认 `skills.includes("review-findings")`，而 reviewer1 的 binding `skills.configured=[]`（preset 的 skills 走 capabilities 另一通道）→ `:114 graphTargets.find(hasReviewCapability)` 恒 undefined，永远落到全局 role fallback `[0]`。单 reviewer 拓扑下行为与正确实现一致；多 reviewer 时会无谓拒绝。
- **缺口 2（当下最痛）**：任务文本 `:174` 承诺"未入仓则按上列路径读取"，但 reviewer 读白名单只有 `[inbox, contract.output, previousArtifact, workingDir]`（`before-tool-call.js:325-338`，且 DIRECT 信封不设 workingDir）→ manifest 的源侧绝对路径**结构性不可能**命中。Live 铁证：`artifacts/DIRECT-1785134198487-c946d0/reviewer1/*.md:9-11` 逐条记录了"读 manifest 路径被拒 → 猜 inbox 文件名全 ENOENT → 交 BLOCKED 白卷"。**且成功路径同样没人指路**——平台算得出 `inbox/upstream/<producer>/<basename>` 却从不写进任务文本；两次成功探针纯属 basename 恰好猜对。顺带：绝对主机路径进任务文本违反"只用相对路径"硬规则。
- **缺口 3**：`collectReviewArtifacts:61-85` 全程无 fs 检查，把未物化的 contract.output 当评审对象登记并打印（盘证 `control-plane/output/TC-1785134137963-ad5789.md` 从不存在）；当时的 `review-lane-semantics.test.js:220-269`(已随 v225 评审链退役删除)甚至**用测试钉死了"幽灵路径照样开约"**。
- **缺口 4**：staging 失败/空包时全链零标记（`:137` 无条件 mkdir 留下空目录 → `_MISSING.md` 判据是"报错"而非"该有却没有" → 静默）；`reviewContext.staging.staged` **全库零消费方**且 catch 会丢弃已累积的 stagedFrom（假阴性）。

---

## 6. 证据面 × 交接

**健康（这部分工程质量确实高）**：per-session 追加队列串行化（`session-trace-store.js:21-26`，注释记录了 duplicate-seq 是 live 抓到的）；哈希链 + 双哨兵的结构自证；`not_provable` 永不冤判（`session-examiner.js:86-88` 盘上哈希不匹配也只降级不判违约）；摘要器零原文泄露；bridge 层每个导出自吞失败（"证据面严格弱于执行面"这条不变量被真正贯彻）。`E-CONTRACT-006` 注册表把"为什么 producer 侧 artifacts 不算证据"写进错误码本身，是全系统最好的一条自证。

**有风险**：N1（跨合约共账本已污染执行面的 B5 合流与标记去重）、N2（转正层让空期望覆盖真实评审）。这两条是"新平面接进老链路时接错了口"，不是平面本身的设计问题。

**半接线**：`buildHopExpectations()` 恒 null（有意的空实现，挂点注释写清了）→ 固定管线每跳零期望，考官只做产物兜底；review 腿建约完全不传 expectations（`system-action-request-review.js:239-249`），`session-examiner.js:204-205` 恒空 → **考官对"reviewer 是否真读了被审产物"这个最需要判据的场景失明**，而这恰恰是缺口 2 那类静默失败的天然机器判据。`control-plane/evaluation-verdicts.json` 现有记录全是 TC-* 固定管线约、`expectationChecks: []`，无 DIRECT 样本。N3 让 4 个主会话 agent 干脆不进这个平面。

---

## 7. 修复建议（合并排序，一张表）

| # | 项 | 类型 | 成本 | 说明 |
|---|---|---|---|---|
| **1** | **N1 三处读取按 contractId 过滤** | 静态可改 | ~30min | **最高性价比**：数据已在记录里，三行判断，直接消掉一条已越界进执行面的污染通道 |
| **2** | **M2 早退路径的陈旧闸 + 事务化** | 静态可改 | ~3h | **唯一能绕过全部新鲜度门的内容级错发通道**。优先加 :249 的 mtime/合约归属闸（比事务化更急）；parse 失败的 runtime_result 改名 `.invalid-<ts>.json` 移出采集视野；全部 copy 成功后再统一 unlink |
| **3** | **L17 两个站点一起修** | 静态可改 | ~20min | 成本近零、是所有判定门的**定位放大器**。H3 的门现在产出信息量很高的 summary（`agent-end-graph-route.js:209/218/227`），一条都到不了人面。⚠️ 必须同时改 `delivery-terminal.js:55` |
| 4 | N2 空 expectationChecks 不得转正 | 静态可改 | ~1h | 改前确认 spec §7 语义意图 |
| 5 | contractPathsById 一行守卫（`contract-store.js:55-57` 加 `&& isSharedContractPath(...)`） | 静态可改（验证需 live） | ~10min | 零回归：路径缓存照旧全量，只收窄 id→path 索引，:145-146 兜底自然接管。**无论定案与否都该上** |
| 6 | review 任务文本改写 inbox 侧相对路径（缺口 2） | 静态可改 | ~1h | 顺带删掉不可执行的兜底句、消掉绝对路径违规 |
| 7 | N6 零标记 approve 协议统一 | 静态可改 | ~15min | 二选一，别让任务文本与提取器继续各说各话 |
| 8 | P2/collectOutbox 五条静默各加 warn + 让 `executionObservation.error` 有消费方 | 静态可改 | ~1h | 是诊断其余一切的前提 |
| 9 | assign 去程：抽共享 `stageProducerPackageForContract`（含改写 manifest.contractId，一处修两腿） | 静态可改 | ~4h | **但先补 l3-marker-assign 探针**，否则修完在 L1 主路径上是 no-op |
| 10 | assign 回程：staging + producer 集合改「图入边 ∪ 合约声明」 + task 文本补 inbox 路径 + header 按 status 分支 | 静态可改 | ~5h | 注意同时覆盖 `execution` variant |
| 11 | N3 resume 路径补 open 哨兵 | 静态可改 | ~1h | 需先确认哪些分支跳过（见第 8 节） |
| 12 | H4' 深度：`:269` 改读 `primaryOutputPathSource`，**同时**按溯源过滤 artifactPaths（否则 :283-286 前置条件不成立照样打包），加一条不变量测试 | 静态可改 | ~2h | 今天正确，修的是回归风险 |
| 13 | N5 OUTPUT_DIR 按 cid 分桶 | 静态可改 | ~2h | 连带解 P4 |
| 14 | copyUpstream 三态区分 + 空包计入 failures | 静态可改 | ~2h | 把判决①从"语义齐全"补齐 |
| 15 | L18/P10 指针改 atomicWriteFile + cacheContractSnapshot | 静态可改 | ~30min | 现在 M4 的探测依赖这个指针 |
| 16 | M3 留存前清包目录 / 按 round 分子目录 | 静态可改 | ~2h | 顺带让 manifest 从零消费方变成有消费方 |
| 17 | N7 loop 工作区回收 + P7 保留期（**按 mtime + 合成前缀白名单，绝不能用 contracts/ 做存活判据**） | 静态可改 | ~3h | — |
| 18 | provenanceNonce / requireDefaultOutputArtifact / retryable 三处"留了一半"：补齐或删除 | 静态可改 | ~2h | retryable 若保留应改名 manualRetryHint |
| 19 | L2 saveAgentArtifact 加 logger（**不改吞错语义**） | 静态可改 | ~30min | — |
| 20 | reviewer 选人 skill ∪ role 双判据 + 清掉自相矛盾注释 | 静态可改 | ~1h | 今天不可达，属卫生 |

**最有价值的三条：#1（N1 contractId 过滤）、#2（M2 陈旧闸）、#3（L17 两站点）** —— 分别对应"已经在污染执行面的最新缺陷"、"唯一能绕过所有已建防线的老缺陷"、"让未来所有缺陷可被看见的放大器"，且三条加起来不到一天工。

---

## 8. 仍需 live 才能定案的

| 项 | 精确观测（均不需重启网关） |
|---|---|
| **contractPathsById 中毒是否真复发 v133** | 在 `runtime-mailbox-outbox-handlers.js:20` 前后各打一行日志，同时打印 `contractPathsById.get(id)` 解析到的路径与 `shared?.output`；跑「worker 执行期间对同一 worker 发 direct_request」。判据：解析路径为 `workspaces/<agent>/inbox/contract.json` 且 `shared.output===undefined` → 确证 |
| **M2 残件生成频率** | 观察一次「agent 写了产物 md 但未写 runtime_result.json」的真实会话：看 outbox 是否留件、`collectOutbox` 是否零日志、下一次该 agent 交付时 primary 是否被上一轮文件占据 |
| **N1 的执行面后果是否真兑现** | 找一个 sessionKey 跨两合约的会话，让第二个合约的 agent 发同 (intent,target) 的 `[ACTION]`；判据：日志出现 `[agent-end] 1 [ACTION] marker(s) skipped — already executed via collab FC` 而本轮实际没派工 |
| **N3 哪些分支跳过 open 哨兵** | 在 `before-agent-start.js:242` 前打日志记录 sessionKey 与进入路径，跑一次 controller/operator 的常规唤醒；判据：账本首条不是 session_open |
| **H4 在出事拓扑上的效力** | 跑一条真实（非合成）三跳 worker-e→reviewer1 或 researcher1→reviewer1；判据：下游包不含上游主产物且 md5 不同 |
| **N2 是否真覆盖 reviewer 的 fail** | 跑一轮 reviewer 给 `[BLOCKING]` 的 automation loop；判据：`evaluation-verdicts.json` 该轮 verdict=fulfilled 且 `automation-decision` 的 reason 不是 `reviewer_fail*` |

---

### 附：两份先验文档中与现实不符、应当作废的判断

1. 7/27 静态审计的 **H2/H3/H4/M1/M4/L1/L19 七条全部已修**，该文档成文于修复提交前 1 小时，整体已过期。
2. 18 个幽灵包**不是持续产生**，是 05-31~06-01 一次性历史残留，且 H4 门比它们晚 8 周——H4 是正确的事后防御，不是当时的解药。两份文档都把它们挂在 H4 名下。
3. 备忘录129 **与 HEAD 同代码**（零 .js diff），"这 8 天顺带修了哪些"的答案是零；真正陈旧的是 7/27 那份。
4. memo129/F2 的 "平台从不清 outbox" 与 "contracts/ 被某次重置清空、artifacts 全是孤儿可候删" 两条**都错**，后者的处置建议有破坏性。
5. memo129 的 "review 腿 role-fallback 断链" **证伪**（图边硬闸 + 测试钉死）；"manifest 身份错误导致消费方拿错" **危害高估**（无任何代码读 manifest.contractId）。
6. memo129 判决① "固定管线语义齐全" 应下调为"搬运机制齐全、缺料语义不齐全"，它与自己的 P6 建议①矛盾。
7. F3 facet 报的 "assign 工具面无法表达 expectations" 在**工作树**已修（未提交）；F3-1/F3-2 标注的 "新发现" 实为 memo129 P5/P6 原文。
---

# 附录 · 实证轮(2026-08-05,测试授权后补做,未改任何代码)

## A1 全量单测 2124 / pass 2122 / fail 1

- **`mintId ... 200 mints unique` = 构造性 flaky,非回归**。`nonce=randomBytes(3)`=24bit;固定 now 下 200 次铸造的生日碰撞理论值 0.119%,实测 20000 轮 **0.095%(19/20000)**,约 1053 次跑挂一次。真实合约 ID 碰撞需"同毫秒 + 1/16.7M nonce 相撞",可忽略。**该测试把概率性质当确定性断言,应改判据而非改实现。**
- `a2a tasks/send ... actionable ingress target` 30s 超时(`admin-surface-canonical-api.test.js:293`),网关在线,疑环境;未定案。

## A2 live pipeline 12/12 PASS —— H4 在真实拓扑上确证有效

跑前 4699 cid,本轮新增 17。真实多跳链产物**各自独立**:
- `TC-1785868905160-ef5403`:planner/working_brief.md 3840B(f4963540) ≠ worker/system_health_checklist.md 4894B(62f89566)
- `TC-1785868985154-231b4d`:planner/brief.md 2865B + worker 自产 2 文件(含 7811B)

md5 扫描唯一命中是 `loop-late-*` 合成探针的 57B 罐头文案 `# synthetic stage output`(两 producer 按构造相同)= **假阳性**,与静态轮预判一致。**本轮零真幽灵包。**
`upstream package flowed downstream` 两例 PASS,且 M4 已把该探针修成真判据(cid 定界 + 指针校验),**这块绿灯现在可以当证据用**。

## A3 N1 跨合约共账本 —— live 确证

本轮 17 个新账本,**3 个跨两个 contractId**(18%),形态一致:`agent_planner_contract_tc-XXX.jsonl` 同时含母约 `TC-*` 与其派生 `DIRECT-*`。干净环境当场复现,机制无疑。

## A4 system-action 2 FAIL,根因与先验预判**不同**

- `E-SYSACTION-004` Review verdict delivery(420s 超预算)。**排除 N6**:reviewer 确实写了标记(`DIRECT-1785869179530-f6b9b8` BLOCKING=1;`DIRECT-1785869370223-94e92c` BLOCKING=1+SUGGESTION=1,含"评审结论:reject")。**产物在盘、标记齐全,断点在回程投递**,3 个下游检查连带 BLOCKED。
- `E-SYSACTION-002` 结构化 role-policy 拒绝 alert 未观察到(caller 合约本身正常终态)。

## A5 【新】guard 1b 与 skill 渐进披露冲突 + 证据账本双记

reviewer1 账本 seq1-4 铁证:
```
read ~/.openclaw/skills/platform-map/SKILL.md  → refused
  blockReason: "runtime 语义:contract-backed session 的第一步是读取当前会话自己的 inbox/contract.json"
```
agent 被注入 skill 头后读全文是最自然的第一动作,却被 1b 门拒掉。**本轮 24 次 refused**,遍及 5 个 agent(controller 7 / reviewer1 7 / planner 6 / operator 2 / viz-master 2),其中 4 次是读 skill。

**并且 92%(22/24)被双记**:同一 args 先记 `outcome:refused`(带 blockReason)、紧接着再记 `outcome:error`(同文案)。考官按事件计数判证据完整度,双记会系统性偏斜账本。

**注**:该 blockReason 的前缀正是 `runtime 语义:` —— H2 已修(200 字闸)故不再误杀长文,但这证明该短语在 agent 可见文本里确属高频,H2 的锚定组窄口(N4)仍值得收。
