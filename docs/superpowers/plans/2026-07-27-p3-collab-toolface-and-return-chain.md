# P3 协作工具库 + 回流链修复 · 实施计划(批次二)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec(2026-07-27-unified-fc-evidence-plane-design.md)§10 P3 全量:评审腿 contract 化(修回流链后半段,live 已判断裂)→ systemAction 单槽数组化 → 协作 FC 工具面 v1(3 工具)→ contract.expectations 字段 → B5 终态链读 trace。前置 live 验证已完成(cid TC-1785095975012-ba2e06,判决:前半通/后半双断)。

**Architecture:** 评审腿弃 artifact+hook wake,克隆 assign_task 机械(DIRECT 合约+SADT 票据+exact-session resume);review_verdict 车道改 contractData 匹配。数组化以 markerActions 全量循环替换 `[0]`,终态阶梯语义 = 任一失败→失败分支,任一 deferred→deferred 分支(followUp 取首个 deferred 为主)。工具面走框架 `api.registerTool(factory,{optional:true})`,execute 汇入 systemActionConsume(授权/票据/投递零新协议);证据面对协作工具记 kind:collab+全量 args(单桥分类,不造第二记录路径)。B5 在 consume_system_action 阶段合流:trace 的 collab 事实(已执行,查票据现状,合成 systemActionResults,不重派)+ 文本 [ACTION](未执行,照常派)。

**Tech Stack:** Node ESM · node:test(`--experimental-test-module-mocks`)· 现有 delivery/protocol/evidence 原语全复用。

**纪律:** 每 task 独立 commit(先 `node scripts/openclaw-block-check.js --primary <id>` 过闸);**途中发现的债务一律只记备忘录128"遗留跟进",不修**(用户指令 2026-07-27);他人会话脏文件(skills/error-avoidance/SKILL.md)不入 commit。

---

## 测绘锚点速查(2026-07-27 六路测绘,详单 workflow wf_ffc920ff-6ad)

| 机制 | 锚点 |
|---|---|
| review 现路径(要拆) | system-action-request-review.js:271 写 code_review.json;:276 hook wake;:110 busyCheck 查残留 |
| review_verdict 车道(要改) | delivery-system-action-chain.js:29 match=artifactContext+executionObservation.reviewVerdict;review-verdict.js:163 markResolved+unlink |
| reviewVerdict 唯一生产者 | runtime-mailbox-outbox-helpers.js:323(runtime_result.json,无人被教写) |
| 标记提取早退 | agent-end-stage-definitions.js:135(无 contractId return)→ :178 只写 contract.reviewerResult |
| assign 健康参照 | system-action-runtime.js:163-283;createDirectRequestEnvelope protocol-primitives.js:200-282;票据 delivery-system-action-ticket.js:86-146(真账本 control-plane/system-action-delivery-tickets.json) |
| 回投链 | agent-end-terminal.js:279;runtime-result 候选 delivery-system-action-runtime-result.js:69-75(要求 protocol.source==assign_task);exact-session resume transport.js:419-517 |
| 上游包卡点 | copyUpstreamArtifactsToInbox artifact-store.js:224-321 按 stagedCid+图入边复制 → 新 DIRECT cid 需先落 artifacts/<cid>/<worker>/ |
| 单槽咽喉 | stage-definitions.js:300 markerActions[0];终态阶梯 terminal.js:213-236;唯一写者 buildSystemActionContractFields terminal.js:65-85 |
| 工具注册 | OpenClawPluginApi api.registerTool(factory,{optional,names});factory ctx 含 agentId/sessionKey;alsoAllow 门 pickSandboxToolPolicy |
| expectations 必过闸 | toTrackingContract 允许表 session-tracking-state.js:36-72;TASK_FACING_INBOX_ALLOW_KEYS runtime-mailbox-inbox-handlers.js:26-48 |
| B5 插入点 | consume_system_action stage-definitions.js:286-322;close 哨兵在 lifecycle 之后写(hooks/agent-end.js)→ 读时容忍无 close |

---

### Task T1: 评审腿 contract 化(回流链修复)

**Files:** Modify `lib/system-action/system-action-request-review.js`(主体重写);Modify `lib/routing/delivery/delivery-system-action-chain.js`(车道 match);Modify `lib/routing/delivery/delivery-system-action-review-verdict.js`(候选判定+verdict 派生+清理);Modify `lib/formal-runtime/checks/system-action-chain.js`(live 探针证据源);Tests `tests/request-review-contract-leg.test.js`(新)

