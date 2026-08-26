# OpenClaw Watchdog — System Map (系统分层·板块·定址)

> 由多 agent 全代码库映射生成(11 层 · 目录重排审计)。附录 §5 归位清单当前 389 条，**已非全量**——见 §5 卷首时效说明。
> 这是**描述问题的坐标系** + **目录重排的蓝图**。代码与本图冲突时以代码为准,本图须更新。
>
> **维护记录 2026-08-09**:§2/§5 的 190 处文件路径按 v171/v172 重排后的真实位置修正(此前 132 个路径指向已迁走的旧址);§3/§4 标注为重排前快照;图边语义按 v179 更正(边 = 固定管线 + 传送带投递授权,**不含**动态协作授权)。
>
> **维护记录 2026-08-23 (v226)**:**harness 判定账全退役**——`lib/harness/` 整目录删除,
> HarnessRun/EvaluationResult 对象链两环消失,automation 治理链收缩为
> AutomationDecision→ProfileLifecycle。本图中所有 harness 板块条目为历史描述,
> 保留作设计记录(「标准化」思想仍有效)。裁决见备忘录149/150。

## 0. 定址约定 (Problem Addressing)

描述任何问题用四段坐标,从上到下越来越具体:

> **`L{n} 层 · 板块(module) · 功能(function) · 问题`**

- **层 L0–L10** — 问题所在抽象层(§1 表)
- **板块** — 该层内的职责单元(§2)
- **功能** — 具体函数 / 概念
- **问题** — 观察到的现象

示例:
- `L1 通讯 · Graph-router · drainIdleDispatchTargets · 目标闲置未被 drain`
- `L3 执行沙箱 · dispatch跳数守卫 · evaluateDispatchGuard · A→B→A 乒乓未拦`
- `L5 交付 · 上游context注入 · computeContextBudgetPlan · 溢出未压缩`
- `L9 控制面 · operator执行器 · executeCliSystemSurface · 破坏性操作未拍快照`

## 1. 分层总表 (L0 底层 → L10 上层)

| ID | 层 | 拥有什么 | 文件数 |
|----|----|----------|--------|
| **L0** | 内核·运行时 (Kernel / Runtime) | gateway 进程地基：插件装配、hook 事件、全局 state/store 单例、会话追踪、agent_end 阶段编排与崩溃/超时/硬停生命周期、record-plane 记账(`control-plane/records.db` 唯一记账真值,v232) | 52 |
| **L1** | 通讯·传输协议 (Transport / Protocol) | 代码硬路径的传输原语：传送带派工(pipeline 边解下一跳+投递图边校验→FIFO排队→闲时投递→唤醒) + inbox/outbox 邮箱 + replyTo 回传 + SSE 广播 + ingress 外部入口 + system_action 运行时 | 53 |
| **L2** | 协作·编排 (Collaboration / Orchestration) | 谁能和谁协作、以什么拓扑：graph(边=固定管线定义+传送带投递授权，含环检测) + collaboration-intent-policy(动态协作授权单源) + agent-group(空间原语) + contract 状态机与结局判定(单个协作单元生命周期真值) | 22 |
| **L3** | Agent执行·安全沙箱 (Agent-Execution / Security) | 单个 agent 干活时的守卫边界：before/after-tool-call 复合拦截 + 路径/写/输出/工具预算 + per-role 能力预设 + dispatch 跳数守卫 + [ACTION] 解析(注入硬化) | 10 |
| **L4** | 提示词装配 (Prompt-Assembly) | 按六层模型(①框架②工具③skill头④role⑤SOUL⑥wake)组装系统提示词，两条路径分流(直连 vs 派工，sessionKey 判定)，IDENTITY(托管)与 SOUL(用户拥有)解耦 | 25 |
| **L5** | 交付·产物 (Delivery / Artifacts) | 产物如何生成、独立留存、整包流转到下游 inbox/upstream/，上游上下文有界注入与溢出压缩，contract.output 别名规范化，用户可见产出判定 | 5 |
| **L6** | 知识·RAG (Knowledge / RAG) | operator 消费的知识层：wiki-RAG hybrid 检索(向量 cosine+词法 BM25-lite RRF 融合+查询改写) + 多知识库注册表/任意文件 ingestion + recall@k·MRR·faithfulness 评测，0 外部依赖优雅退化 | 11 |
| **L7** | 验证·测试 (Verification / Test) | 如何验证系统正确性：formal-runtime 测试系统(CheckResult+E-码注册表+预设→suite 驱动+CLI，产 failures-first 报告)。harness 塑形判定已退役(v226) | 58 |
| **L8** | 调度·自动化 (Schedule / Automation) | cron/schedule 到点触发 + automation 自治轮次的注册与运行，把任务文本投到目标 agent :main 直连会话；schedule=一次性命令触发，automation=多轮自改善回路(编织决策收敛/治理画像沉淀) | 19 |
| **L9** | 控制面·元层 (Control-plane / Meta-agent) | 元 agent(operator+viz-master)经 cli-system 四表面(inspect/apply/verify/observe)零旁路读写系统结构本身，配 structure-snapshot 原子回滚+表面所有权守卫，回答如何安全改系统表象/结构 | 90 |
| **L10** | 观测·前端 (Observability / UI) | 人如何观测系统：零构建 SPA `extensions/watchdog/ui/`(指挥台 command/透视 inspect/管理 manage 五子页,v233 转正;旧 dashboard 9 页已整删)+routes/ HTTP 面(SPA 壳与静态直发、SSE 推流、只读 inspect 家族、admin-surface POST、reveal-file)，前端零旁路 | 36 |

**跨层关系(不是重复)**:
- system-action 拆两处避免重复：[ACTION] 标记的提取+注入硬化归 L3(agent 执行沙箱)，其运行时 dispatch/consume/ledger/交付链归 L1(transport)——一条意图流跨两层。
- dispatch-depth-guard 只落 L3 一次(纯安全计数器)；它被 L1 graph-router 在单一 dispatch choke point 消费并写回 contract(向下引用)。
- contract-session-prompt-override 主层为 L4(prompt-assembly)；L2 contract-lifecycle 只暴露合约侧绑定接口，不重复计。
- routeInbox/collectOutbox 主层为 L1(mailbox transport)；L5 交付层只在 routeInbox 尾部加 upstreamPackages 指针接线。core/markdown-sections 与 normalize 是 L0 底座，被 L6 知识切分等全层复用。
- 上行 meta 引用(不是重复):L6 知识 grounding 被 L9 operator 消费；L8 automation 治理经 L9 admin-surface apply 守卫通道调 resolveGovernance/熔断，——均记为跨层关系而非重复模块（L7 harness 证据消费已随 harness 退役消失，v226）。
- 零旁路收口:所有观测读经 L9 cli-system inspect 表面，所有写经 L9 apply/verify+admin-surface，前端(L10)只经 routes HTTP 面读写,不直读 store 或改真值。

## 2. 逐层 · 板块 · 功能

### L0 内核·运行时 (Kernel / Runtime)
_gateway 进程地基：插件装配、hook 事件、全局 state/store 单例、会话追踪、agent_end 阶段编排与崩溃/超时/硬停生命周期_

- **插件入口与网关引导** — 唯一插件入口 register() 装配 hooks/routes，gateway_start 做启动恢复+调度重建+周期维护
  - 功能: `plugin.register` `gateway_start handler` `loadAgentCards` `maintainDispatchQueue` `pruneStaleCollections`
  - 文件: `index.js` `lib/state/state-persistence.js`
- **Hook 事件系统** — 5 个 gateway hook：入口绑定/提示词覆盖/工具拦截/工具观测/agent_end 薄壳
  - 功能: `before_agent_start ingress` `before_prompt_build override` `before_tool_call block` `agent_end→runAgentEndLifecycle`
  - 文件: `hooks/before-agent-start.js` `hooks/agent-end.js`
- **全局 state 门面与常量** — 进程级共享单例 tracker/cfg/apiRef + 重试超时常量 + 原子写与跨进程锁 + state 持久化
  - 功能: `cfg` `tracker Map` `withLock` `atomicWriteFile` `loadState/persistState`
  - 文件: `lib/state.js` `lib/state/state-collections.js` `lib/state/state-constants.js`
- **内存 Store 层** — 按职责拆分的内存存储：会话追踪表/合约快照缓存/派工链/执行轨迹
  - 功能: `getTrackingState/rememberTrackingState` `readCachedContractSnapshotById` `rememberDispatchChainOrigin` `initTrace/evaluateTrace`
  - 文件: `lib/store/tracker-store.js` `lib/store/contract-store.js` `lib/store/execution-trace-store.js`
- **记录面 (record plane · 记账真值)** — v232 终态：`control-plane/records.db`(SQLite WAL)是唯一记账真值，单宽表 kind=run_event|trace_event，gseq≡id 全局序，因果边+锚点落库；失败纪律 run_event 写失败无降级外抛 / trace_event 容错入 record_rejected；体检 `scripts/record-reconcile.js`(exit 0/1/2)、查账 `scripts/run-inspect.js <id>`
  - 功能: `writeRunEvents/writeTraceEvent` `tryReadRunEventsFromDb/tryReadTraceEventsFromDb` `getGlobalRange` `validateCausality` `openDatabase/resolveRecordDbPath`
  - 文件: `lib/record-plane/database.js` `lib/record-plane/record-writer.js` `lib/record-plane/record-reader.js` `lib/record-plane/validate-causality.js` `lib/record-plane/schema.sql`
- **会话追踪与会话键** — 创建 TrackingState、会话键编解码、把 inbox 信封绑定为会话合约
  - 功能: `createTrackingState` `buildAgentContractSessionKey/parse` `bindInboxContractEnvelope` `bindInboxArtifactContext`
  - 文件: `lib/session/session-tracking-state.js` `lib/session/session-keys.js`
- **Core 运行时原语** — 状态枚举/事件类型/字符串合约归一/markdown 分块——被全层引用的底座
  - 功能: `CONTRACT_STATUS/TRACKING_STATUS` `isTerminalContractStatus` `EVENT_TYPE` `normalizeContractIdentity` `splitMarkdownSections/stripMarkdownNoise`
  - 文件: `lib/core/runtime-status.js` `lib/core/event-types.js` `lib/core/markdown-sections.js`
- **Runtime 信号·故障·硬停** — 心跳门真值源(pending-signal registry)、运行时故障判定、执行事故台账、硬停终结
  - 功能: `registerPendingSignal/hasPendingSignal` `evaluateRuntimeFault` `upsertExecutionIncident` `terminalizeHardStoppedRuntimeSession`
  - 文件: `lib/runtime/pending-signal-registry.js` `lib/runtime/runtime-fault-evaluator.js` `lib/runtime/hard-stop-terminalize.js`
- **agent_end 阶段编排** — 13 主阶段+finally 跑道：加载合约→采集→抽产物→图路由 handoff→系统动作→成功终结
  - 功能: `runAgentEndLifecycle` `AGENT_END_MAIN_STAGES/FINALLY_STAGES` `runAgentEndGraphRoute` `resolveIncompleteHandoffGate` `handleSuccessfulTrackingCompletion`
  - 文件: `lib/lifecycle/agent-end/lifecycle.js` `lib/lifecycle/agent-end/stage-definitions.js` `lib/lifecycle/agent-end/graph-route.js`
- **崩溃恢复·超时·终结·归档** — 失败重试与孤儿合约恢复、per-agent 硬超时扫描、统一会话 finalize、会话目录归档
  - 功能: `handleCrashRecovery` `recoverOrphanedContracts` `sweepRunningTrackers/getAgentTimeoutMs` `finalizeAgentSession` `archiveAgentSession`
  - 文件: `lib/lifecycle/crash-recovery.js` `lib/lifecycle/agent-timeout-sweep.js` `lib/lifecycle/run-tree-archive.js` `lib/lifecycle/legacy-archive-purge.js`
  - ⚠ 2026-08-19：`session-archive.js` 已不存在（归档面被 run-tree/legacy-purge 取代），`archiveAgentSession` 一名待复核

### L1 通讯·传输协议 (Transport / Protocol)
_代码硬路径的传输原语：传送带派工(pipeline 边解下一跳+投递图边校验→FIFO排队→闲时投递→唤醒) + inbox/outbox 邮箱 + replyTo 回传 + SSE 广播 + ingress 外部入口 + system_action 运行时_

- **Ingress 外部入口 (bridge)** — 所有外部消息统一入口，归一化 replyTo/directive/phases 后创建执行合约
  - 功能: `dispatchAcceptIngressMessage` `dispatchCreateExecutionContractEntry` `handleBeforeStartIngress` `normalizeIngressPhases`
  - 文件: `lib/ingress/dispatch-entry.js` `lib/ingress/before-start-ingress.js`
- **Graph-router 内部路由 (传送带派工)** — agent 结束后读 graph **管线**出边(`getPipelineEdgesFrom`)按 gate/status 选下一跳并派工；目标忙则 FIFO 排队、闲时 drain
  - 功能: `routeAfterAgentEnd` `dispatchRouteExecutionContract` `dispatchResolveFirstHop` `drainIdleDispatchTargets` `reconcileDispatchRuntimeTruth`
  - 文件: `lib/routing/dispatch/dispatch-graph-policy.js` `lib/routing/dispatch/dispatch-runtime-reconcile.js`
- **Dispatch transport 原语** — 两条派工语义底层：direct envelope 写具体信封 / shared contract 分配共享合约+stage inbox+唤醒；图授权校验
  - 功能: `dispatchSendDirectRequest` `dispatchSendExecutionContract` `checkGraphAuthorization` `buildDispatchResult`
  - 文件: `lib/routing/dispatch/dispatch-transport.js`
- **Dispatch runtime state (队列真值)** — 派工目标运行时状态原语：claim/release/enqueue/dequeue/requeue + 队列快照持久化，FIFO 单一真值源
  - 功能: `claimDispatchTargetContract` `releaseDispatchTargetContract` `enqueueDispatchContract` `dequeueDispatchContract` `getDispatchQueueDepth`
  - 文件: `lib/routing/dispatch/dispatch-runtime-state.js` `lib/routing/dispatch/dispatch-runtime-persist.js`
- **Runtime mailbox (inbox/outbox)** — agent 工作区邮箱读写：routeInbox 装载 staged 合约+upstream 产物，collectOutbox 采集运行结果
  - 功能: `routeInbox` `collectOutbox` `routeWorkerInbox` `collectRuntimeResult` `resolveMailboxHandlerForAgent`
  - 文件: `lib/routing/mailbox/runtime-mailbox.js` `lib/routing/mailbox/runtime-mailbox-inbox-handlers.js` `lib/routing/mailbox/runtime-mailbox-outbox-helpers.js`
- **Delivery 结果回传 (replyTo)** — 终态结果按 replyTo 元数据投递给网关/用户/QQ(不走 graph)；成功/非成功分流 + 多目标 fanout
  - 功能: `handleCompletedTerminalDelivery` `handleNonSuccessTerminalDelivery` `resolveReplyTarget` `deliverDeliveryTargetMessage` `resolveTerminalUserFacingResultContent`
  - 文件: `lib/routing/delivery/delivery-terminal-runtime.js` `lib/routing/delivery/delivery-targets.js`