**设计定案:**
1. 投递:弃 `atomicWriteFile(code_review.json)`+hook wake → `createDirectRequestEnvelope`(task=评审指令含"评审对象在 inbox/upstream/<worker>/",assignee=reviewer,`protocol.source="request_review"`,output=<reviewerWs>/output/<id>.md)+ 票据挂约(attachSystemActionDeliveryTicket + assignmentContext,同 assign)+ `dispatchSendDirectRequest` 入队(忙时排队,busyCheck 删 code_review.json 残留项)+ wakeSemantic 保留 REQUEST_REVIEW_DISPATCH。
2. 被审产物上车:handler 内把 `control-plane/artifacts/<workerCid>/<worker>/`(worker 的 preserve_artifact 已落;若未落则取 worker outbox 现文件)复制到 `control-plane/artifacts/<reviewCid>/<worker>/` → routeInbox 沿图入边 worker→reviewer 自然搬进 `inbox/upstream/<worker>/`,一条路径原则。**实施时先确认 stage 顺序 preserve_artifact 先于 consume_system_action;若相反,直接从 worker outbox/output 现场打包 saveAgentArtifact。**
3. 车道:REVIEW_VERDICT match 改 contractData 判定 `isReviewVerdictDeliveryCandidate(contractData)`(direct envelope + protocol.source==="request_review" + 票据在 assignmentContext);verdict 来源优先级 `executionObservation.reviewVerdict`(runtime_result.json)> `contract.reviewerResult` 派生(blockingCount>0→reject 否则 approve;合约存在后标记提取不再早退,这条路自然通);回投+markResolved+suppressCompletionEgress 照 assign 款。
4. 拆净:code_review.json 写入/unlink、isRequestReviewArtifactContext 及 artifact-lane code_review 绑定路径中因此死掉的部分,全删不留兼容层(before-agent-start bindInboxArtifactContext 若仍服务其他 lane 则保留通用机制,只删 review 专用分支)。

- [ ] T1-1 读 stage 顺序(agent-end-stage-definitions.js 注册序)定产物上车方案 2 的分支
- [ ] T1-2 失败测试先行:`tests/request-review-contract-leg.test.js`——handler 产出 DIRECT 合约(source=request_review,票据齐,artifacts/<reviewCid>/<worker>/ 有包);车道候选判定新旧两式
- [ ] T1-3 重写 handler + 车道;`node --check` 全过
- [ ] T1-4 定向测试 + 既有回归(system-action 族 + delivery 族)全绿
- [ ] T1-5 live 探针 system-action-chain.js 证据源同步(review-requested 改查 DIRECT 合约与票据,不查 code_review.json)
- [ ] T1-6 block-check(operator-cli-control 与 io-delivery 分 commit)→ 提交

### Task T2: systemAction 单槽数组化

**Files:** Modify `lib/lifecycle/agent-end-stage-definitions.js:300 区`(全量循环);Modify `lib/lifecycle/agent-end-terminal.js:65-85,213-236,279-310`;Modify `lib/system-action/system-action-runtime-ledger.js`;Readers:`lib/session/session-tracking-state.js:69`、`lib/store/tracking-work-item.js:83/120/152/192`、`lib/contract/contract-lifecycle-builders.js:46/163`;Tests 更新 `tests/formal-contract-runtime.test.js`、`tests/unified-control-plane-p0.test.js`、`tests/system-action-context.test.js`、`tests/action-marker-parser.test.js`

**语义定案:** `context.systemActionResults`(数组)为真值;终态阶梯:任一非 deferred 失败→失败分支(取首个失败);否则任一 deferred→deferred 分支;followUp 保持单对象=首个 deferred(lifecycle-view 三处 shape-read 不破),多 deferred 各自票据照发,followUp 记 `additionalDeferredCount`。持久化 `contract.systemAction` = 数组(entry 形状不变);读者全部兼容单对象旧盘(`Array.isArray(x)?x:[x]` 归一读)。逐动作授权:单动作被拒记 refused 结果继续其余,不整批中断。

- [ ] T2-1 失败测试先行(多动作混合结局:1 deferred+1 fail / 2 deferred / 全 ok)
- [ ] T2-2 实施;旧盘合约兼容读归一 helper 一处(放 protocol-primitives 或 ledger,勿散)
- [ ] T2-3 四个既有测试文件断言更新;全量回归
- [ ] T2-4 block-check(local-execution)→ 提交

### Task T3: 协作 FC 工具面 v1(3 工具)

**Files:** Modify `index.js`(register 内 api.registerTool);Create `lib/system-action/collaboration-toolface.js`(工厂+受理凭证);Modify `lib/evidence/evidence-bridge.js` + `lib/evidence/tool-event-digest.js`(collab 分类:kind:collab+args 全量不摘);Tests `tests/collaboration-toolface.test.js`(新)