- **SSE 广播 + wake 唤醒** — 向 dashboard 推进度的 SSE 客户端管理+broadcast；带语义信封的 agent 唤醒(execution_contract/direct_request_resume/assign_task_dispatch/…)
  - 功能: `broadcast` `addSseClient` `buildProgressPayload` `runtimeWakeAgent` `validateWakeEnvelope`
  - 文件: `lib/transport/sse.js` `lib/transport/runtime-wake-transport.js` `lib/transport/runtime-wake-envelope.js`
- **System-action 运行时 (agent 主动平台操作)** — agent 从产出发起平台操作(assign_task/wake_agent)：按 role 鉴权→dispatch→consume→回执入 ledger→交付链回传
  - 功能: `systemActionDispatch` `systemActionConsume` `systemActionRunAssignTask` `isActionAllowedForRole` `deliveryRunSystemActionChain`
  - 文件: `lib/system-action/system-action-runtime.js` `lib/system-action/system-action-consumer.js` `lib/system-action/system-action-role-policy.js`

### L2 协作·编排 (Collaboration / Orchestration)
_谁能和谁协作、以什么拓扑：graph(边=固定管线定义+传送带投递授权，含环检测) + collaboration-intent-policy(动态协作授权单源) + agent-group(空间原语) + contract 状态机与结局判定(单个协作单元生命周期真值)_

- **图模型与管线边 (agent-graph)** — agent_graph.json 有向图读写：edge=固定管线定义+传送带投递授权(非时序,**非动态协作授权**)，`metadata.pipeline` 标出自动选路可走的那些边，含环检测；写操作经正式控制面
  - 功能: `loadGraph` `hasDirectedEdge` `getPipelineEdgesFrom` `getEdgesTo` `detectCycles (DFS coloring)` `getEdgesFrom/getTransitionsForNode` `addEdge/removeEdge`
  - 文件: `lib/agent/agent-graph.js` `lib/agent/agent-graph-mutations.js`
> **已退役 2026-08-18**：`lib/loop/` 整个「回路注册表 / 回路运行时 / 回路会话·预算」子系统已删除（LoopSpec / LoopSession / startLoopRound / graph.loop.* 表面全部下线）。
> 时间维现由传送带逐跳投递自然承担：图上成环即重复推进，`detectCycles` 负责识环并驱动前端高亮与提示词「当前显式回路」段；
> 防跑飞由 L3 `dispatch-depth-guard`(32/6) 与 `lib/runtime/execution-hard-stop-registry`(重复工具调用指纹) 兜底，两者都不属本层。

- **Agent Group 空间原语** — GroupSpec 展开→显式 EdgeSpec(带 groupId)+成员 outputPolicy+GroupSession；aggregate 等齐/race 先得；workflow=无向连通分量
  - 功能: `expandAgentGroup` `startGroupSession/updateGroupMemberState` `isGroupAggregateSatisfied/pickGroupRaceWinner` `computeAgentWorkflows`
  - 文件: `lib/agent/agent-group-spec.js` `lib/agent/group-session-store.js` `lib/agent/agent-workflow-grouping.js`
- **Contract 状态机与持久化** — 合约 CRUD/落盘/状态迁移(pending→running→terminal)，inbox 主副本→共享 CONTRACTS_DIR 镜像同步
  - 功能: `persistContractSnapshot/persistContractById` `updateContractStatus (+shared mirror)` `mergeContractFields` `scanPendingContracts` `isActiveContractStatus/isTerminalContractStatus`
  - 文件: `lib/contract/contracts.js`
- **Contract 结局判定** — evaluateContractOutcome：语义检查(nonEmpty/semanticText/jsonPaths)+reviewer verdict/score 裁定 COMPLETED/FAILED/AWAITING_INPUT，唯一判定点
  - 功能: `resolveTerminalOutcome` `normalizeTerminalOutcome`
  - 文件: `lib/contract/terminal-outcome.js`
  - ⚠ 2026-08-19：旧 `contract-outcome.js`(287 行五路判定器)已删，本条按 terminal-outcome 重指；`inspectArtifact` 等旧函数名待复核
- **Contract 生命周期视图** — 把合约投影成 work-item 生命周期视图供 dashboard/inspect 读，提供合约侧绑定接口
  - 功能: `bindInboxContractEnvelope/bindPendingWorkerContract` `buildLifecycleSnapshotFromWorkItem/mergeLifecycleSnapshot` `listLifecycleWorkItems`
  - 文件: `lib/contract/contract-lifecycle-builders.js` `lib/contract/contract-lifecycle-view.js`

### L3 Agent执行·安全沙箱 (Agent-Execution / Security)
_单个 agent 干活时的守卫边界：before/after-tool-call 复合拦截 + 路径/写/输出/工具预算 + per-role 能力预设 + dispatch 跳数守卫 + [ACTION] 解析(注入硬化)_

- **before_tool_call 复合拦截** — 每次工具调用前唯一守门：执行硬停(重复工具调用指纹)→合约绑定→工作区外禁写→写大小→role工具/路径→声明式沙箱守卫→security，命中返 {block,blockReason}
  - 功能: `resolveGuardTrackingState` `resolveWorkspacePath` `isInsidePath` `isWorkspaceRootManagedGuidancePath` `canonicalToolPath`
  - 文件: `hooks/before-tool-call.js`
- **after_tool_call 观测·预算收口** — 工具调用后纯观测：记 trace+重复工具调用检测(执行硬停)+maxToolCalls/outputBytes 越界即 markSessionHardStopped+dispatch origin+fault/incident 裁定
  - 功能: `resolveToolWriteTargetPath` `deriveLoopHardStopCommitInfo` `resolveObservedToolPath` `resolveSameToolLoopEvidence`
  - 文件: `hooks/after-tool-call.js`
- **安全检查 (敏感路径/密钥/写大小)** — 纯安全判定：敏感路径读写拦截、API key 泄漏拦截、exec 命令敏感引用拦截、单次写字节上限
  - 功能: `checkToolCall` `checkWriteSize` `isSensitivePath/SENSITIVE_PATH_PATTERNS` `containsApiKey/API_KEY_PATTERNS` `containsSensitivePathReferenceInCommand`
  - 文件: `lib/security/security.js`
- **执行策略预算默认 (per-role budget)** — executionPolicy 真值源：按 role 给工具调用/写/输出字节上限默认梯度(bridge15<planner30<agent50<executor80)，可 override
  - 功能: `getDefaultExecutionPolicy` `mergeExecutionPolicy` `resolveMaxToolCallsFromPolicy` `resolveMaxWriteBytesFromPolicy` `resolveMaxOutputBytesFromPolicy`
  - 文件: `lib/security/execution-policy-defaults.js`
- **能力预设与角色工具限制** — per-role 硬能力预设：TOOL_RESTRICTIONS(planner allowedTools 白名单+readPathScope) + CAPABILITY_PRESETS
  - 功能: `getToolRestrictions` `getCapabilityPreset` `getCapabilityDirectoryOrder` `TOOL_RESTRICTIONS` `CAPABILITY_PRESETS`
  - 文件: `lib/security/capability-preset-registry.js`
- **dispatch 跳数守卫** — 挂在 contract 上的纯运行时计数器防无限跳：MAX_DISPATCH_DEPTH=32 + 同目标重复 MAX_ORIGIN_CHAIN_REPEAT=6 拦 ping-pong
  - 功能: `evaluateDispatchGuard` `nextDispatchGuardState` `readDispatchGuardState` `MAX_DISPATCH_DEPTH/MAX_ORIGIN_CHAIN_REPEAT` `DISPATCH_GUARD_REASON`
  - 文件: `lib/routing/dispatch/dispatch-depth-guard.js`
- **[ACTION] 标记解析 (注入硬化)** — 从 agent output 提取 [ACTION] 系统意图(文本 shorthand + action JSON 双通道)；引用/代码围栏内忽略，sessionNonce provenance 校验(OWASP LLM01)
  - 功能: `extractActionMarkers` `scanMarkerCandidates (fence/blockquote 状态机)` `parseActionJsonPayload` `parseActionLine` `presentsNonce`
  - 文件: `lib/security/action-marker-parser.js`

### L4 提示词装配 (Prompt-Assembly)
_按六层模型(①框架②工具③skill头④role⑤SOUL⑥wake)组装系统提示词，两条路径分流(直连 vs 派工，sessionKey 判定)，IDENTITY(托管)与 SOUL(用户拥有)解耦_

- **派工提示词手拼 (contract-session override)** — 系统派工进合约会话时手拼 agent-awake 提示词真实写路径：④role→⑥wake→⑤SOUL(末尾保前缀缓存)，sessionKey 判是否覆盖
  - 功能: `buildContractSessionSystemPrompt` `shouldOverrideContractSessionPrompt` `resolveContractSession` `readWakeOverrideBlock` `readUserSoulBlock`
  - 文件: `lib/prompt/contract-session-prompt-override.js`
- **六层装配读投影** — 只读观测：读框架写在 sessions.json 的 systemPromptReport 真值，投影成六层 layers[]，不造第二真值
  - 功能: `readSessionSystemPrompt` `buildLayers` `buildAgentAwakeView` `buildSoulView` `buildSkillHeads`
  - 文件: `lib/agent/agent-session-system-prompt.js`
- **role persona 注册表 (④/⑥源)** — 6 个 role 的 persona 文本+产出指令(planner产简报/worker产交付物)单一源；persona 空则该层退化不注入
  - 功能: `renderRolePersonaBlock` `getRoleOutputDirectives` `getRoleSoulProfile` `getRoleSpec` `getRoleSummary`
  - 文件: `lib/prompt/role-spec-registry.js`
- **托管指引文件写入器 (IDENTITY/SOUL)** — ④role persona 写进带 marker 的托管 IDENTITY.md(平台重写)，⑤SOUL 作无 marker 用户占位只 seed 一次(平台永不重写)
  - 功能: `syncAgentWorkspaceGuidance` `syncAllRuntimeWorkspaceGuidance` `bootstrapAgentWorkspace` `buildManagedIdentityDoc` `buildUserSoulPlaceholder`
  - 文件: `lib/workspace-guidance-writer.js` `lib/agent/managed-guidance-files.js`
- **语义技能注入注册表 (③skill 头)** — 声明式 skill spec 表决定 forced_platform/role_scoped/operator 注入；③层 skill 头强制注入，全文按需 read(渐进披露)
  - 功能: `listForcedPlatformSkillRefs` `listRoleSemanticSkillRefs` `buildRoleInjectedSemanticSkillMap` `listOperatorSemanticSkillRefs` `getSemanticSkillSpec`
  - 文件: `lib/prompt/semantic-skill-registry.js`
- **role 解析入口** — 从 config/AgentBinding 解析 agent role 与配置技能，驱动 ④persona/⑥wake/③role-scoped-skill 分流的输入源
  - 功能: `getAgentRole` `normalizeAgentRole` `getAgentConfiguredSkills` `getRuntimeAgentConfig` `getAgentIdentitySnapshot`
  - 文件: `lib/agent/agent-identity.js`
- **指引漂移检测与本地接管** — 扫描托管指引是否偏离平台生成版(managed vs editable)，提供本地预览/写入/接管，支撑 IDENTITY 托管与 SOUL/WAKE 用户可编辑边界
  - 功能: `scanWorkspaceGuidanceDrift` `scanAndRecordWorkspaceGuidanceDrift` `readLocalAgentGuidancePreview` `writeLocalAgentGuidanceContent` `takeOverLocalAgentGuidance`
  - 文件: `lib/agent/agent-guidance-drift.js` `lib/agent/agent-enrollment-guidance.js`

### L5 交付·产物 (Delivery / Artifacts)
_产物如何生成、独立留存、整包流转到下游 inbox/upstream/，上游上下文有界注入与溢出压缩，contract.output 别名规范化，用户可见产出判定_

- **上游产物整包流入 (upstream-package-inflow)** — 把上游 agent 的树 outbox 整包送进下游 inbox/upstream/<producer>/，每 producer 独立包互不覆盖。数据源只有树 outbox 一处：已封包→symlink 零拷贝，未封包→拷当前内容
  - 功能: `copyUpstreamArtifactsToInbox` `resolveUpstreamProducers` `listPackageFiles` `readPackagePrimary`
  - 文件: `lib/delivery/upstream-package-inflow.js`
  - ⚠ 2026-08-19 改名并收店：原 `lib/lifecycle/artifact-store.js`；`control-plane/artifacts/` 副本店与 `saveAgentArtifact`/`artifactPackageDir`/`preserve-stage.js` 全部删除。上游名单不再反查图入边，改读 `contract.upstreamProducers` 指针（写者 `dispatch-graph-policy.js` 的 `applyUpstreamProducerPointer`）
- **上游上下文有界注入·溢出压缩** — 唯一字节预算真值(纯函数)：决定哪些上游文件整包流入、哪些溢出改压缩清单/缺料标记，可单测不读写盘
  - ⚠ 2026-08-19 本条已失真：`lib/delivery/context-compression.js` 与 `computeContextBudgetPlan` 全库零命中，上游上下文预算面已被其他工作重写，定址前先 find。（非回路退役造成）
- **下游收包接线 (routeInbox 尾部)** — before_agent_start 时把上游产物包拷进 inbox，并把 upstreamPackages 指针写进刚 stage 的 contract.json
  - 功能: `writeUpstreamPackagesPointer` `resolveStagedContractId` `upstreamPackages 白名单字段`
  - 文件: `lib/routing/mailbox/runtime-mailbox.js` `lib/routing/mailbox/runtime-mailbox-inbox-handlers.js`
- **agent_end 产物落点 (preserve_artifact)** — 派发下一环前整包保存：从 executionObservation.artifactPaths 取多文件产物，空则回退 contract.output/primaryOutputPath 单交付物
  - 功能: `preserve_artifact stage` `extract_output_markers stage` `primaryOutputPath fallback` `context._outputContent`
  - 文件: `lib/lifecycle/agent-end/stage-definitions.js` `lib/lifecycle/agent-end/transport.js`
- **产物包读取器 (produced-files)** — 从 artifactPackageDir+manifest.json 读该 agent 真正产出的文件正文，供工作流/会话查看器页面内显
  - 功能: `resolveProducedFiles` `ARTIFACT_MANIFEST_FILE` `manifest.primary 排序` `PRODUCED_CONTENT_CAP`
  - 文件: `lib/agent/agent-session-transcript.js`
- **用户可见产出判定** — 判定产出是真交付内容还是运行时控制噪声([ACTION]/LOOP DETECTED/tool error)，并量算工具结果字节
  - 功能: `classifyRuntimeControlPayload` `isRuntimeControlPayload` `measureToolResultBytes` `isToolOutcomeError`
  - 文件: `lib/delivery/runtime-user-facing-output.js`

### L6 知识·RAG (Knowledge / RAG)
_operator 消费的知识层：wiki-RAG hybrid 检索(向量 cosine+词法 BM25-lite RRF 融合+查询改写) + 多知识库注册表/任意文件 ingestion + recall@k·MRR·faithfulness 评测，0 外部依赖优雅退化_

- **embed 客户端** — 本地 ollama HTTP embed(qwen3-embedding:0.6b @:11434)向量化 query/chunk；不可用抛 coded error 供降级
  - 功能: `embedText` `resolveWikiRagEmbedConfig` `resolveEmbedDispatcher` `WIKI_RAG_EMBED_UNAVAILABLE`
  - 文件: `lib/knowledge/wiki-rag-embed.js`
- **向量库·切分·索引 (store)** — flat-JSON 向量库：切块→sha256 增量复用向量→写索引；提供 cosine 与 BM25-lite 两种 top-K 检索
  - 功能: `buildWikiRagIndex/embedChunkPlanToIndex` `searchWikiRag (cosine)` `searchWikiRagLexical (BM25-lite)` `buildChunkPlanForSources/isTextFile` `extractChunkMeta`
  - 文件: `lib/knowledge/wiki-rag-store.js`
- **hybrid 检索·查询改写·融合 (search)** — 对已加载索引做 查询改写→词法+向量→RRF 融合 的 hybrid 检索核心；wiki 与任意 KB 共用同一入口
  - 功能: `hybridSearchOverIndex` `rewriteQuery (剥疑问/礼貌脚手架保 WHY)` `rrfFuse (RRF k=60)` `searchWiki/searchWikiVector` `deriveConflictHints`
  - 文件: `lib/knowledge/wiki-rag-search.js`
- **rerank + judge (LLM 二级)** — 可选 LLM listwise rerank(默认关)+本地 LLM-as-judge(ollama chat/json，防御式解析)
  - 功能: `rerankResults/applyRanking` `ollamaChatJson` `parseJudgeJson` `buildLocalRagJudge`
  - 文件: `lib/knowledge/wiki-rag-rerank.js` `lib/knowledge/wiki-rag-judge.js`
- **召回评测引擎 (eval)** — 纯函数评测：recall@k/MRR/ghostHitRate+faithfulness/context-precision；searchFn/judgeFn 注入可单测可 live
  - 功能: `evaluateWikiRagRecall` `formatRecallReport` `evaluateFaithfulness` `evaluateContextPrecision`
  - 文件: `lib/knowledge/wiki-rag-eval.js` `tests/fixtures/wiki-rag-eval-set.json`
- **多知识库注册表·ingestion (KB)** — 多 KB 注册表(种子 wiki∪用户库)+任意文件/文件夹 ingestion+per-agent 检索合并；建库/检索全复用 wiki-rag 核心
  - 功能: `listKnowledgeBaseSpecs` `buildKbIndex` `searchKb/searchAgentKnowledge` `selectAgentKnowledgeBases/mergeAgentKbResults` `normalizeKnowledgeBaseSpec`
  - 文件: `lib/knowledge/knowledge-base.js` `lib/knowledge/knowledge-base-registry.js`
- **per-KB 评测集·运行 (knowledge-eval)** — per-KB 评测集持久(query→expectedSourcePath)+跑 recall/faithfulness 运行并存摘要
  - 功能: `runKnowledgeEval/runKnowledgeFaithfulness` `listKnowledgeEvalRuns` `saveKnowledgeEvalSet/deleteKnowledgeEvalSet` `normalizeKnowledgeEvalSet`
  - 文件: `lib/knowledge/knowledge-eval-registry.js` `lib/knowledge/knowledge-eval-runner.js`
- **operator 消费边 (grounding)** — 把 wiki-RAG 结果映射成 {title,sourcePath,excerpt} grounding notes 注入 operator 上下文
  - 文件: `lib/operator/operator-knowledge.js`
  - ⚠ 2026-08-19：`operator-knowledge-library.js` 已不存在，`retrieveWikiGroundingNotes` 等函数名全库零命中（grounding 已改走 `searchAgentKnowledge`），功能行待复核。（非回路退役造成）

### L7 验证·测试 (Verification / Test)
_如何验证系统正确性：formal-runtime 测试系统(CheckResult+E-码注册表+预设→suite 驱动+CLI，产 failures-first 报告)。
(harness 执行塑形+质量门控已随 harness 全退役删除，v226 / 2026-08-23；下方 Harness* 条目为历史描述)_

- ~~**Harness 目录·注册表·组装校验** —（已退役 v226）~~ harness 静态真值：10 模块(guard/collector/gate/normalizer)+4 profile+选择归一(coverage 比率派生 mode)+组装连贯性软建议
  - 功能: `listHarnessModuleCatalog` `summarizeHarnessRegistry` `normalizeHarnessSelection` `HARNESS_PROFILES` `validateHarnessComposition (no_gate/no_guard/gate_without_collector)`
  - 文件: `lib/harness/harness-module-catalog.js` `lib/harness/harness-registry.js` `lib/harness/harness-composition.js`
- ~~**Harness Run 生命周期** —（已退役 v226）~~ HarnessSpec/HarnessRun 归一与 start/finalize，从 automationSpec 建 spec，reviewerResult 从模块结果派生
  - 功能: `normalizeHarnessRun` `startHarnessRun` `finalizeHarnessRun` `buildHarnessSpec` `HARNESS_RUN_STATUS/HARNESS_GATE_VERDICT`
  - 文件: `lib/harness/harness-run.js` `lib/harness/harness-run-normalizers.js`
- ~~**Harness 模块执行器 (pass/fail 判定)** —（已退役 v226）~~ 每模块实际判定：guard 评工具白名单/网络/scope/沙箱/预算，gate 判 artifact/schema/test，normalizer 判 eval_input/failure；worst-status 合并
  - 功能: `initializeHarnessRunModules` `finalizeHarnessRunModules` `evaluateToolAccessGuard/evaluateScopeGuard` `GUARD_REGISTRY` `combineStatuses (failed>passed>skipped)`
  - 文件: `lib/harness/harness-module-runner.js` `lib/harness/harness-module-evaluators.js` `lib/harness/harness-guard-checks.js`
- ~~**Run-Shape 覆盖塑形 + 评审/评估结果** —（已退役 v226）~~ coverage 三层对象化(RunShapeMap)+完整性校验(消除假安全感)+softGuided 反逼；reviewer/evaluation/stage 结果构造归一
  - 功能: `buildRunShapeMap/validateRunShapeMap` `validateCoverageCompleteness` `buildReviewerResult/isPassingReviewerResult` `buildEvaluationResult` `listMissingStageArtifacts`
  - 文件: `lib/harness/run-shape-map.js` `lib/harness/soft-guidance.js` `lib/harness/reviewer-result.js`
- ~~**Harness 存储 + Dashboard 投影** —（已退役 v226）~~ HarnessRun 落盘/按 contract 或最近查询 + dashboard 目录投影(模块/profile 用量、placements、recentRuns)
  - 功能: `recordHarnessRun/getHarnessRun` `listRecentHarnessRuns/listHarnessRunsByContract` `summarizeHarnessDashboard` `buildPlacementSummary` `summarizeRecentRuns`
  - 文件: `lib/harness/harness-run-store.js` `lib/harness/harness-dashboard.js`
- **CheckResult 引擎 + E-码注册表** — 测试系统原子：CheckResult(pass/fail/skip/blocked)归一/校验/统计，fail/blocked/skip 必带已注册 E-码；105 条错误码单一注册表(code→meaning+hint)
  - 功能: `createCheckContext/addCheck` `runCheck` `markBlocked` `summarizeChecks` `getErrorCode/ERROR_CODES`
  - 文件: `lib/formal-runtime/checks/check-runner.js` `lib/formal-runtime/error-codes.js`