**定案:** 工厂按 `listExposedToolIntents() ∩ listAllowedActionTypesForRole(getAgentRole(ctx.agentId))` 出工具;execute → `systemActionConsume({agentId,sessionKey,contractData:getTrackingState(sessionKey)?.contract,api,logger,injectedAction:{type,params}})`;tool_result=受理凭证 `{accepted,contractId?,deliveryTicketId?,queuePosition?}` 或结构化拒绝 `{accepted:false,code,reason}`(受理≠执行结果)。证据单桥:bridge 认 COLLAB_TOOL_NAMES(取自 listExposedToolIntents)→ kind:collab、args 全量、receipt 为 result;不造第二条记录路径。注册 `{optional:true}`,不动任何 agent 的 alsoAllow(P4 事)——live 冒烟用临时测试 agent 配置。

- [ ] T3-1 失败测试先行(工厂按角色裁剪;execute 凭证形状;拒绝入账 refused)
- [ ] T3-2 实施 + bridge collab 分类
- [ ] T3-3 回归 + block-check(local-execution / runtime-core 分 commit)→ 提交

### Task T4: contract.expectations 字段(平台专写)

**Files:** Modify `lib/protocol/protocol-primitives.js`(createDirectRequestEnvelope 透传 expectations);Modify `lib/system-action/system-action-runtime.js`(assign_task params.expectations 校验+落约);Modify `lib/session/session-tracking-state.js:36-72` + `lib/routing/mailbox/runtime-mailbox-inbox-handlers.js:26-48`(两张允许表);Tests `tests/contract-expectations.test.js`(新)

**定案:** shape=`{requiredArtifacts:[{path}],expectedActions:[{intent,target,required}]}`;结构非法→受理时结构化拒绝(垃圾期望不入约);执行者永不可写(允许表只进不改的投影,受理校验拒绝 agent 侧自带 expectations 的注入);固定管线每跳重导出本批只留 `buildHopExpectations()` 挂点(图无定义→null→跳过),不造图 schema。渲染零改(contract.json 数据通道已达)。

- [ ] T4-1 失败测试先行(透传/校验拒绝/两张允许表可达/agent 侧注入被剥)
- [ ] T4-2 实施;回归;block-check(runtime-core)→ 提交

### Task T5: B5 终态链读 trace(两源合流)

**Files:** Modify `lib/lifecycle/agent-end-stage-definitions.js`(consume_system_action 前段);Create `lib/evidence/session-trace-reader.js`(容忍无 close 的读取器);Tests `tests/terminal-chain-trace-merge.test.js`(新)

**定案:** 读 `sessionTraceFile(context.sessionKey)`(结构宽验:行可解析+seq 连续+open 在;**无 close 属预期**——close 哨兵在 lifecycle 之后写);filter kind:collab → 已执行动作事实(intent/target/receipt.contractId/ticketId)→ 查真票据账本现状 → **合成 systemActionResults 条目(不重派)**;文本 [ACTION] 照常派,但与 trace 已执行事实同 (intent,target) 的标记跳过(防双派),跳过事件记 log。trace 缺失/不合格 → 完全现行为,永不崩(证据面严格弱于执行面)。

- [ ] T5-1 失败测试先行(合成条目进阶梯/双派去重/trace 坏退化)
- [ ] T5-2 实施;回归;block-check(local-execution + runtime-core 分 commit)→ 提交

### Task T6: 全量回归 + live 验收(P3 收口)

- [ ] T6-1 `npm test` 后台全绿(echo EXIT 纪律)
- [ ] T6-2 health 70/70;kickstart 网关;dispatch preset 8/8
- [ ] T6-3 **live 回流链复验(P3 验收判据)**:正规 test-inject 两腿任务(worker 产出+request_review)→ 断言:review DIRECT 合约生成、reviewer 标准剧本走通(读 upstream、落 markers)、verdict 车道触发、票据 resolved、worker exact-session resume 收到 verdict——2026-07-27 判死的后半段全绿
- [ ] T6-4 备忘录128 §四 + wiki status 更新;push 仪式(新 tag)等用户令

---

## 自查记录

- Spec 覆盖:P3 工具库(T3)+配套数组化(T2)+B5(T5)+前置回流修复(T1)+期望字段字段面(T4,考官消费在 P6)。P4 binding/P5 preset/P6 考官为后批。
- 每 task 均测试先行、独立 commit、block-check 过闸;债务只记不修。
- 最大风险:T1 上游包 stage 顺序分支(T1-1 先证)与 T2 终态阶梯语义(定案已写死,测试锁三种混合结局)。