- **预设 + Suite 分发 + CLI** — 12 formal preset(full=11 suite)单一真值源→11 suite 驱动分发(full 串行聚同 context)；SSE 进度、clean reset；test-runner 薄 CLI 经 /watchdog/test-runs/*
  - 功能: `FORMAL_TEST_PRESETS/getFormalPresetById` `runFormalSuite/executeSuiteSegment` `applyRunStats` `parseCliRunArgs/waitForCliRunCompletion`
  - 文件: `lib/formal-runtime/formal-test-presets.js` `lib/formal-runtime/test-run-suites.js` `test-runner.js`
- **Suite 驱动 (子系统探针)** — 每 suite=一个子系统静态/live/embed 探针，自寻靶(graph/registry/fixture)产 CheckResult；health 零 LLM
  - 功能: `runHealthSuite/runDispatchSuite/runPipelineSuite` `runLinkSuite` `runOperatorSuite/runAgentGroupSuite` `runKnowledgeSuite/runModelSuite/runVizSuite` `runHarnessSuite/runSystemActionSuite/runConcurrentSuite/runUnitSuite`
  - 文件: `lib/formal-runtime/suite-link.js` `lib/formal-runtime/suite-operator.js` `lib/formal-runtime/suite-group.js`
- **Checks 探针库 + Infra + 报告** — 重型可复用探针(health-node 进程内/health-gateway live/operator-probe/system-action-chain SSE)+HTTP/reset/SSE infra+failures-first 报告+串行锁
  - 功能: `runHealthNodeChecks/runHealthGatewayChecks` `mapProbeSignalsToChecks/listChainStages` `fetchJSON/wakeAgentNow/fullReset` `generateFormalReport/buildFormalReportJson` `withTestLock`
  - 文件: `lib/formal-runtime/checks/health-node.js` `lib/formal-runtime/checks/system-action-chain.js` `lib/formal-runtime/infra.js`

### L8 调度·自动化 (Schedule / Automation)
_cron/schedule 到点触发 + automation 自治轮次的注册与运行，把任务文本投到目标 agent :main 直连会话；schedule=一次性命令触发，automation=多轮自改善回路(编织决策收敛/治理画像沉淀)_

- **调度注册表与管理面** — schedule spec 规范化/存储/CRUD，及 operator/dashboard 创建改删启停门面
  - 功能: `normalizeScheduleSpec` `upsertScheduleSpec` `setScheduleEnabled/deleteScheduleSpec` `createScheduleDefinition/updateScheduleDefinition`
  - 文件: `lib/schedule/schedule-registry.js` `lib/schedule/schedule-admin.js`
- **调度触发器** — cron 到点 /watchdog-schedule-run <id> 命令执行体：校验 enabled/并发，把 entry.message 投进目标 agent :main 会话
  - 功能: `executeScheduleTrigger` `SCHEDULE_TRIGGER_COMMAND` `buildScheduleTriggerCommandMessage` `findActiveScheduleContract` `buildScheduleContext`
  - 文件: `lib/schedule/schedule-trigger.js`
- **Cron 物化器** — 把 schedule spec 双向同步成框架 cron job(add/edit/remove)，维护 scheduleId↔jobId 映射(cron edit 不支持 --json 是已知坑)
  - 功能: `syncScheduleMaterialization` `buildAddArgs/buildEditArgs/buildRemoveArgs` `runCronCli` `extractCronJobId` `isMissingCronJobError`
  - 文件: `lib/schedule/schedule-materializer.js`
- **自动化注册表与管理面** — automation spec(objective/entry/wakePolicy/governance/harness)规范化/存储/CRUD，及创建改删/启停/治理/手动 run 门面
  - 功能: `normalizeAutomationSpec` `upsertAutomationSpec/getAutomationSpec` `createAutomationDefinition/updateAutomationDefinition` `controlAutomationGovernance` `runAutomationDefinition`
  - 文件: `lib/automation/automation-registry.js` `lib/automation/automation-admin.js`
- **自动化运行时状态** — 每 automation 运行时快照：status/round/best/streak/harness run/governanceSnapshot/profileLifecycle，及聚合摘要
  - 功能: `ensureAutomationRuntimeState/upsertAutomationRuntimeState` `setAutomationGovernanceControl (熔断/复活)` `summarizeAutomationRuntimeRegistry` `normalizePendingReworkGuidance`
  - 文件: `lib/automation/automation-runtime.js`
- **轮次驱动/Executor** — mode-B 生产驱动：到点轮询起跑新一轮、把上轮教训拼进任务文本、周期对账运行时真值
  - 功能: `pollDueAutomations` `startAutomationRound` `reconcileAutomationRuntimeStates` `composeEntryMessageWithRework` `buildNextWakeAt`
  - 文件: `lib/automation/automation-executor.js` `lib/automation/automation-start.js` `lib/automation/automation-reconcile.js`
- **Harness 生命周期编织** — 为每轮 automation 构建/续接 harness spec+run，建合约索引，把 dispatch 结果分类为 started/busy
  - 功能: `buildActiveHarnessLifecycle` `buildContractIndex` `classifyStartResult` `appendHarnessRun/hasRecordedRound` `resolveRoundFromContext`
  - 文件: `lib/automation/automation-harness-lifecycle.js`
- **轮次收敛与决策** — 合约终态回收本轮：跑 gate、算改善/spin、按预算与 reviewer verdict 派生 continue/rework/conclude/pause/abandon
  - 功能: `handleAutomationContractTerminal` `deriveDecision (maxRounds/earlyStop/no_progress_repeat)` `computeImprovementState (fingerprint spin)` `buildReworkGuidance` `extractContractScore`
  - 文件: `lib/automation/automation-finalize.js` `lib/automation/automation-decision.js`
- **治理与画像生命周期** — 由决策证据派生 profileLifecycle(trust ladder)与 governanceSnapshot(收紧参数)，达阈值沉淀因果 skill
  - 功能: `buildProfileLifecycle/TRUST_LADDER` `resolveGovernance (唯一合流点)` `normalizeGovernanceSnapshot` `shouldPrecipitateSkill/extractCausalSkill` `precipitateSkill`
  - 文件: `lib/automation/profile-lifecycle.js` `lib/automation/resolve-governance.js` `lib/automation/automation-skill-precipitation.js`

### L9 控制面·元层 (Control-plane / Meta-agent)
_元 agent(operator+viz-master)经 cli-system 四表面(inspect/apply/verify/observe)零旁路读写系统结构本身，配 structure-snapshot 原子回滚+表面所有权守卫，回答如何安全改系统表象/结构_

- **cli-system inspect 表面 (零旁路读)** — 所有观测读唯一入口：surfaceId→INSPECT_SOURCES 数据源函数，收口约 30+ 直读 store 旁路
  - 功能: `inspectCliSystemSurface` `INSPECT_SOURCES` `listCliSystemSurfaces/getCliSystemSurface` `projectProfileLifecycle` `CLI_SYSTEM_FAMILIES`
  - 文件: `lib/cli-system/cli-surface-inspector.js` `lib/cli-system/cli-surface-registry.js`
- **cli-system apply/verify 表面 + 所有权守卫** — 唯一写入执行口+apply 成功后强制 verify 门+meta-agent 表面族所有权裁定(operator=*, viz-master=[chart])
  - 功能: `executeCliSystemSurface` `assertActorOwnsSurface/filterExecutableSurfacesForActor` `runVerifyAfterApply` `isVerifyRequiredAfterApply` `META_AGENT_SURFACE_OWNERSHIP`
  - 文件: `lib/cli-system/cli-surface-executor.js` `lib/cli-system/cli-surface-verify-gate.js` `lib/cli-system/meta-agent-surface-ownership.js`
- **operator 大脑 (元 agent 规划)** — operator LLM 规划器：装配 live 平台上下文→模型链 fallback 调 planner→产可执行/建议 plan 并归一+可行性预检
  - 功能: `planWithOperatorBrain/callPlannerWithModelFallback` `normalizeOperatorPlan` `OPERATOR_PLAN_INTENTS/EXECUTABLE_OPERATOR_PLAN_INTENTS` `assertOperatorPlanAgentFeasibility` `buildOperatorSnapshot`
  - 文件: `lib/operator/operator-brain.js` `lib/operator/operator-plan.js` `lib/operator/operator-snapshot.js`
- **operator 执行器 (原子应用+元→元委派)** — plan 逐步经 executeCliSystemSurface 落地：designer-only 硬门、explicit-confirm 门、多步前拍快照、软/硬失败回滚、meta.delegate 一跳委派 viz-master
  - 功能: `executeOperatorExecutablePlan` `runMetaDelegate/META_AGENT_DELEGATES` `listOperatorExecutableCliSystemSurfaces` `designer-only 门+soft-fail 回滚`
  - 文件: `lib/operator/operator-executor.js` `lib/operator/operator-surface-policy.js`
- **structure-snapshot 回滚地基** — 把 3 大结构真值(graph/agent bindings/automation specs)内容寻址成快照，拍/还原/校验+非破坏预览
  - 功能: `captureStructureSnapshot/restoreStructureSnapshot (TOCTOU expectHash)` `projectStructureAfter` `exportStructureCode/decodeStructureCode` `evaluateProposalTier`
  - 文件: `lib/control-plane/structure-snapshot.js` `lib/control-plane/proposal-tier.js` `lib/control-plane/structure-share-code.js`
- **admin-surface 操作层 (apply 落地)** — apply 家族每条 surface 的 handler 表+统一执行入口，落地前对 destructive/structural 自动拍快照，throw 时单一 choke 自动回滚
  - 功能: `executeAdminSurfaceOperation` `maybePreApplyStructureSnapshot` `ADMIN_SURFACE_OPERATION_HANDLERS` `getUnifiedSurfaceMap/normalizeAdminSurfacePayload`
  - 文件: `lib/admin/operations/admin-surface-operations.js` `lib/admin/admin-surface-registry.js`
- **chart 控制面 (viz-master 唯一写者)** — charts.json 非真值控制面 store 的 CRUD+chart 家族 admin-surface handler，快照免疫
  - 功能: `upsertChart/moveChartPosition/deleteChart` `normalizeChartSpec/loadCharts/saveCharts` `createChartDefinition/deleteChartDefinition`
  - 文件: `lib/control-plane/chart-registry.js` `lib/admin/chart-operations.js`
- **viz-master (第 2 meta-agent)** — 独立 LLM 大脑规划 chart+accept-stage 防伪对照验证(3 路同构，从不自证)，经 operator 执行器以 viz-master actor 落地(仅 chart 族)
  - 功能: `buildVizMasterPlan/executeVizMasterPlan` `verifyVizMasterPlan (3× 同构对照)` `planWithVizMasterBrain` `validateChartSpec/deriveChartNarrative`
  - 文件: `lib/viz/viz-master-runtime.js` `lib/viz/viz-master-brain.js` `lib/viz/chart-verification.js`

### L10 观测·前端 (Observability / UI)
_人如何观测系统：零构建 SPA `extensions/watchdog/ui/`(指挥台/透视/管理三区,v233 前端重制转正;旧 dashboard 9 页 MPA 已整删)+routes/ HTTP 面(SPA 壳与静态直发、SSE 推流、只读 inspect 家族、admin-surface POST、reveal-file)，前端零旁路_

- **SPA 壳·路由·store·i18n** — app.js 壳接线(token 取 location.search)、zone 路由三区切换、单向数据流 store、SSE 事件接入与多语言
  - 功能: `createStore` `createApi/createEventStream` `startRouter` `createI18n (L/tx)` `esc (html)`
  - 文件: `ui/app.js` `ui/core/router.js` `ui/core/store.js` `ui/core/api.js` `ui/core/i18n.js`
- **指挥台 (command)** — 三栏+读数带+日志抽屉：work-items 快照轮询 15s+SSE 即时刷、代理图板、脉搏卡与哨兵信号
  - 功能: `mountCommandPage` `renderStatStrip` `renderWorkItemList` `createGraphBoard` `renderPulseColumn/renderLogDrawer/evaluateSentinels`
  - 文件: `ui/pages/command/index.js` `ui/pages/command/command-page.js` `ui/pages/command/graph-board-controller.js` `ui/components/graph-board.js` `ui/components/work-item-list.js` `ui/components/pulse-column.js` `ui/components/stat-strip.js`
- **透视页 (inspect)** — 左树+右详三 Tab：threads 树、run 时间线+trace 锚点证据对齐、session 转写/六层系统提示词/合约封条(数据源 inspect.threads/run/run_join/trace/session_transcript/session_system_prompt/contract_seal)
  - 功能: `mountInspectPage` `buildTreeModel` `renderInspectLayout/renderTabBar` `sessionIdFromParticipantFiles`
  - 文件: `ui/pages/inspect/index.js` `ui/pages/inspect/inspect-page.js` `ui/components/thread-tree.js` `ui/components/run-timeline.js` `ui/components/output-panel.js` `ui/components/prompt-layers.js`
- **管理区 (manage) 五子页** — agents/knowledge/charts/control-plane/devtools 统一子导航壳，每页核心只读视图+关键动作
  - 功能: `mountManagePage` `mountAgentsPage` `mountKnowledgePage` `mountChartsPage` `mountControlPlanePage` `mountDevtoolsPage`
  - 文件: `ui/pages/manage/index.js` `ui/pages/manage/agents.js` `ui/pages/manage/knowledge.js` `ui/pages/manage/charts.js` `ui/pages/manage/control-plane.js` `ui/pages/manage/devtools.js`
- 已退役页（v233 整删，无 ui/ 对应页）：工作流页(dashboard-workflow)、operator 独立对话子页(dashboard-operator)；塑形套件页(dashboard-harness*)已先随 harness 退役(v226)
- **Routes·HTTP 观测面** — 前端可达 HTTP 面：SPA 壳(/watchdog/,token 鉴权)+静态直发(/watchdog/ui/*)、SSE 推流、只读 inspect 家族(403 守卫)、graph 读、admin-surface POST 统一注册、reveal-file
  - 功能: `/watchdog/ (SPA 壳)` `/watchdog/ui/* (静态直发)` `/watchdog/stream (SSE)` `/watchdog/inspect (family==inspect 否则 403)+GET /watchdog/graph|runtime` `registerAdminSurfacePostRoute` `/watchdog/reveal-file→revealFileInFinder`
  - 文件: `routes/api.js` `routes/dashboard.js` `routes/control-plane.js` `routes/operator-catalog.js`

## 3. 现状结构评估 (目录分区问题)

> ⚠️ **本节与 §4 是重排**前**的诊断与蓝图,已于 v171/v172 执行完毕**(2026-08-09 实测:`lib/` 根 82→14,扩展根 `dashboard-*.js` 39→0)。保留为决策记录,**读现状请看 §2 与 §5**。个别条目仍未处置(如 §3.3 的 `task-stage-planner.js`),以代码为准。文中出现的 `dashboard/`(v233 随前端重制整删,现前端=`ui/` 零构建 SPA)与 `lib/harness/`(v226 随 harness 退役整删)均已不存在,相关字句一律作历史记录读。

**当时的最大问题**: `lib/` 根目录散着 82 个松散文件(≈15% 代码)+ 扩展根目录散着 39 个 `dashboard-*.js`,都没有内聚子目录。

### 3.1 混职责目录 (该拆)
- lib/operator/ — mixes L9 operator control-plane (brain/plan/snapshot/executor/policy, ~12 files) with the ENTIRE L6 knowledge/RAG subsystem (10 infra files). Two distinct concerns under a directory named after only one of them (the consumer). Split: hoist RAG → lib/knowledge/.
- lib/routing/ — a large flat 28-file dir mixing three sub-families with no nesting: dispatch-* (10 = conveyor/queue transport), delivery-* (13 = replyTo return leg incl. 7 delivery-system-action-* files), runtime-mailbox-* + runtime-authority (5 = inbox/outbox). Recommend lib/routing/{dispatch,delivery,mailbox}/. Note runtime-authority.js is a vague name for a narrow system-action delivery-authority helper.
- lib/capability/ — mixes an L3 HARD security guard (capability-preset-registry.js, enforced by before_tool_call) with L9 control-plane read-model aggregators (capability-registry + capability-management-targets). Split guard→security/, read-models→management/; the dir dissolves.
- lib/agent/ — a multi-layer catch-all spanning L0 (metadata constants), L2 (graph + group orchestration), L3 (capability policy), L4 (identity/binding/prompt/guidance/enrollment), L5 (session transcript producer), L9 (14-file admin/join CRUD) and L10 (reveal-file). No single cohesive concern. Extract admin/join → agent/admin/, reveal-file → transport/, registry-view → management/.
- lib/lifecycle/ — cross-layer 'fires at agent_end' catch-all: L0 orchestration mixed with L5 artifact-store, L7 harness recorder (agent-end/harness-recorder), and the misplaced runtime-diagnostics (zero lifecycle consumers). Defensible via agent-end/* naming, but no single-layer cohesion. (2026-08-18: loop retirement removed agent-end/{stage-advance,graph-route-diagnostics,harness-automation-id,loop-budget-governance}.js and cut graph-route.js well under the 300-400L god-file rule.)
- hooks/ — organized by event, not by concern/altitude: 20-line L0/L4 shells (before-prompt-build, agent-end) sit beside 374/379-line substantial L3 security/guard interceptors (before/after-tool-call). Heavy guard bodies read as they should delegate to lib/security/ (mirroring how agent-end.js delegates to lib/lifecycle/), leaving thin shells in hooks/.
- lib/formal-runtime/ — top level flattens engine/registry (error-codes), report renderer (formal-report), infra (3 files incl. a 9-line infra-tokens.js that exists only to break an infra.js<->infra-sse.js import cycle), serial-lock, and 12 per-subsystem suite drivers all beside a single carved-out checks/. Recommend a suites/ grouping; and split checks/ engine (check-runner) from heavy live probes (health-gateway/operator-probe/system-action-chain).
- lib/admin/ — asymmetric: surface METADATA is cleanly subdir'd (catalog/ input-fields/ plan-hints/) but the large OPERATION HANDLERS stay flat (admin-surface-operations + -graph-operations; -loop-operations deleted 2026-08-18). Also the admin-change-set-* 7-file (~1289L) draft->preview->verify->commit->execute sub-subsystem sits flat. Recommend admin/operations/ and admin/change-sets/.
- lib/store/ — mixes substantive stateful stores (tracker-store 488, contract-store 202) with near-trivial 23-25 line Map/Set wrappers (agent-card-store, heartbeat-session-store, task-history-store). The tiny wrappers are thin indirection more than stores. (2026-08-18: the L0→L2 upward import is gone — the hard-stop registry moved to lib/runtime/execution-hard-stop-registry.js.)
- lib/transport/ — thin 3-file dir weakly mixing SSE broadcast (observability/UI push) with agent wake (a dispatch primitive); they co-habit only because both 'push outward'. Acceptable but note the concern seam.

### 3.2 命名不一致 (该规整)
- runtime-* prefix at lib root does NOT map to lib/runtime/: runtime-mailbox / runtime-direct-envelope-queue / runtime-workflow-semantics (all L1→routing), runtime-stage-progress (L2→stage), runtime-user-facing-output / runtime-contract-output-alias (L5→delivery), runtime-activity (L0→runtime). The prefix misleads — only 1 of 7 actually belongs to the runtime signal family. Rename or let dir placement carry the meaning.
- wiki-rag-* vs knowledge-* — two parallel prefixes for one RAG subsystem (legacy seed-corpus 'wiki-rag-*' engine vs newer generalized 'knowledge-*' KB/eval). The wiki-rag prefix is now a misnomer since the engine serves arbitrary KBs. After hoist to lib/knowledge/, normalize toward a single knowledge-* (or rag-*) prefix.
- marker-parser family split by concern but named alike: action-marker-parser (L3 →security), finding-marker-parser (L7 →harness), stage-marker-parser (L2 →stage). Sibling filenames, unrelated homes — intentional but a system.map reader will conflate them.
- *-registry-view projections split across root (model-registry-view, management-registry-view) vs lib/agent/agent-registry-view.js — one read-model family, three locations. Consolidate under lib/management/.
- admin-surface- prefix on aggregator files (admin-surface-catalog/-input-fields/-plan-hints.js) while the sibling subdirs they re-export are bare (catalog/ input-fields/ plan-hints/). Pick one convention.
- runtime-authority.js (lib/routing/) — vague name for a narrow helper that only matches system-action delivery authority vs target; role not discoverable from filename.
- lib/store/contract-flow-store.js — named for 'contract flow' but actually stores dispatch-chain origin bookkeeping (a routing/L1 concern); the name misdescribes the content.
- Stale header-path comments `// lib/<oldname>.js` after prior subdir moves (transport/sse.js, runtime-wake-transport.js, all 4 ingress files) still point at pre-reorg top-level locations. This reorg will multiply such drift — codemod must rewrite the leading path-comment too, not just require() paths.
- RESOLVED 2026-08-18: the `loop` naming collision is fully gone. 'repeated tool-call hard-stop' moved out of the old lib/loop/ to `lib/runtime/execution-hard-stop-registry.js` (L3 sandbox safety, consumed by hooks/before+after-tool-call), and loop-epoch-key.js to `lib/runtime/session-epoch-key.js`; then lib/loop/ itself was deleted with the loop retirement. **Every surviving `loop` literal in lib/ now means one of exactly three things**: (a) execution hard-stop (`lib/runtime/*`, hooks/*-tool-call.js, `[LOOP DETECTED]` marker), (b) graph cycle detection (`detectCycles` and its dashboard/prompt consumers), (c) the second naming family — self-governance / Inspect-Apply-Verify / tool loop (`lib/operator/operator-knowledge.js`, `lib/knowledge/knowledge-toolface.js`, `wiki/concepts/self-governance-loop.md`). The anti-runaway guard `dispatch-depth-guard.js` remains in routing/ (deliberate: it rides the contract snapshot, not a registry).

### 3.3 死码 / 孤儿 / 残壳 (确认后处理,勿自动删)
- lib/task-stage-planner.js — 21-line stub whose planTaskStages() returns null; a thin/likely-dead re-export superseded by materializeTaskStagePlan in task-stage-plan.js. Confirm no importer, then delete (do NOT auto-remove — get explicit approval per dead-code hygiene).
- lib/dev/system-block-registry.js — a one-file dir with NO runtime consumers; only two test files + README doc-sync reference it. A build/introspection tool inside the runtime lib/ tree; orphan-by-runtime standards but intentionally retained per the prior /simplify audit. Keep, but it doesn't belong in the runtime import graph.
- lib/agent/agent-admin.js, lib/agent/agent-admin-agent-operations.js, lib/agent/agent-binding-store.js, lib/harness/harness-module-contract.js — NOT dead (still re-exported) but vestigial facade/shim remnants of prior god-object splits; harness-module-contract is a thin re-export over harness-module-schema worth folding in. Flagged as churn signals, not deletions.

### 3.4 已内聚·保持原样
- lib/automation/ — cohesive well-factored L8 (15 single-concern files mapping cleanly to taxonomy modules; no cross-layer intruders). Only nit: admin-helpers.js is shared with lib/schedule/ but lives only here (asymmetric, no neutral home).
- lib/cli-system/ — cohesive L9 four-surface (inspect/apply/verify/observe) zero-bypass control plane.
- lib/schedule/ — cohesive L8 (registry/admin/trigger/materializer).
- lib/system-action/ — cohesive L1 system_action runtime (dispatch/consume/ledger/role-policy); gains collaboration-policy.js.
- lib/ingress/ — cohesive L1 external-entry bridge. (2026-08-19: conversations.js retired — thread 已接管跨 run 索引；buildConversationId 内联进 dispatch-execution-contract-entry.js 作 threadId 谱系种子。)
- lib/core/ — clean L0 primitives (runtime-status/event-types/markdown-sections/normalize) referenced tree-wide.
- lib/viz/ — cohesive L9 second meta-agent (viz-master brain/runtime/verification/knowledge + chart-spec-schema).
- lib/control-plane/ — coherent L9 structure-snapshot/proposal-tier/share-code/chart-registry/paths/migrate (control-plane-paths inversion is deliberate + documented).
- lib/harness/ — cohesive L7 backend harness domain (23 files, zero pre-existing misplacements); only gains finding-marker-parser + review-context-builder from root.
- routes/ — cohesive HTTP face; only note is a2a.js's real concern is L1 ingress, not observability (flag on the map, no move needed).

## 4. 重排方案 (目标目录树)

> **执行状态 (Executed 2026-07 · v171/v172+)** — 本节方案已落地。Phases 1-9 + finishing round 全部 DONE：
> 已建 `dashboard/` 与 `lib/{formal-runtime,knowledge,stage,contract,routing/{dispatch,delivery,mailbox},prompt,operator,llm,security,management,delivery,session,protocol,state,agent/admin,admin/{operations,change-sets}}/`；
> `lib/capability/` 已解散并入相关目录；`state.js` 按 §4.3 建议保留在根作为 kernel entrypoint（仅挪其卫星文件）；死码 `planTaskStages` export 已删除。
> 以下原始方案文本作为记录保留。

```
watchdog/  (extension root)
├── index.js                      # plugin entry (stays — L0 entrypoint)
├── test-runner.js                # thin CLI entrypoint (stays)
├── hooks/                        # event shells (stays; see mixedConcern note)
│   ├── before-agent-start.js  before-prompt-build.js  agent-end.js
│   └── before-tool-call.js  after-tool-call.js        # heavy L3 guard bodies (flagged)
├── routes/                       # HTTP face (stays)
│   ├── api.js  dashboard.js  control-plane.js  operator-catalog.js
│   ├── admin-change-sets.js  test-runs.js
│   └── a2a.js                    # note: real concern is L1 ingress, not observability
├── shared/                       # NEW — front/back straddle vocab (served + imported by lib)
│   └── protocol-registry.js      # from repo root (L0/L1 protocol id vocab)
├── dashboard/                    # NEW — all 39 loose dashboard-*.js (+ .html/.css)
│   ├── dashboard-init.js  dashboard-nav.js  dashboard-bus.js  dashboard-i18n.js
│   ├── dashboard-common.js  dashboard-ux.js  dashboard-drag.js  dashboard-draggable-widget.js
│   ├── dashboard.js  dashboard-work-items.js  dashboard-contract-lane.js  ...
│   ├── dashboard-graph.js  dashboard-runtime-graph.js  dashboard-svg.js  dashboard-flow-visuals.js
│   ├── dashboard-workflow.js  dashboard-harness*.js  dashboard-devtools*.js
│   └── dashboard-operator.js  dashboard-knowledge.js  dashboard-charts*.js  dashboard-control-plane.js
└── lib/
    ├── index.js/state.js NO LONGER loose ── see state/ below
    ├── core/                     # KEEP (clean L0 primitives)
    │   └── runtime-status.js  event-types.js  markdown-sections.js  normalize.js
    ├── state/                    # NEW — L0 global state façade family (8 files, HIGHEST fan-in)
    │   └── state.js  state-collections.js  state-constants.js  state-file-utils.js
    │       state-paths.js  state-persistence.js  state-tool-labels.js  state-agent-helpers.js
    ├── session/                  # NEW — L0/L1 session tracking + lifecycle
    │   └── session-keys.js  session-tracking-state.js  session-bootstrap.js
    │       session-contract-binding.js  service-session.js
    ├── runtime/                  # KEEP + gains L0 signal/timing strays
    │   ├── pending-signal-registry.js  runtime-fault-evaluator.js  hard-stop-terminalize.js
    │   ├── execution-incident-store.js
    │   └── + error-ledger.js  heartbeat-gate.js  runtime-activity.js  artifact-lane-registry.js
    │       lease-manager.js  late-completion-lease.js  runtime-follow-up-lease.js
    ├── store/                    # KEEP + tool-timeline
    │   └── tracker-store.js  contract-store.js  execution-trace-store.js  state-collections wrappers…
    │       + tool-timeline.js
    ├── security/                 # NEW — L3 hard guards, pulled off root
    │   └── security.js  execution-policy-defaults.js  hard-path-autoexec.js
    │       action-marker-parser.js  + capability-preset-registry.js (from capability/)
    ├── contract/                 # NEW — L2 contract state-machine + outcome + lifecycle view
    │   └── contracts.js  contract-outcome.js  contract-lifecycle-builders.js
    │       contract-lifecycle-view.js  tracking-work-item.js  terminal-outcome.js
    ├── stage/                    # NEW — cohesive ~1500-line L2 stage subsystem
    │   └── task-stage-plan.js  task-stage-planner.js(DEAD)  stage-projection.js  stage-results.js
    │       stage-witness-engine.js  stage-marker-parser.js  runtime-stage-progress.js
    │       lifecycle-stage-truth.js  execution-observation.js  io-observation.js
    ├── prompt/                   # NEW — L4 prompt-assembly registries
    │   └── role-spec-registry.js  semantic-skill-registry.js  managed-doc-markers.js
    │       platform-doc-builder.js  platform-doc-directory.js  platform-doc-graph.js
    │       contract-session-prompt-override.js
    ├── delivery/                 # NEW — L5 produced-output / artifact plumbing (loose-root part)
    │   └── context-compression.js  runtime-contract-output-alias.js  runtime-user-facing-output.js
    ├── protocol/                 # NEW — L1 protocol primitives (backend)
    │   └── protocol-primitives.js  protocol-commit-observer.js  protocol-commit-reconcile.js
    ├── management/               # NEW — L9 read-model aggregators (split from capability/, agent/)
    │   └── management-registry-view.js  model-registry-view.js
    │       capability-registry.js  capability-management-targets.js  agent-registry-view.js
    ├── llm/                      # NEW — shared LLM client (consumed by operator + viz + health-node)
    │   └── brain-model-resolver.js  llm-planner.js
    ├── knowledge/                # NEW — L6 RAG engine hoisted out of operator/
    │   └── wiki-rag-embed.js  wiki-rag-store.js  wiki-rag-search.js  wiki-rag-rerank.js
    │       wiki-rag-judge.js  wiki-rag-eval.js  knowledge-base.js  knowledge-base-registry.js
    │       knowledge-eval-registry.js  knowledge-eval-runner.js
    ├── routing/                  # KEEP + loose-root L1 strays; internal split recommended
    │   ├── dispatch/   (10 dispatch-*.js)          # recommended nested split
    │   ├── delivery/   (13 delivery-*.js)          # replyTo return leg incl. system-action
    │   ├── mailbox/    (runtime-mailbox-*.js + runtime-authority.js)
    │   └── + route-metadata.js  runtime-direct-envelope-queue.js  runtime-workflow-semantics.js
    │        qq-reply-target.js  coordination-primitives.js  terminal-commit.js
    │        runtime-mailbox.js (from repo root)  runtime-diagnostics.js (from lifecycle/)
    ├── ingress/                  # KEEP
    ├── transport/                # KEEP + channel-notify.js  agent-reveal-file.js (from agent/)
    ├── system-action/            # KEEP + collaboration-policy.js
    ├── contracts→contract/ …
    ├── agent/                    # KEEP; gains effective-profile-composer.js, workspace-guidance-writer.js
    │   ├── admin/  (agent-admin-*.js ×11 + agent-join-*.js ×3)   # NEW nested L9 CRUD cluster
    │   └── … identity / graph / group / guidance / session-* …
    │        (loses agent-reveal-file→transport, operator-workspace-migrate→operator, agent-registry-view→management)
    ├── lifecycle/                # KEEP (agent-end/* by trigger); loses runtime-diagnostics
    ├── harness/                  # KEEP + finding-marker-parser.js  review-context-builder.js
    ├── operator/                 # KEEP L9 brain/plan/executor/snapshot; loses all RAG→knowledge/
    │   └── + operator-runtime.js  operator-fallback.js  operator-workspace-migrate.js
    ├── automation/               # KEEP (clean L8)
    ├── schedule/                 # KEEP (clean L8)
    ├── admin/                    # KEEP; recommend change-sets/ and operations/ subdirs
    │   ├── change-sets/  (admin-change-set-*.js ×7)   # NEW nested
    │   └── operations/   (admin-surface-operations.js + -graph-operations.js)  # NEW nested
    ├── capability/               # EMPTIED → merged into security/ + management/ (dir removed)
    ├── control-plane/            # KEEP
    ├── viz/                      # KEEP (clean L9)
    ├── cli-system/               # KEEP (clean L9)
    ├── formal-runtime/           # KEEP + all loose test-* orchestration files
    │   ├── checks/  (engine + probes — recommend engine/ vs probe/ split)
    │   ├── suite-*.js (recommend suites/ subdir)
    │   └── + formal-test-presets.js  test-run-suites.js  test-run-presets.js  test-run-artifacts.js
    │        test-runs.js  test-runner-cli-client.js  test-runner-terminalize.js
    │        test-timeout-policy.js  test-output-validation.js
    └── dev/                      # KEEP (system-block-registry.js — orphan-by-runtime, retained)
```

### 4.1 移动组 (move groups)

| 目标目录 | 数量 | 来源 | 理由 |
|----------|------|------|------|
| `dashboard/` | 39 | repo-root dashboard-*.js (all 39) | 39 loose UI modules — incl. the 4 largest files in the tree (devtools 1912, workflow 1440, dashboard 1332, agents 1167) — sit at the extension root intermixed with backend index.js/runtime-mailbox.js/protocol-registry.js. routes/ already pr |
| `lib/formal-runtime/` | 9 | loose lib/test-*.js + lib/formal-test-presets.js | Smell (d): the formal test system's preset single-source + suite dispatch + HTTP/CLI orchestration + report-artifact naming sit loose at lib/ root while the suites/checks/error-codes they drive all live in lib/formal-runtime/. Reunites the  |
| `lib/stage/` | 10 | stage/task-stage/execution-observation loose lib root files | A cohesive ~1500-line L2 stage subsystem (plan/planner/projection/results/witness-engine/marker-parser/progress) plus the scattered execution/io/stage observation data-models live entirely loose at lib/ root, while far smaller concerns (loo |
| `lib/contract/` | 6 | loose lib/contract*.js + terminal-outcome + tracking-work-item | The contract-* family is a cohesive L2 state-machine + outcome-judgement + lifecycle-view group sitting loose at top-level with no owning dir; a lib/contract/ subdir removes the naming-drift smell. (contract-session-prompt-override.js is L4 |
| `lib/routing/` | 7 | loose L1 routing/delivery/mailbox strays at lib root + repo-root runtime-mailbox.js | replyTo/returnContext normalization, direct-envelope FIFO transport, SEMANTIC_WORKFLOWS constants, QQ reply-target, coordination primitives, and the runtime-mailbox façade all duplicate the concern of lib/routing/ where every consumer (disp |
| `lib/prompt/` | 7 | loose L4 prompt-assembly registries at lib root | L4 prompt-assembly (role persona source, semantic-skill injection table, platform-doc builders, managed-doc markers, contract-session override) is fragmented across root; gather the assembly registries into lib/prompt/. Workspace-scoped gui |
| `lib/knowledge/` | 10 | lib/operator/wiki-rag-*.js + knowledge-base*/knowledge-eval*.js | The entire L6 RAG engine is cohesive but nested under a consumer namespace (operator/). It is generic infra (embed/store/hybrid-search/rerank/judge/eval + multi-KB registry) headed for per-agent consumption per roadmap. Hoist to lib/knowled |
| `lib/state/` | 8 | loose lib/state*.js L0 kernel family | The L0 global-state façade + constants + atomic-write/lock + persistence form one cohesive family. HIGHEST fan-in in the tree (state.js exports cfg/tracker imported almost everywhere) → move LAST with a codemod, or optionally keep state.js  |
| `lib/session/` | 5 | loose lib/session*.js + service-session.js | Session-key encode/decode, TrackingState creation, session bootstrap and contract binding are a coherent L0/L1 session-lifecycle group loose at root. |
| `lib/security/` | 5 | loose L3 guard files + capability-preset-registry | L3 hard security is scattered: sensitive-path/key checks, per-role execution-policy budgets, execFile allowlist, [ACTION] injection-hardened parser, and the capability preset table (a HARD before_tool_call guard mis-cohabiting with L9 read- |
| `lib/management/` | 5 | loose *-registry-view + capability read-models | L9 management/read-model aggregators are split three ways (root model/management-registry-view, capability/, agent/agent-registry-view). capability-registry.js alone is a 19-importer read-model shoehorned into the 'inspect 表面' module. A ded |
| `lib/delivery/` | 3 | loose L5 produced-output plumbing | L5 output/artifact plumbing at root: upstream context byte-budget, contract.output alias normalization, user-facing-vs-control-noise classification. Grouped into lib/delivery/ (name per your hint; distinct from the L1 delivery-* replyTo leg |
| `lib/protocol/` | 3 | loose lib/protocol-*.js backend primitives | protocol-* set is a naming family with no owning dir (and a repo-root protocol-registry.js sibling). The three backend primitives group into lib/protocol/; the shared front/back vocab protocol-registry.js goes to shared/ (see misplacements) |
| `lib/llm/` | 2 | loose shared LLM-client plumbing | Shared LLM client (model-chain resolver + OpenAI-compatible planner HTTP client with truncated-JSON repair) consumed by operator-brain, viz-master-brain AND health-node. A dedicated lib/llm/ decouples the shared client from the operator con |
| `lib/operator/` | 3 | loose operator entry/fallback + migrated workspace | The operator meta-agent is split: brain/plan/executor/snapshot live in lib/operator/ but the operator entry orchestrator and its invalid-plan fallback sit at lib root, and an operator-scoped workspace migration hides in agent/. Reunite with |
| `lib/agent/admin/` | 14 | lib/agent/agent-admin-*.js + agent-join-*.js | A 14-file L9 admin/join CRUD sub-cluster inside the multi-layer agent/ catch-all. These are apply-family control-plane ops; nesting under agent/admin/ separates them from the L2/L4 agent-orchestration core (identity/graph/group/guidance) wi |

### 4.2 逐文件错位 (子目录内错位, 超出松散根桶)

- `lib/agent/agent-reveal-file.js` → `lib/transport/` (L10) — Generic macOS Finder reveal OS util (whitelisted to .openclaw roots) behind /watchdog/reveal-file — dashboard/observability support, not agent-orchestration domain. Sits in transport/ beside sse.js (outward-push utilities).
- `lib/agent/operator-workspace-migrate.js` → `lib/operator/` (L4) — Operator-scoped one-time workspace dir migration (platform-operator->operator). Domain-specific to operator, a stranger to the generic agent domain.
- `lib/agent/agent-registry-view.js` → `lib/management/` (L9) — A *-registry-view read-model projection; its family (model/management-registry-view) is being consolidated into lib/management/. Currently splits the registry-view family across root and agent/.
- `lib/routing/runtime-diagnostics.js` → `lib/routing/` (L1) — Cross-L1 diagnostics normalizer (wake/delivery/system-action) consumed EXCLUSIVELY by transport/routing/system-action and by ZERO lifecycle files — not an agent_end file. Belongs with routing (plurality of consumers) or transport.
- `lib/knowledge/wiki-rag-embed.js` → `lib/knowledge/` (L6) — Pure RAG embed client (ollama). L6 infra buried under a consumer namespace; part of the 10-file RAG engine hoist.
- `lib/knowledge/wiki-rag-store.js` → `lib/knowledge/` (L6) — flat-JSON vector store + chunking + cosine/BM25-lite retrieval. Generic RAG infra, not operator-owned.
- `lib/knowledge/wiki-rag-search.js` → `lib/knowledge/` (L6) — hybrid search core (RRF + query rewrite) shared by wiki + any KB. L6 engine, not operator glue.
- `lib/knowledge/wiki-rag-rerank.js` → `lib/knowledge/` (L6) — Optional LLM listwise rerank — L6 RAG infra.
- `lib/knowledge/wiki-rag-judge.js` → `lib/knowledge/` (L6) — Local LLM-as-judge (ollama chat/json) — L6 RAG infra.
- `lib/knowledge/wiki-rag-eval.js` → `lib/knowledge/` (L6) — Pure recall@k/MRR/faithfulness eval engine consumed by tests + knowledge-eval-runner, not operator.
- `lib/knowledge/knowledge-base.js` → `lib/knowledge/` (L6) — Multi-KB registry + arbitrary-file ingestion reusing wiki-rag core; planned per-agent consumption => not operator-owned.
- `lib/knowledge/knowledge-base-registry.js` → `lib/knowledge/` (L6) — KB spec persistence (control-plane/knowledge-bases.json) — L6 infra.
- `lib/knowledge/knowledge-eval-registry.js` → `lib/knowledge/` (L6) — per-KB eval-set persistence — L6 infra.
- `lib/knowledge/knowledge-eval-runner.js` → `lib/knowledge/` (L6) — Runs recall/faithfulness per KB and stores summaries — L6 infra.
- `lib/management/capability-registry.js` → `lib/management/` (L9) — 19-importer L9 management/capability read-model aggregator mis-cohabiting with the L3 capability-preset guard. Move to lib/management/ read-model home.
- `lib/management/capability-management-targets.js` → `lib/management/` (L9) — L9 management read-model aggregator; pairs with capability-registry.js in lib/management/.
- `lib/security/capability-preset-registry.js` → `lib/security/` (L3) — A HARD per-role tool/path security preset enforced by before_tool_call — belongs with the L3 enforcement layer (security.js), not beside L9 management read-models. Its move empties lib/capability/ entirely.
- `protocol-registry.js` → `shared/` (L0/L1) — Protocol id vocab imported by BOTH the statically-served frontend (dashboard-flow-visuals) and backend lib/*. Genuine layering ambiguity — neither lib/ nor dashboard/ can cleanly own it. A shared/ (served vocab) dir formalizes the straddle instead of squatting at root intermixed with UI.
- ~~`lib/ingress/conversations.js`~~ — 已于 2026-08-19 整删（buildPriorContext 零下游消费者，跨 run 索引归 thread）。
- `lib/transport/channel-notify.js` → `lib/transport/` (L1) — QQ outbound channel sender (qqbot plugin bridge) consumed by delivery-terminal-runtime/delivery-targets; a transport channel like sse.js which already lives in lib/transport/.
- `lib/system-action/collaboration-policy.js` → `lib/system-action/` (L1) — prepareCollaborationTarget + planCollaborationSystemActionDelivery, both consumed only by system-action-runtime/request-review. Belongs with the system-action subsystem.
- `lib/effective-profile-composer.js` → `lib/agent/` (L3) — composeEffectiveProfile/Binding/CapabilityProfile merges execution-policy + capability + skills + card; every consumer lives in lib/agent/. An agent-config composer stranded at top-level.
- `lib/workspace-guidance-writer.js` → `lib/agent/` (L4) — Main managed-guidance writer (syncAgentWorkspaceGuidance); the rest of the guidance family (managed-guidance-files, agent-guidance-drift, agent-enrollment-guidance) already lives in lib/agent/.
- `lib/finding-marker-parser.js` → `lib/harness/` (L7) — Extracts [BLOCKING]/[SUGGESTION] reviewer markers into ReviewerResult-compatible findings; pairs with lib/harness/reviewer-result.js.
- `lib/review-context-builder.js` → `lib/harness/` (L7) — Assembles ReviewContext (cross-round history + guard results + artifact refs) into reviewer inbox; sibling of lib/harness/reviewer-result.js.
- `lib/error-ledger.js` → `lib/runtime/` (L0) — Global crash-pattern ledger + auto-generates error-avoidance SKILL.md; same family as lib/runtime/execution-incident-store.js, consumed by crash-recovery + before-tool-call.
- `lib/heartbeat-gate.js` → `lib/runtime/` (L0) — Passive-session actionable-work policy reading lib/runtime/pending-signal-registry.js; belongs beside it.

### 4.3 风险

"Real cost is ESM/CJS relative-import churn, not logic. ~136 file moves (82 loose lib-root + 39 dashboard + ~15 cross-subdir misplacements) each rewrite two edge sets: (a) the moved file's own relative refs to non-moved siblings (./x -> ../x or ../subdir/x), and (b) EVERY importer of the moved file (./x -> ./subdir/x). Fan-out is heavily skewed — most files have a handful of importers, but a few are catastrophic: lib/state.js (cfg/tracker) and lib/state-collections.js are imported by nearly the whole tree, so lib/state/ alone could touch 100+ import sites; contracts.js, contract-outcome.js, session-keys.js, core/* and the routing primitives are next-tier fan-in. Conservative estimate: 500-900 import-site edits across the reorg, dominated by the state/ and contract/ buckets. Secondary breakage surfaces beyond require paths: (1) leading `// lib/<oldname>.js` header comments (already drifted — must be rewritten too); (2) routes/dashboard.js static-serve paths + any <script src> for the 39 UI files; (3) package.json `files` whitelist / any glob-based loaders; (4) the 18 test-locks.js dependencies + test-report filenames + harness/test fixtures that hard-code paths; (5) protocol-registry.js dual front/back import path. Safe method: DO NOT hand-edit. Write/borrow a path-rewriting codemod (jscodeshift or a resolve-based script that reads the actual import graph) and run it PER BUCKET, never all at once. After each bucket: `node --check` all touched files, run test-runner --preset health (zero-LLM, ~5s), then the bucket's targeted suite (single/pipeline/operator/knowledge), then commit + tag vN-stable per the repo convention. Keep git mv (preserves blame). Gateway must be kickstarted to reload after backend moves. The frontend and formal-runtime buckets are near-zero-risk (self-contained sibling imports); state/ is the only bucket with genuine blast radius — isolate it as the final phase and consider leaving state.js itself at root as the kernel entrypoint (move only its satellites) to cap churn."

### 4.4 安全分期 rollout (低风险先行, state/ 最后)

- Phase 1 (near-zero risk) — dashboard/: move all 39 dashboard-*.js into dashboard/. Sibling ./ imports stay valid when moved together; only external edits are protocol-registry.js path + routes/dashboard.js static-serve + <script src>. Gate: load dashboard in browser + test-runner health. Commit+tag.
- Phase 2 (contained) — formal-runtime/: move the 9 loose test-*/formal-test-presets.js into lib/formal-runtime/. Self-contained testing subsystem. Gate: test-runner --list + health. Commit+tag.
- Phase 3 (contained) — lib/knowledge/: hoist the 10-file RAG engine out of lib/operator/. Importers are few (operator-knowledge glue + tests + inspect). Gate: test-runner --preset knowledge. Commit+tag.
- Phase 4 (moderate) — L2 buckets lib/stage/ (10) + lib/contract/ (6). Medium fan-in (contract-outcome/contracts widely used). Gate: --preset pipeline. Commit+tag after each sub-bucket.
- Phase 5 (moderate) — L1 routing strays (7) + runtime-diagnostics + conversations→ingress + channel-notify→transport + collaboration-policy→system-action. Gate: --preset single + collab. Commit+tag.
- Phase 6 (moderate) — L4 lib/prompt/ (7) + lib/operator/ entry files (operator-runtime/fallback + operator-workspace-migrate) + lib/llm/ (2). Gate: --preset operator. Commit+tag.
- Phase 7 (low-moderate) — lib/security/ (5, incl. capability-preset move) + lib/management/ (5, dissolves lib/capability/) + lib/delivery/ (3) + lib/session/ (5) + lib/protocol/ (3) + runtime/ strays + shared/protocol-registry.js. Gate: health + targeted suites. Commit+tag.
- Phase 8 (internal reorg) — nesting within existing dirs: agent/admin/ (14), admin/change-sets/ + admin/operations/, routing/{dispatch,delivery,mailbox}/. Highest internal cross-import density; do one nest at a time. Gate: --preset full. Commit+tag.
- Phase 9 (LAST, highest blast radius) — lib/state/ (8). state.js/state-collections.js fan-in is tree-wide. Codemod + node --check every file, run --preset full, manual gateway smoke. Consider leaving state.js at root and moving only satellites to cap churn. Commit+tag.
- Cross-cutting: after ALL phases, delete confirmed-dead task-stage-planner.js (with explicit approval) and fold harness-module-contract.js shim into harness-module-schema.js. Update wiki concepts/ + system.map + stale `// lib/<oldname>.js` header comments as the codemod's final pass.

## 5. 附录 — 389 文件归位清单 (按层)

> **清单时效 (2026-08-19 核对)**：本清单已随回路退役同步（删 13 条已删文件条目），并清掉 7 条 v172 之后其他工作留下的死地址、
> 修正 `runtime-mailbox.js` 的迁址。**但它已不再完整**：v172 重排后新增的 56 个源文件（`lib/archive/`、`lib/evidence/`、
> `lib/judgment/`、`lib/core/` 新增件、`lib/system-action/*-toolface.js` 族、dashboard 拆分件等）尚未归位。
> 用本清单定址时：命中的条目是准的，**没命中不等于文件不存在**，请回落到 `find` + §2 的板块表。
> **2026-08-26 补核**：L10 清单已整体换成 v233 新 SPA(`ui/`)现状（旧 dashboard-*.js 全部已删）；L0 清单补入 `lib/record-plane/`(v232)。
> L7 清单中 `lib/harness/*` 条目对应文件已随 harness 退役删除(v226)，保留为历史记录。

<details><summary><b>L0 内核·运行时</b> — 52 文件</summary>

- `hooks/agent-end.js` · Hook 事件系统
- `hooks/before-agent-start.js` · Hook 事件系统
- `hooks/before-prompt-build.js` · Hook 事件系统
- `index.js` · 插件入口与网关引导
- `lib/agent/agent-metadata.js` · Core 运行时原语
- `lib/core/event-types.js` · Core 运行时原语
- `lib/core/markdown-sections.js` · Core 运行时原语
- `lib/core/normalize.js` · Core 运行时原语
- `lib/core/runtime-status.js` · Core 运行时原语
- `lib/error-ledger.js` · Runtime 信号·故障·硬停 ⚠→`lib/runtime/`
- `lib/heartbeat-gate.js` · Runtime 信号·故障·硬停 ⚠→`lib/runtime/`
- `lib/stage/io-observation.js` · 会话追踪与会话键
- `lib/late-completion-lease.js` · 崩溃恢复·超时·终结·归档
- `lib/lease-manager.js` · 崩溃恢复·超时·终结·归档
- `lib/lifecycle/agent-end/contract-refresh.js` · agent_end 阶段编排
- `lib/lifecycle/agent-end/graph-route.js` · agent_end 阶段编排
- `lib/lifecycle/agent-end/lifecycle.js` · agent_end 阶段编排
- `lib/lifecycle/agent-end/stage-definitions.js` · agent_end 阶段编排
- `lib/lifecycle/agent-end/terminal.js` · agent_end 阶段编排
- `lib/lifecycle/agent-timeout-sweep.js` · 崩溃恢复·超时·终结·归档
- `lib/lifecycle/crash-recovery.js` · 崩溃恢复·超时·终结·归档
- `lib/lifecycle/runtime-lifecycle.js` · 崩溃恢复·超时·终结·归档
- `lib/record-plane/database.js` · 记录面 (record plane · 记账真值)
- `lib/record-plane/record-reader.js` · 记录面 (record plane · 记账真值)
- `lib/record-plane/record-writer.js` · 记录面 (record plane · 记账真值)
- `lib/record-plane/schema.sql` · 记录面 (record plane · 记账真值)
- `lib/record-plane/validate-causality.js` · 记录面 (record plane · 记账真值)
- `lib/runtime-follow-up-lease.js` · Runtime 信号·故障·硬停
- `lib/runtime/execution-incident-store.js` · Runtime 信号·故障·硬停
- `lib/runtime/hard-stop-terminalize.js` · Runtime 信号·故障·硬停
- `lib/runtime/pending-signal-registry.js` · Runtime 信号·故障·硬停
- `lib/runtime/runtime-fault-evaluator.js` · Runtime 信号·故障·硬停
- `lib/session/session-bootstrap.js` · 会话追踪与会话键
- `lib/session/session-contract-binding.js` · 会话追踪与会话键
- `lib/session/session-keys.js` · 会话追踪与会话键
- `lib/session/session-tracking-state.js` · 会话追踪与会话键
- `lib/state/state-agent-helpers.js` · 全局 state 门面与常量
- `lib/state/state-collections.js` · 全局 state 门面与常量
- `lib/state/state-constants.js` · 全局 state 门面与常量
- `lib/state/state-file-utils.js` · 全局 state 门面与常量
- `lib/state/state-paths.js` · 全局 state 门面与常量
- `lib/state/state-persistence.js` · 全局 state 门面与常量
- `lib/state/state-tool-labels.js` · 全局 state 门面与常量
- `lib/state.js` · 全局 state 门面与常量
- `lib/store/agent-card-store.js` · 内存 Store 层
- `lib/store/contract-flow-store.js` · 内存 Store 层
- `lib/store/contract-store.js` · 内存 Store 层
- `lib/store/execution-trace-store.js` · 内存 Store 层
- `lib/store/heartbeat-session-store.js` · 内存 Store 层
- `lib/store/task-history-store.js` · 内存 Store 层
- `lib/store/tracker-store.js` · 内存 Store 层
- `protocol-registry.js` · Core 运行时原语

</details>

<details><summary><b>L1 通讯·传输协议</b> — 53 文件</summary>

- `lib/transport/channel-notify.js` · Delivery 结果回传 (replyTo) ⚠→`lib/transport/`
- `lib/system-action/collaboration-policy.js` · System-action 运行时 (agent 主动平台操作) ⚠→`lib/system-action/`
- ~~`lib/ingress/conversations.js`~~ · 已删（2026-08-19）
- `lib/routing/coordination-primitives.js` · Delivery 结果回传 (replyTo) ⚠→`lib/routing/`
- `lib/ingress/before-start-ingress.js` · Ingress 外部入口 (bridge)
- `lib/ingress/dispatch-entry.js` · Ingress 外部入口 (bridge)
- `lib/ingress/dispatch-execution-contract-entry.js` · Ingress 外部入口 (bridge)
- `lib/ingress/ingress-classification.js` · Ingress 外部入口 (bridge)
- `lib/routing/runtime-diagnostics.js` · SSE 广播 + wake 唤醒 ⚠→`lib/routing/`
- `lib/protocol-commit-observer.js` · Runtime mailbox (inbox/outbox)
- `lib/protocol/protocol-commit-reconcile.js` · Runtime mailbox (inbox/outbox)
- `lib/protocol/protocol-primitives.js` · Dispatch transport 原语
- `lib/routing/qq-reply-target.js` · Delivery 结果回传 (replyTo) ⚠→`lib/routing/`
- `lib/routing/route-metadata.js` · Graph-router 内部路由 (传送带派工) ⚠→`lib/routing/`
- `lib/routing/delivery/delivery-protocols.js` · Delivery 结果回传 (replyTo)
- `lib/routing/delivery/delivery-result-extract.js` · Delivery 结果回传 (replyTo)
- `lib/routing/delivery/delivery-result.js` · Delivery 结果回传 (replyTo)
- `lib/routing/delivery/delivery-system-action-chain.js` · System-action 运行时 (agent 主动平台操作)
- `lib/routing/delivery/delivery-system-action-helpers.js` · System-action 运行时 (agent 主动平台操作)
- `lib/routing/delivery/delivery-system-action-review-verdict.js` · System-action 运行时 (agent 主动平台操作)
- `lib/routing/delivery/delivery-system-action-runtime-result.js` · System-action 运行时 (agent 主动平台操作)
- `lib/routing/delivery/delivery-system-action-ticket-route.js` · System-action 运行时 (agent 主动平台操作)
- `lib/routing/delivery/delivery-system-action-ticket.js` · System-action 运行时 (agent 主动平台操作)
- `lib/routing/delivery/delivery-system-action-transport.js` · System-action 运行时 (agent 主动平台操作)
- `lib/routing/delivery/delivery-targets.js` · Delivery 结果回传 (replyTo)
- `lib/routing/delivery/delivery-terminal-runtime.js` · Delivery 结果回传 (replyTo)
- `lib/routing/delivery/delivery-terminal.js` · Delivery 结果回传 (replyTo)
- `lib/routing/dispatch/dispatch-graph-policy.js` · Graph-router 内部路由 (传送带派工)
- `lib/routing/dispatch/dispatch-runtime-normalize.js` · Dispatch runtime state (队列真值)
- `lib/routing/dispatch/dispatch-runtime-persist.js` · Dispatch runtime state (队列真值)
- `lib/routing/dispatch/dispatch-runtime-reconcile.js` · Graph-router 内部路由 (传送带派工)
- `lib/routing/dispatch/dispatch-runtime-snapshot.js` · Dispatch runtime state (队列真值)
- `lib/routing/dispatch/dispatch-runtime-state.js` · Dispatch runtime state (队列真值)
- `lib/routing/dispatch/dispatch-transport.js` · Dispatch transport 原语
- `lib/routing/runtime-authority.js` · Delivery 结果回传 (replyTo)
- `lib/routing/mailbox/runtime-mailbox-handler-registry.js` · Runtime mailbox (inbox/outbox)
- `lib/routing/mailbox/runtime-mailbox-inbox-handlers.js` · Runtime mailbox (inbox/outbox)
- `lib/routing/mailbox/runtime-mailbox-outbox-handlers.js` · Runtime mailbox (inbox/outbox)
- `lib/routing/mailbox/runtime-mailbox-outbox-helpers.js` · Runtime mailbox (inbox/outbox)
- `lib/routing/mailbox/runtime-mailbox-outbox-reviewer-verdict.js` · Runtime mailbox (inbox/outbox)
- `lib/routing/mailbox/runtime-mailbox-transport.js` · Runtime mailbox (inbox/outbox)
- `lib/routing/runtime-direct-envelope-queue.js` · Dispatch runtime state (队列真值) ⚠→`lib/routing/`
- `lib/routing/runtime-workflow-semantics.js` · Delivery 结果回传 (replyTo) ⚠→`lib/routing/`
- `lib/session/service-session.js` · Ingress 外部入口 (bridge)
- `lib/system-action/system-action-consumer.js` · System-action 运行时 (agent 主动平台操作)
- `lib/system-action/system-action-request-review.js` · System-action 运行时 (agent 主动平台操作)
- `lib/system-action/system-action-role-policy.js` · System-action 运行时 (agent 主动平台操作)
- `lib/system-action/system-action-runtime-ledger.js` · System-action 运行时 (agent 主动平台操作)
- `lib/system-action/system-action-runtime.js` · System-action 运行时 (agent 主动平台操作)
- `lib/transport/runtime-wake-envelope.js` · SSE 广播 + wake 唤醒
- `lib/transport/runtime-wake-transport.js` · SSE 广播 + wake 唤醒
- `lib/transport/sse.js` · SSE 广播 + wake 唤醒
- `lib/routing/mailbox/runtime-mailbox.js` · Runtime mailbox (inbox/outbox)

</details>

<details><summary><b>L2 协作·编排</b> — 22 文件</summary>

- `lib/agent/agent-graph-mutations.js` · 图模型与管线边 (agent-graph)
- `lib/agent/agent-graph.js` · 图模型与管线边 (agent-graph)
- `lib/agent/agent-group-spec.js` · Agent Group 空间原语
- `lib/agent/agent-workflow-grouping.js` · Agent Group 空间原语
- `lib/agent/group-session-normalize.js` · Agent Group 空间原语
- `lib/agent/group-session-store.js` · Agent Group 空间原语
- `lib/artifact-lane-registry.js` · Contract 结局判定
- `lib/contract/contract-lifecycle-builders.js` · Contract 生命周期视图
- `lib/contract/contract-lifecycle-view.js` · Contract 生命周期视图
- `lib/contract/contracts.js` · Contract 状态机与持久化
- `lib/stage/lifecycle-stage-truth.js` · Contract 生命周期视图
- `lib/runtime/execution-hard-stop-registry.js` · 执行硬停登记处(L3 沙箱;2026-08-18 自已退役的 lib/loop/loop-detection.js 迁入)
- `lib/runtime/session-epoch-key.js` · 执行代号键(L0 运行时;2026-08-18 自已退役的 lib/loop/loop-epoch-key.js 迁入)
- `lib/stage/runtime-stage-progress.js` · Contract 生命周期视图 ⚠→`lib/stage/`
- `lib/stage/stage-marker-parser.js` · Contract 生命周期视图 ⚠→`lib/stage/`
- `lib/stage/stage-projection.js` · Contract 生命周期视图 ⚠→`lib/stage/`
- `lib/stage/stage-results.js` · Contract 生命周期视图 ⚠→`lib/stage/`
- `lib/stage/task-stage-plan.js` · Contract 生命周期视图 ⚠→`lib/stage/`
- `lib/stage/task-stage-planner.js` · Contract 生命周期视图 ⚠→`lib/stage/`
- `lib/routing/terminal-commit.js` · Contract 状态机与持久化
- `lib/contract/terminal-outcome.js` · Contract 结局判定
- `lib/contract/tracking-work-item.js` · Contract 生命周期视图

</details>

<details><summary><b>L3 Agent执行·安全沙箱</b> — 10 文件</summary>

- `hooks/after-tool-call.js` · after_tool_call 观测·预算收口
- `hooks/before-tool-call.js` · before_tool_call 复合拦截
- `lib/security/action-marker-parser.js` · [ACTION] 标记解析 (注入硬化)
- `lib/agent/agent-capability-policy.js` · 能力预设与角色工具限制
- `lib/security/capability-preset-registry.js` · 能力预设与角色工具限制
- `lib/effective-profile-composer.js` · 能力预设与角色工具限制 ⚠→`lib/agent/`
- `lib/security/execution-policy-defaults.js` · 执行策略预算默认 (per-role budget)
- `lib/security/hard-path-autoexec.js` · 安全检查 (敏感路径/密钥/写大小)
- `lib/routing/dispatch/dispatch-depth-guard.js` · dispatch 跳数守卫
- `lib/security/security.js` · 安全检查 (敏感路径/密钥/写大小)

</details>

<details><summary><b>L4 提示词装配</b> — 25 文件</summary>

- `lib/agent/agent-binding-policy.js` · role 解析入口
- `lib/agent/agent-binding-store-read.js` · role 解析入口
- `lib/agent/agent-binding-store-write.js` · role 解析入口
- `lib/agent/agent-binding-store.js` · role 解析入口
- `lib/agent/agent-card-composer.js` · role 解析入口
- `lib/agent/agent-default-skills-store.js` · role 解析入口
- `lib/agent/agent-enrollment-discovery.js` · 指引漂移检测与本地接管
- `lib/agent/agent-enrollment-guidance.js` · 指引漂移检测与本地接管
- `lib/agent/agent-enrollment.js` · 指引漂移检测与本地接管
- `lib/agent/agent-guidance-backup.js` · 指引漂移检测与本地接管
- `lib/agent/agent-guidance-drift-state.js` · 指引漂移检测与本地接管
- `lib/agent/agent-guidance-drift.js` · 指引漂移检测与本地接管
- `lib/agent/agent-identity.js` · role 解析入口
- `lib/agent/agent-registry-view.js` · role 解析入口
- `lib/agent/agent-session-system-prompt.js` · 六层装配读投影
- `lib/agent/managed-guidance-files.js` · 托管指引文件写入器 (IDENTITY/SOUL)
- `lib/agent/operator-workspace-migrate.js` · 托管指引文件写入器 (IDENTITY/SOUL) ⚠→`lib/operator/`
- `lib/prompt/contract-session-prompt-override.js` · 派工提示词手拼 (contract-session override)
- `lib/prompt/managed-doc-markers.js` · 托管指引文件写入器 (IDENTITY/SOUL)
- `lib/prompt/platform-doc-builder.js` · 托管指引文件写入器 (IDENTITY/SOUL)
- `lib/prompt/platform-doc-directory.js` · 托管指引文件写入器 (IDENTITY/SOUL)
- `lib/prompt/platform-doc-graph.js` · 托管指引文件写入器 (IDENTITY/SOUL)
- `lib/prompt/role-spec-registry.js` · role persona 注册表 (④/⑥源)
- `lib/prompt/semantic-skill-registry.js` · 语义技能注入注册表 (③skill 头)
- `lib/workspace-guidance-writer.js` · 托管指引文件写入器 (IDENTITY/SOUL) ⚠→`lib/agent/`

</details>

<details><summary><b>L5 交付·产物</b> — 5 文件</summary>

- `lib/agent/agent-session-transcript.js` · 产物包读取器 (produced-files)
- `lib/stage/execution-observation.js` · agent_end 产物落点（`preserve_artifact` 站已于 2026-08-19 退役）
- `lib/lifecycle/agent-end/transport.js` · agent_end 产物落点（`preserve_artifact` 站已于 2026-08-19 退役）
- `lib/delivery/upstream-package-inflow.js` · 上游产物整包流入 (upstream-package-inflow) ⚠2026-08-19 自 `lib/lifecycle/artifact-store.js` 改名
- `lib/delivery/runtime-user-facing-output.js` · 用户可见产出判定

</details>

<details><summary><b>L6 知识·RAG</b> — 11 文件</summary>

- `lib/knowledge/knowledge-base-registry.js` · 多知识库注册表·ingestion (KB) ⚠→`lib/knowledge/`
- `lib/knowledge/knowledge-base.js` · 多知识库注册表·ingestion (KB) ⚠→`lib/knowledge/`
- `lib/knowledge/knowledge-eval-registry.js` · per-KB 评测集·运行 (knowledge-eval) ⚠→`lib/knowledge/`
- `lib/knowledge/knowledge-eval-runner.js` · per-KB 评测集·运行 (knowledge-eval) ⚠→`lib/knowledge/`
- `lib/operator/operator-knowledge.js` · operator 消费边 (grounding)
- `lib/knowledge/wiki-rag-embed.js` · embed 客户端 ⚠→`lib/knowledge/`
- `lib/knowledge/wiki-rag-eval.js` · 召回评测引擎 (eval) ⚠→`lib/knowledge/`
- `lib/knowledge/wiki-rag-judge.js` · rerank + judge (LLM 二级) ⚠→`lib/knowledge/`
- `lib/knowledge/wiki-rag-rerank.js` · rerank + judge (LLM 二级) ⚠→`lib/knowledge/`
- `lib/knowledge/wiki-rag-search.js` · hybrid 检索·查询改写·融合 (search) ⚠→`lib/knowledge/`
- `lib/knowledge/wiki-rag-store.js` · 向量库·切分·索引 (store) ⚠→`lib/knowledge/`

</details>

<details><summary><b>L7 Harness·验证·测试</b> — 58 文件</summary>

- `lib/finding-marker-parser.js` · Run-Shape 覆盖塑形 + 评审/评估结果 ⚠→`lib/harness/`
- `lib/formal-runtime/checks/check-http.js` · Checks 探针库 + Infra + 报告
- `lib/formal-runtime/checks/check-runner.js` · CheckResult 引擎 + E-码注册表
- `lib/formal-runtime/checks/health-gateway.js` · Checks 探针库 + Infra + 报告
- `lib/formal-runtime/checks/health-node-evaluators.js` · Checks 探针库 + Infra + 报告
- `lib/formal-runtime/checks/health-node.js` · Checks 探针库 + Infra + 报告
- `lib/formal-runtime/checks/operator-probe.js` · Checks 探针库 + Infra + 报告
- `lib/formal-runtime/checks/system-action-chain.js` · Checks 探针库 + Infra + 报告
- `lib/formal-runtime/error-codes.js` · CheckResult 引擎 + E-码注册表
- `lib/formal-runtime/formal-report.js` · Checks 探针库 + Infra + 报告
- `lib/formal-runtime/infra-sse.js` · Checks 探针库 + Infra + 报告
- `lib/formal-runtime/infra-tokens.js` · Checks 探针库 + Infra + 报告
- `lib/formal-runtime/infra.js` · Checks 探针库 + Infra + 报告
- `lib/formal-runtime/suite-group.js` · Suite 驱动 (子系统探针)
- `lib/formal-runtime/suite-health.js` · Suite 驱动 (子系统探针)
- `lib/formal-runtime/suite-knowledge.js` · Suite 驱动 (子系统探针)
- `lib/formal-runtime/suite-link-cases.js` · Suite 驱动 (子系统探针)
- `lib/formal-runtime/suite-link.js` · Suite 驱动 (子系统探针)
- `lib/formal-runtime/suite-operator.js` · Suite 驱动 (子系统探针)
- `lib/formal-runtime/suite-model.js` · Suite 驱动 (子系统探针)
- `lib/formal-runtime/suite-collab.js` · Suite 驱动 (子系统探针)
- `lib/formal-runtime/suite-viz.js` · Suite 驱动 (子系统探针)
- `lib/formal-runtime/test-locks.js` · Checks 探针库 + Infra + 报告
- `lib/formal-runtime/formal-test-presets.js` · 预设 + Suite 分发 + CLI ⚠→`lib/formal-runtime/`
- `lib/harness/evaluator-result.js` · Run-Shape 覆盖塑形 + 评审/评估结果
- `lib/harness/harness-composition.js` · Harness 目录·注册表·组装校验
- `lib/harness/harness-dashboard-runs.js` · Harness 存储 + Dashboard 投影
- `lib/harness/harness-dashboard-stages.js` · Harness 存储 + Dashboard 投影
- `lib/harness/harness-dashboard.js` · Harness 存储 + Dashboard 投影
- `lib/harness/harness-evidence-vocab.js` · Harness 模块执行器 (pass/fail 判定)
- `lib/harness/harness-guard-checks.js` · Harness 模块执行器 (pass/fail 判定)
- `lib/harness/harness-guard-registry.js` · Harness 模块执行器 (pass/fail 判定)
- `lib/harness/harness-module-catalog.js` · Harness 目录·注册表·组装校验
- `lib/harness/harness-module-contract.js` · Harness Run 生命周期
- `lib/harness/harness-module-evaluators.js` · Harness 模块执行器 (pass/fail 判定)
- `lib/harness/harness-module-evidence.js` · Harness 模块执行器 (pass/fail 判定)
- `lib/harness/harness-module-runner.js` · Harness 模块执行器 (pass/fail 判定)
- `lib/harness/harness-module-schema.js` · Harness Run 生命周期
- `lib/harness/harness-registry.js` · Harness 目录·注册表·组装校验
- `lib/harness/harness-run-constants.js` · Harness Run 生命周期
- `lib/harness/harness-run-normalizers.js` · Harness Run 生命周期
- `lib/harness/harness-run-store.js` · Harness 存储 + Dashboard 投影
- `lib/harness/harness-run.js` · Harness Run 生命周期
- `lib/harness/reviewer-result.js` · Run-Shape 覆盖塑形 + 评审/评估结果
- `lib/harness/run-shape-map.js` · Run-Shape 覆盖塑形 + 评审/评估结果
- `lib/harness/soft-guidance.js` · Run-Shape 覆盖塑形 + 评审/评估结果
- `lib/harness/stage-harness.js` · Run-Shape 覆盖塑形 + 评审/评估结果
- `lib/lifecycle/agent-end/harness-recorder.js` · Harness Run 生命周期
- `lib/review-context-builder.js` · Run-Shape 覆盖塑形 + 评审/评估结果 ⚠→`lib/harness/`
- `lib/formal-runtime/test-output-validation.js` · Suite 驱动 (子系统探针)
- `lib/formal-runtime/test-run-artifacts.js` · Checks 探针库 + Infra + 报告
- `lib/formal-runtime/test-run-presets.js` · 预设 + Suite 分发 + CLI
- `lib/formal-runtime/test-run-suites.js` · 预设 + Suite 分发 + CLI
- `lib/formal-runtime/test-runner-cli-client.js` · 预设 + Suite 分发 + CLI
- `lib/formal-runtime/test-runner-terminalize.js` · 预设 + Suite 分发 + CLI
- `lib/formal-runtime/test-runs.js` · 预设 + Suite 分发 + CLI
- `lib/formal-runtime/test-timeout-policy.js` · 预设 + Suite 分发 + CLI
- `test-runner.js` · 预设 + Suite 分发 + CLI

</details>

<details><summary><b>L8 调度·自动化</b> — 19 文件</summary>

- `lib/automation/admin-helpers.js` · 自动化注册表与管理面
- `lib/automation/automation-admin.js` · 自动化注册表与管理面
- `lib/automation/automation-decision.js` · 轮次收敛与决策
- `lib/automation/automation-executor.js` · 轮次驱动/Executor
- `lib/automation/automation-finalize.js` · 轮次收敛与决策
- `lib/automation/automation-harness-lifecycle.js` · Harness 生命周期编织
- `lib/automation/automation-harness-projection.js` · 自动化运行时状态
- `lib/automation/automation-reconcile.js` · 轮次驱动/Executor
- `lib/automation/automation-registry.js` · 自动化注册表与管理面
- `lib/automation/automation-result-extractors.js` · 轮次收敛与决策
- `lib/automation/automation-runtime.js` · 自动化运行时状态
- `lib/automation/automation-skill-precipitation.js` · 治理与画像生命周期
- `lib/automation/automation-start.js` · 轮次驱动/Executor
- `lib/automation/profile-lifecycle.js` · 治理与画像生命周期
- `lib/automation/resolve-governance.js` · 治理与画像生命周期
- `lib/schedule/schedule-admin.js` · 调度注册表与管理面
- `lib/schedule/schedule-materializer.js` · Cron 物化器
- `lib/schedule/schedule-registry.js` · 调度注册表与管理面
- `lib/schedule/schedule-trigger.js` · 调度触发器

</details>

<details><summary><b>L9 控制面·元层</b> — 90 文件</summary>

- `lib/admin/change-sets/admin-change-set-commit-gate.js` · cli-system apply/verify 表面 + 所有权守卫
- `lib/admin/change-sets/admin-change-set-executor.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/change-sets/admin-change-set-history.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/change-sets/admin-change-set-management.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/change-sets/admin-change-set-preview.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/change-sets/admin-change-set-verification.js` · cli-system apply/verify 表面 + 所有权守卫
- `lib/admin/change-sets/admin-change-sets.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/admin-surface-catalog.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/operations/admin-surface-graph-operations.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/admin-surface-input-fields.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/operations/admin-surface-operations.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/admin-surface-plan-hints.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/admin-surface-registry.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/admin-surface-subject.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/catalog/agents-apply.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/catalog/apply-rest.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/catalog/inspect.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/chart-operations.js` · chart 控制面 (viz-master 唯一写者)
- `lib/admin/input-fields/agent-joins.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/input-fields/agents.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/input-fields/automation-graph.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/input-fields/chart.js` · chart 控制面 (viz-master 唯一写者)
- `lib/admin/input-fields/knowledge.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/input-fields/skills.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/plan-hints/agents.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/plan-hints/apply-rest.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/plan-hints/inspect.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/plan-hints/meta.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/runtime-admin.js` · admin-surface 操作层 (apply 落地)
- `lib/admin/skill-author.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/agent-activation-policy.js` · cli-system apply/verify 表面 + 所有权守卫
- `lib/agent/admin/agent-admin-agent-operations.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/admin/agent-admin-card-operations.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/admin/agent-admin-config.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/admin/agent-admin-context.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/admin/agent-admin-create-delete.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/admin/agent-admin-default-operations.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/admin/agent-admin-defaults.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/admin/agent-admin-policies.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/admin/agent-admin-profile.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/admin/agent-admin-store.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/agent-admin.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/admin/agent-join-admin.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/admin/agent-join-registry.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/admin/agent-join-spec.js` · admin-surface 操作层 (apply 落地)
- `lib/agent/agent-plane-policy.js` · cli-system apply/verify 表面 + 所有权守卫
- `lib/agent/agent-session-store.js` · cli-system inspect 表面 (零旁路读)
- `lib/llm/brain-model-resolver.js` · operator 大脑 (元 agent 规划) ⚠→`lib/operator/`
- `lib/management/capability-management-targets.js` · cli-system inspect 表面 (零旁路读)
- `lib/management/capability-registry.js` · cli-system inspect 表面 (零旁路读)
- `lib/cli-system/cli-graph-inspector.js` · cli-system inspect 表面 (零旁路读)
- `lib/cli-system/cli-runtime-inspector.js` · cli-system inspect 表面 (零旁路读)
- `lib/cli-system/cli-surface-catalog.js` · cli-system inspect 表面 (零旁路读)
- `lib/cli-system/cli-surface-display.js` · cli-system inspect 表面 (零旁路读)
- `lib/cli-system/cli-surface-executor.js` · cli-system apply/verify 表面 + 所有权守卫
- `lib/cli-system/cli-surface-inspector.js` · cli-system inspect 表面 (零旁路读)
- `lib/cli-system/cli-surface-payload.js` · cli-system apply/verify 表面 + 所有权守卫
- `lib/cli-system/cli-surface-registry.js` · cli-system inspect 表面 (零旁路读)
- `lib/cli-system/cli-surface-schema.js` · cli-system inspect 表面 (零旁路读)
- `lib/cli-system/cli-surface-verify-gate.js` · cli-system apply/verify 表面 + 所有权守卫
- `lib/cli-system/meta-agent-surface-ownership.js` · cli-system apply/verify 表面 + 所有权守卫
- `lib/control-plane/chart-registry.js` · chart 控制面 (viz-master 唯一写者)
- `lib/control-plane/control-plane-migrate.js` · structure-snapshot 回滚地基
- `lib/control-plane/control-plane-paths.js` · structure-snapshot 回滚地基
- `lib/control-plane/proposal-tier.js` · structure-snapshot 回滚地基
- `lib/control-plane/structure-share-code.js` · structure-snapshot 回滚地基
- `lib/control-plane/structure-snapshot.js` · structure-snapshot 回滚地基
- `lib/dev/system-block-registry.js` · cli-system inspect 表面 (零旁路读)
- `lib/llm/llm-planner.js` · operator 大脑 (元 agent 规划) ⚠→`lib/operator/`
- `lib/management/management-registry-view.js` · cli-system inspect 表面 (零旁路读)
- `lib/management/model-registry-view.js` · cli-system inspect 表面 (零旁路读)
- `lib/operator/operator-fallback.js` · operator 大脑 (元 agent 规划) ⚠→`lib/operator/`
- `lib/operator/operator-runtime.js` · operator 执行器 (原子应用+元→元委派) ⚠→`lib/operator/`
- `lib/operator/operator-auto-propose.js` · operator 大脑 (元 agent 规划)
- `lib/operator/operator-brain.js` · operator 大脑 (元 agent 规划)
- `lib/operator/operator-context.js` · operator 大脑 (元 agent 规划)
- `lib/operator/operator-executor.js` · operator 执行器 (原子应用+元→元委派)
- `lib/operator/operator-harness-recommend.js` · operator 大脑 (元 agent 规划)
- `lib/operator/operator-plan.js` · operator 大脑 (元 agent 规划)
- `lib/operator/operator-snapshot-draft-relations.js` · operator 大脑 (元 agent 规划)
- `lib/operator/operator-snapshot-runtime.js` · operator 大脑 (元 agent 规划)
- `lib/operator/operator-snapshot-summarizers.js` · operator 大脑 (元 agent 规划)
- `lib/operator/operator-snapshot-tests.js` · operator 大脑 (元 agent 规划)
- `lib/operator/operator-snapshot.js` · operator 大脑 (元 agent 规划)
- `lib/operator/operator-surface-policy.js` · operator 执行器 (原子应用+元→元委派)
- `lib/viz/chart-spec-schema.js` · viz-master (第 2 meta-agent)
- `lib/viz/chart-verification.js` · viz-master (第 2 meta-agent)
- `lib/viz/viz-master-brain.js` · viz-master (第 2 meta-agent)
- `lib/viz/viz-master-knowledge.js` · viz-master (第 2 meta-agent)
- `lib/viz/viz-master-runtime.js` · viz-master (第 2 meta-agent)

</details>

<details><summary><b>L10 观测·前端</b> — 36 文件（v233 换代：旧 dashboard-*.js 40 条已整删，本清单为新 SPA `ui/` 现状）</summary>

- `ui/app.js` · SPA 壳·路由·store·i18n
- `ui/core/api.js` · SPA 壳·路由·store·i18n
- `ui/core/html.js` · SPA 壳·路由·store·i18n
- `ui/core/i18n-keys.js` · SPA 壳·路由·store·i18n
- `ui/core/i18n.js` · SPA 壳·路由·store·i18n
- `ui/core/router.js` · SPA 壳·路由·store·i18n
- `ui/core/store.js` · SPA 壳·路由·store·i18n
- `ui/components/graph-board.js` · 指挥台 (command)
- `ui/components/pulse-column.js` · 指挥台 (command)
- `ui/components/stat-strip.js` · 指挥台 (command)
- `ui/components/work-item-list.js` · 指挥台 (command)
- `ui/components/output-panel.js` · 透视页 (inspect)
- `ui/components/prompt-layers.js` · 透视页 (inspect)
- `ui/components/run-timeline.js` · 透视页 (inspect)
- `ui/components/thread-tree.js` · 透视页 (inspect)
- `ui/pages/command/command-page.js` · 指挥台 (command)
- `ui/pages/command/graph-board-controller.js` · 指挥台 (command)
- `ui/pages/command/index.js` · 指挥台 (command)
- `ui/pages/inspect/index.js` · 透视页 (inspect)
- `ui/pages/inspect/inspect-page.js` · 透视页 (inspect)
- `ui/pages/manage/agents.js` · 管理区 (manage) 五子页
- `ui/pages/manage/charts.js` · 管理区 (manage) 五子页
- `ui/pages/manage/control-plane.js` · 管理区 (manage) 五子页
- `ui/pages/manage/devtools.js` · 管理区 (manage) 五子页
- `ui/pages/manage/index.js` · 管理区 (manage) 五子页
- `ui/pages/manage/knowledge.js` · 管理区 (manage) 五子页
- `lib/agent/agent-reveal-file.js` · Routes·HTTP 观测面 ⚠→`lib/transport/`
- `lib/runtime-activity.js` · 观测视图模型（工作项/时间线数据源）
- `lib/tool-timeline.js` · 观测视图模型（工作项/时间线数据源）
- `routes/a2a.js` · Routes·HTTP 观测面
- `routes/admin-change-sets.js` · Routes·HTTP 观测面
- `routes/api.js` · Routes·HTTP 观测面
- `routes/control-plane.js` · Routes·HTTP 观测面
- `routes/dashboard.js` · Routes·HTTP 观测面
- `routes/operator-catalog.js` · Routes·HTTP 观测面
- `routes/test-runs.js` · Routes·HTTP 观测面

</details>

---
_生成: 多 agent 全库映射 (taxonomy 12-agent + classify/reorg 15-agent). 原始基线 409 源文件全归位, 79 flag 错位, 16 move 组, 10 阶段 rollout；2026-08-19 随回路退役复核后清单为 389 条 + 56 个 v172 后新增文件待归位。_