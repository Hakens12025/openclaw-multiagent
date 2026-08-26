# 四件重做 · 统一计划(单一版本)

> 骨架取 **platform-truth**(默认极性反转 + 单一构造器冻结 + import 闭包拔除测试),嫁接 **minimal-mechanism** 的单向格判定形状、`ROUND_BRAND` 封印、`openedBy` 一等字段、合约参数化质量阈值、schema 冻结测试,嫁接 **declaration-first** 的 7 行判据表、L3 文件劈分、`via` 一等字段、`reviewMirror` 有债主兼容镜像。
> 两名评委共同指出的 9 个缺口全部在本计划里补齐并标注。**本轮未修改任何文件。**

---

## 〇、一句话:重做后的系统怎么判「这一轮算不算数」

**平台在盘上亲眼看到本轮新写的、非空的、非控制载荷的产物 —— 这是唯一能把结论抬到「算数」的输入;这个抬升在会话被中断且 agent 一句话没说时失效;而 agent 显式声明 `failed`/`awaiting_input`/`hold` 可以把结论拉回「不算数」,永远不能反向把它抬起来。**

一个纯函数 `decideRound(facts)` 回答这句话,全系统只有它一处回答,四件全部退化成它的调用者或投影。

---

## 一、概念与真值

### 1.1 四个概念(3 承重 + 1 降级为非真值物)

| 概念 | 拥有什么真值 | 一句话定义 | 它**不**管什么 |
|---|---|---|---|
| **RoundLedger 轮次台账**<br>`lib/round/round-ledger.js` | **本轮在进程内发生过什么** | 内存、同步、O(1)、按 `epochKey` 键;三个平台自证写入口(工具调用/中断/采集)+ 一个 agent 自报写入口(声明)。 | 不读盘、不下结论、不知道「算不算数」 |
| **RoundFacts 轮次事实**<br>`lib/round/round-facts.js` | **本轮的全部可验证事实** | 唯一构造点、一次构造、`Object.freeze` + `ROUND_BRAND` 封印、全链传同一引用;把台账 + FS 取证 + 合约快照 + 框架 event 合成一个不可变对象。 | 不下结论;不吸 L3 的阶段结构字段(见 1.3) |
| **RoundDecision 轮次结论**<br>`lib/round/round-decide.js` | **「这一轮算不算数」这唯一一个问题的答案** | 对 sealed RoundFacts 的**纯同步纯函数**:零 IO、零 await、零 logger、零 contract 参数。 | 不管往哪儿转发、不管质量好坏、不管要不要重试 |
| ~~RoundLog~~ **SessionAuditLog 事后账**<br>`lib/audit/session-audit-log.js` | **不拥有任何真值** | 异步文件、对自身失败沉默、只供事故复盘 + harness 取证 + health 抽样。 | 执行面**禁止 import**(boundary 测试机器化) |

**为什么是 3 不是 4:** 「交接门」问的「本环有没有干活」与 `decision.counts` 是同一个问题的两个答案 —— 这就是病本身,修好它等于再造一次重复判定。「熔断」不是判据,是**时机**。两者双双退化成对 `decision` 的一次读。

**为什么 declaration 不单列为概念:** 它没有独立真值。「agent 调了 `submit_output(failed)`」是平台亲眼看见的一次工具调用,与「盘上有个 12KB 的 md」同属事实,区别只在**可信度权重**,而权重属于判定规则,不属于概念划分。单列它必然重建「两个谓词判同一件事」。

### 1.2 今天的四件 → 重做后的去向

| 今天 | 位置 | 去向 |
|---|---|---|
| ① 终态收敛 `evaluateContractOutcome` | `lib/contract/contract-outcome.js`(287 行) | **删除**,合并进 `decideRound` + `projectDecisionToTerminal` |
| ① 终态归一 `normalizeTerminalOutcome` | `lib/contract/terminal-outcome.js`(85 行) | **重写 schema**:13 字段 → 10 字段(含 `reviewMirror`) |
| ② 交接门 `resolveIncompleteHandoffGate` + `runHandoffGate` + `MIN_HANDOFF_OUTPUT_CHARS` | `lib/lifecycle/agent-end-graph-route.js:128,151-173,175-229,399,538,550,570` | **整体删除,不重建为门**;转发前置条件改为 `decision.counts === true` |
| ③ 熔断判据 `resolveAuthoritativeHardStopOutcome` + `buildHardStopTerminalOutcome` + 两份 `summaryByReason` | `lib/runtime/hard-stop-terminalize.js:20-38,77-108` + `agent-end-graph-route.js:84-118` | **判据全删,只留触发器**;与 agent_end 走同一个 `settleAndCommitRound` |
| ④ 内存投影 `session-progress-projection.js` | `lib/evidence/` | **删除**,承重内容(3 字段)并入 RoundLedger;`clearLoopSession` 连坐显式搬迁 |
| ④ 文件账本 `session-trace-store.js` | `lib/evidence/` | **改名搬家 `lib/audit/session-audit-log.js`**,内核一行不改,降级为非真值物,执行面读者清零 |
| ⑤(第五个分身)crash-recovery ABANDONED / timeout-sweep / recoverOrphanedContracts | `lib/lifecycle/crash-recovery.js:170-200,299`、`agent-timeout-sweep.js:91` | **并入同一判定**:三者都先 `settleAndCommitRound`,`ABANDONED` 降级为「`counts===false` 且重试耗尽」的投影 |

### 1.3 一刀:`outbox/runtime_result.json` 劈成两半(取自 declaration-first)

今天这个文件同时装两样东西,是 L1/L3「同构梯子」错觉的根源:

```
outbox/runtime_result.json
  ├─ status / summary / reason        → RoundDeclaration  (结算读)
  └─ artifacts[] / completion.transition / stagePlanRevision
     / semanticStageId / metadata     → StageHints        (阶段子系统读,结算不读)
```

**结算只从 L3 吸走 `status`/`summary`/`reason` 三项**,其余原样留给 `agent-end-stage-advance.js:35-78`、`task-stage-truth.js:107-108`、`io-observation.js:119-121`。
劈开后梯子才成立:**声明面** L1 > L3;**阶段结构面**只有 L3(L1 本来就表达不了)。
`artifacts[].path` 作为**路径线索**进入取证器的候选集,但存在性/合格性仍由平台 stat —— 这解决了 platform-truth 里 `expectations[].source` 含 `stage_declared_artifact` 与「L3 只吸 status」自相矛盾的那一处。

---

## 二、接口规格

标注约定:**【自证】** = 平台可自证事实,**【自报】** = agent 自报,**【派生】** = 由前两者算出。

### 2.1 `lib/round/round-ledger.js` (~120 行)

```js
export const ROUND_OPENED_BY = Object.freeze(["session_start", "declaration", "collection", "recovery"]);

/** 开账。同一 epochKey 重复开 → 返回既有记录(不重置)。 */
export function openRound({ epochKey, sessionKey, agentId, contractId, startedAt, openedBy }) -> LedgerRecord | null

// —— 平台自证写入面(3 个)——
export function noteToolCall(epochKey, { tool, targetPath, ok }) -> boolean      // 【自证】
export function noteHalt(epochKey, { kind, reason }) -> boolean                   // 【自证】
   // kind ∈ "hard_stop" | "timeout" | "crash" | "orphan"   —— 无 "none";未调用即未中断
export function noteCollection(epochKey, { files, artifactPaths, error }) -> boolean  // 【自证】

// —— agent 自报写入面(唯一 1 个,调用点恰好 2 处)——
export function recordDeclaration(epochKey, { status, summary, reason, via }) -> {
  accepted: boolean, superseded: boolean, error: string | null
}                                                                                 // 【自报】
   // 调用点 1: lib/system-action/platform-service-toolface.js 的 submit_output execute (via:"tool")
   // 调用点 2: 采集侧成功解析 outbox/runtime_result.json 的声明半边       (via:"file")
   // 本模块是 RoundDeclaration 的唯一构造点。禁止任何默认值、fallback 链、`|| "completed"`。

export function readRound(epochKey) -> LedgerRecord | null   // 同步 O(1),未开账返回 null
export function closeRound(epochKey) -> boolean              // 清账,**必须连坐 clearLoopSession**(活语义)
export function closeAllRounds() -> number
```

`LedgerRecord` 形状(无任何默认值,缺席就是缺席):

```js
{
  epochKey, sessionKey, agentId, contractId, startedAt,
  openedBy: "session_start" | "declaration" | "collection" | "recovery",   // 一等字段,不是 null 语义
  toolCalls: 0, writes: 0,
  outputCommitted: false,        // 写落点 includes contract.output(承重语义,勿改成 ===)
  lastWritePath: null,
  halt: null | { kind, reason, at },
  collection: null | { files, artifactPaths, error, at },
  declaration: null | { status, summary, reason, via, at, superseded },   // null ≡ agent 本轮什么都没说
}
```

**`openedBy` 的用途(取自 minimal-mechanism,替代今天「返回 null 让调用方各自退化」):**
`openedBy !== "session_start"` 的轮次错过了前半程,**`outputCommitted:false` 不得被采信**。这条规则写进 `captureRoundFacts`,不写进散文。

### 2.2 `lib/round/round-declaration.js` (~90 行)

```js
export const DECLARABLE_STATUSES = Object.freeze(["completed", "failed", "awaiting_input", "hold"]);

/** 总函数。非法输入 → null。永不返回 agent 没产生过的值。 */
export function normalizeDeclaration(raw, { via }) -> RoundDeclaration | null   // 【自报】

/** 从 L3 文件劈出声明半边 + 阶段线索半边。解析失败只丢它自己,不牵连整轮。 */
export async function readDeclarationFile(outboxDir) -> Promise<{
  declaration: RoundDeclaration | null,   // via:"file"
  stageHints:  StageHints | null,
  unusable:    string | null,
}>
```

```js
// RoundDeclaration —— via 是归一化函数正式承认的一等字段,不是搭在返回对象上的临时布尔
{ status, summary: string|null, reason: string|null, via: "tool"|"file", at: number, superseded: boolean }
```

> **反面教材(必须写进模块头):** `explicitRuntimeResult` 由 `runtime-mailbox-outbox-helpers.js:434` 写出并配了大段注释解释它为什么不会恒真,但 `normalizeExecutionObservation` 的白名单键表(`execution-observation.js:84-107`)里没有这个键,过一层归一就被吃掉 → `hard-stop-terminalize.js:99` 的第一个析取项**恒假**,第二个恒真。provenance 必须进正式字段表。

### 2.3 `lib/round/artifact-evidence.js` (~150 行)—— 全系统唯一取证器

```js
/** 【自证】唯一的产物新鲜度/非空/控制载荷/阈值实现。今天有 7 份。 */
export async function inspectArtifactEvidence({
  candidatePaths,   // string[]  outbox 采集结果 ∪ StageHints.artifacts[].path(仅作候选)
  requirements,     // Requirement[]  见下
  sessionStartMs,   // number|null   null → fail-open(不冤枉本轮产物),并在 checked[] 标 baseline:"none"
}) -> Promise<{
  ok: boolean,
  qualifying: string[],
  primaryPath: string | null,        // 唯一合格文件直接用;多个 → 只有当某个命中 requirement.label==="contract.output" 时取它,否则 null(不猜「第一个 .md」)
  checked: [{ path, label, ok, reason }],   // reason ∈ "missing"|"not_a_file"|"empty"|"under_min_bytes"|"stale"|"control_payload:<class>"|"missing_json_path:<p>"
}>

export async function isFreshForSession(path, sessionStartMs) -> boolean
```

**Requirement 形状(质量阈值合约参数化,取自 minimal-mechanism):**

```js
{ path, label, nonEmpty: true, semanticText: true, minBytes: 0, jsonPaths: [] }
```

`buildRequirements(contract)`:
1. `completionCriteria.requiredFiles` 非空 → 逐条转成 Requirement(**新增支持 `minBytes`**,今天 `inspectArtifact` 已支持 `nonEmpty`/`semanticText`/`jsonPaths` 三档,只差它);
2. 否则 `contract.output` 存在 → 单条 `{path: contract.output, label:"contract.output", nonEmpty:true, semanticText:true}`;
3. 否则空数组 → `ok` = 「候选集里至少一个新鲜 + 非空 + 非控制载荷的文件」。

控制载荷分类**继续复用** `classifyRuntimeControlPayload`(`lib/delivery/runtime-user-facing-output.js`)—— 77af649 已经为「两套分类器」付过学费,不重写。

**魔数 24 删除,不引入任何替代常量。** 「够不够长」由派工方在 `completionCriteria` 里显式声明 `minBytes`;平台默认只判形式(新鲜 · 非空 · 非控制载荷)。

### 2.4 `lib/round/round-facts.js` (~240 行)—— 唯一构造点

```js
export const ROUND_BRAND = Symbol.for("watchdog.round.sealed");

/**
 * 唯一构造 + 封印。只做观测与取证,不出现 completed/failed 字样。
 * 返回值 deep-freeze 并打 ROUND_BRAND;全链传同一引用,**不存在第二层 normalize**。
 */
export async function captureRoundFacts({
  epochKey, sessionKey, agentId,
  contract,          // 合约快照(读 output / completionCriteria);为 null 时见「无合约腿」
  outboxDir,
  event,             // 框架 agent_end event(success/error);热路径熔断传 null
  logger,
}) -> Promise<SealedRoundFacts>

export function assertSealed(facts) -> void      // 非本模块产物 → throw
export function summarizeMisses(facts) -> string // 中文可读,给 message 用
```

```js
SealedRoundFacts = Object.freeze({
  [ROUND_BRAND]: true,
  version: 1,
  epochKey, sessionKey, agentId, contractId: string|null,
  managed: boolean,                 // contractId 非空 ⇔ 本轮受合约管理

  // ── 【自证】盘上事实
  baseline: { ms: number|null, source: "session_start"|"contract_created_at"|"outbox_mtime"|"none" },
  evidence: { ok, qualifying, primaryPath, checked },     // inspectArtifactEvidence 的结果,原样嵌入

  // ── 【自证】进程内事实(来自 RoundLedger)
  live: { openedBy, outputCommittedTrusted: boolean|null, toolCalls, writes, lastWritePath },
     // outputCommittedTrusted: openedBy==="session_start" ? outputCommitted : null(不采信 false)

  // ── 【自证】中断事实。**由本模块从平台源派生,禁止调用方独立传两个字段**
  halt: { kind: "none"|"hard_stop"|"timeout"|"crash"|"orphan", reason: string|null },
     // 派生源:ledger.halt(loop-detection 硬停标记/巡检时钟) ∪ (event && event.success===false → "crash")
     // halted 谓词 = halt.kind !== "none",不允许存在独立的 halted 布尔

  // ── 【自报】缺席就是 null,平台永不代填
  declaration: RoundDeclaration | null,     // L1 台账优先;为空时读 L3 文件的声明半边
  stageHints: StageHints | null,            // 只透传给阶段子系统,decideRound 不读

  capturedAt: number,
})
```

**错误语义:** 本函数**不抛、不返回 null**。任何 IO 失败 → `evidence.ok=false` + `checked[]` 里一条 `reason:"missing"` 记录 + `logger.warn`。

**无合约腿(评委共同缺口 #2):** `contract === null` 时,`managed:false`。**`decideRound` 不被调用,不产生任何终态,不改任何投递** —— 没有合约就没有合约可以关闭。纯对话腿、无 replyTo 腿走这一条,`closeRound` 直接清账。必须有单测锁。

### 2.5 `lib/round/round-decide.js` (~130 行)—— 纯同步唯一裁定者

```js
export const BASIS = Object.freeze([
  "declared_failed", "declared_awaiting", "declared_verified",
  "claimed_without_deliverable", "inferred_from_deliverable",
  "halted_before_declaration", "stopped_short", "no_deliverable",
]);

/** 纯同步 · 纯函数 · 总函数 · 零 IO · 零 await · 零 logger · 零 contract。 */
export function decideRound(facts) -> RoundDecision
```

```js
// RoundDecision —— 恰好 9 键(schema 冻结测试盯着它,多一个少一个都红)
Object.freeze({
  version: 1,
  counts: boolean,                                   // ← 唯一的收敛真值,无三态
  status: "completed" | "failed" | "awaiting_input",
  basis: <BASIS 之一>,                               // 与 §三 判定表 8 行 1:1
  closure: "verified" | "declared_stop" | "hard_stopped" | "timed_out" | "crashed" | "no_evidence",
  reason: string,     // 机器码 === basis。**永不进用户文案**
  message: string,    // 中文、非空、面向用户。**永远必填,缺失即抛**
  evidence: { primaryPath, qualifying, checked, baselineSource },
  declaration: RoundDeclaration | null,              // 原样回显,含 via
})
```

**没有** `verdict` / `score` / `testsPassed`(判决语汇)、**没有** `retryable`(0 行为读者,「打回重做已作废」的代码侧铁证)、**没有** `actionType`(全库 0 读者)、**没有** `source`(被 `basis` + `declaration.via` 取代)。**字段位不存在 = 判决语汇想骑回来也没鞍**,而不是「置 null 后静默变空」。

`import` 白名单:`{ ./round-copy.js }`。零其它 import。

### 2.6 `lib/round/round-copy.js` (~70 行)

```js
export function buildMessage(basis, facts) -> string   // 中文,必非空
export function buildClarification(basis, facts) -> string | null   // 仅 awaiting_input 非空
```

一张 `basis → 中文文案` 表。`decideRound` 内部强制 `reason` 与 `message` 双填,填不出就抛。这把 `tests/delivery-terminal-runtime-copy.test.js:86/132` 那条行为锁从「靠人记得填 summary」变成「填不了就抛」,并从第一天就把机器码与用户文案分成两个字段(今天 `agent-end-graph-route.js:130-146` 是一句话两用)。

### 2.7 `lib/round/round-terminal.js` (~110 行)—— 唯一收口

```js
/** 全系统唯一写 contract.status + terminalOutcome 的入口。调用点恰好 3 个。 */
export async function settleAndCommitRound({
  epochKey, sessionKey, agentId, trackingState, contractData, outboxDir, event, api, logger,
}) -> Promise<{ decision: RoundDecision | null, committed: boolean, unmanaged: boolean }>

export function projectDecisionToTerminal(decision, { reviewSignal }) -> TerminalOutcome
```

内部固定五步:`captureRoundFacts` → (`managed===false` ? 直接返回 `{unmanaged:true}`) → `decideRound` → `projectDecisionToTerminal` → `commitSemanticTerminalState`。

三个调用点:
1. `hooks/agent-end` 主链的 `settle_round` stage
2. `hooks/after-tool-call.js` 硬停触发器
3. 恢复巡检(`crash-recovery` / `agent-timeout-sweep` / `recoverOrphanedContracts`)

今天是 **9 处独立产出终态字面量**。

### 2.8 `lib/contract/reviewer-signal.js` (~70 行)—— 判决语汇的新家(补评委共同缺口 #1、#2)

```js
/** 评审信号的唯一读取器。含从 contract-outcome.js:135-149 搬家过来的 deriveTestsPassed。 */
export function resolveReviewSignal(executionObservation) -> {
  verdict: string|null, score: number|null, testsPassed: boolean|null
}
```

**为什么必须搬而不是删:** `terminalOutcome.testsPassed` **不是** `reviewerResult.testsPassed` 的拷贝,是 `contract-outcome.js:135-149` 的派生 —— reviewer 只报了 verdict 没报 testsPassed 时,今天由 `verdict==="pass"|"improved" → true` 补出来。三份原设计同时「删派生函数 + 下游改读 reviewerResult」,合起来的效果正是它们自己在批判的「静默变空白」。

**迁移目标统一为 `contract.executionObservation.reviewerResult`**(与 `contract-outcome.js:155` 的真源头一致),**不是** `contract.reviewerResult` —— 后者只有两个条件性写点(`agent-end-stage-definitions.js:267` 仅当 marker 真提到 findings;`delivery-system-action-review-verdict.js:175` 仅评审车道),在非评审腿会丢数据。

### 2.9 `lib/contract/terminal-outcome.js`(重写 schema,~90 行)

```js
TerminalOutcome = {                     // 恰好 10 键
  version, status, basis, closure, reason, summary, clarification, artifact, declaredVia,
  reviewMirror: { verdict, score, testsPassed } | null,
}
```

`reviewMirror` = **显式命名、有债主、有删除条件**的兼容镜像(取自 declaration-first),由 `projectDecisionToTerminal` 从 `resolveReviewSignal` 复制,**不经过 `decideRound`** —— 焊点已断,只剩一根有主的兼容线。
债主:harness 重做批。删除条件:`harness-module-evidence.js:236,254` 改读 `resolveReviewSignal`。

---

## 三、判据

### 3.1 输入分级与自解释性论证

| 级 | 输入 | 性质 | 权力 | **为什么它自解释(防漂移)** |
|---|---|---|---|---|
| **A** | `facts.evidence.ok` | **平台自证** | **唯一能把结论抬到「算数」的输入** | 由 `inspectArtifactEvidence` 当场 stat + readFile 现算,**不读任何上游结构体的存在性**。上游无论怎么改默认填充,都改不了「盘上有没有这个文件」 |
| **B** | `facts.halt.kind !== "none"` | **平台自证** | 在**无声明**时使 A 的抬升**失效**(不是减损) | `halt` 由 `captureRoundFacts` 从平台源派生,`halted` 永远 `=== kind !== "none"`,**不存在可被独立赋值的 halted 布尔**。这是对 declaration-first「halt 由调用方传参」那条新漂移线的修正 |
| **C** | `facts.declaration.status` | **agent 自报** | **单向减损**:`failed`/`awaiting_input`/`hold` 把结论拉回「不算数」;`completed` 只解除 B 的歧义,**永不能把「无产物」抬成「算数」** | 唯一构造点 `recordDeclaration`,调用点恰好 2 处,**无默认值、无 fallback 链**。缺席即 `null`,平台没有位置可填 |
| — | `live.outputCommittedTrusted` | 平台自证但覆盖不全 | **只决定「要不要现在去看盘」(defer),不参与结论** | `openedBy !== "session_start"` 时为 `null`,读者不得当 `false` |
| — | `toolCalls` / `writes` | 平台自证 | 只喂告警,不参与结论 | — |

**不作为输入的:** `_hardPathResult`(全库无生产者)、`[ACTION]` 标记(失败轮次恒哑,`extract_output_markers` 的 match 条件是 `event.success===true`)、`session-audit-log` 文件账(异步且对失败沉默)、`contract.expectations`(留给判决面下针)、`reviewerResult`/`verdict`/`score`/`testsPassed`(判决语汇,`decideRound` 的类型里没有它们的位置)。

### 3.2 完整判定表(8 行,穷举 5 × 2 × 2 = 20 种输入组合)

设 `D = facts.declaration?.status`(null | completed | failed | awaiting_input | hold),`E = facts.evidence.ok`,`H = facts.halt.kind !== "none"`。

| # | D | E | H | counts | status | basis | closure |
|---|---|---|---|---|---|---|---|
| 1 | `failed` | * | * | **false** | FAILED | `declared_failed` | `declared_stop` |
| 2 | `awaiting_input` / `hold` | * | * | **false** | AWAITING_INPUT | `declared_awaiting` | `declared_stop` |
| 3 | `completed` | true | * | **true** | COMPLETED | `declared_verified` | `verified` |
| 4 | `completed` | false | * | **false** | FAILED | `claimed_without_deliverable` | `no_evidence` |
| 5 | null | true | false | **true** | COMPLETED | `inferred_from_deliverable` | `verified` |
| 6 | null | true | **true** | **false** | FAILED | `halted_before_declaration` | H 的 kind 映射 |
| 7 | null | false | **true** | **false** | FAILED | `stopped_short` | H 的 kind 映射 |
| 8 | null | false | false | **false** | FAILED | `no_deliverable` | `no_evidence` |

`closure` 的 kind 映射:`hard_stop → hard_stopped`,`timeout → timed_out`,`crash|orphan → crashed`。

### 3.3 冲突裁决与默认值

**默认极性(骨架的核心,取自 platform-truth):** `counts` 的默认是 **`false`**。只有 A 能把它翻成 `true`。
→ **一个默认不放行的判据没有弃权谓词可以死。** 今天交接门死于 `hasProtocolSemanticPayload` 恒真弃权;新判据结构上不存在弃权谓词。

**冲突不可能发生(单向格,取自 minimal-mechanism):** A 是唯一的抬升向量,B/C 都只能往「不算数」投。`counts` 是所有向量的**合取**,与顺序无关 —— **没有优先级表,就没有优先级可以漂移**。今天 `agent-end-terminal.js:224-247` 那种「四路抢答、谁先短路谁赢」被整个取消。

`basis` 的选择只是**标签读出顺序**(声明 > 中断 > 无证据),它**不可能改变 `counts`** —— 因为凡是能进入标签竞争的行,`counts` 都已相同。这条要写进模块头。

**行 3 与行 6 的关系(为什么保留 `completed` 可声明):**
`tests/hard-stop-terminalize.test.js:56-91` 是一条 **95 行的活行为锁**(实证:当场新建 6 字节 `answer.md` 作为 `contract.output`,标记硬停,断言 `FAILED` + `source:"loop_runtime"`)。三份原设计的作废清单里**一条都没有申报它**,而 platform-truth 的 L-2 与 minimal-mechanism 的 `settle.hardstop-with-output` 都会把它翻红。
行 6 保住这条锁:**中断 + agent 一句话没说 → 产物证据的含义不确定(它可能是半成品),抬升失效。**
行 3 保留今天的逃生口:**agent 显式说完成 → 歧义解除,抬升生效。** 这与今天 `hard-stop-terminalize.js:89` 的 `source === "runtime_result"` 采信路径语义等价,只是判据从字符串猜换成了显式声明。

**因此 `DECLARABLE_STATUSES` 保留 4 个值。** 代价:`declaration !== null` **不是**「agent 说这轮不算数」的充分谓词。
→ **硬规则:全系统禁止对 `declaration != null` 做分支,只能对 `declaration.status` 做分支。** 配一条 grep 规则测试(`lib/round/**` 与调用侧不得出现 `declaration &&` / `declaration ?` 形式的真值分支)。

**含义漂移的三道机器化设防:**
1. **缺席即 null,且没有位置可填。** `recordDeclaration` 是唯一构造点、2 个调用点、无 fallback。今天的病根 —— `runtime-mailbox-outbox-helpers.js:313` 的 `normalizeStageRunResult({}, defaults)` 让平台替 agent 填了 `status:"completed"`(`stage-results.js:101,76`)—— 在新结构里**没有位置可填**。
2. **单一构造 + `Object.freeze` + `ROUND_BRAND` 封印,不存在第二层 normalize。** `explicitRuntimeResult` 的死法(被 `execution-observation.js:84-107` 白名单抹掉)结构性排除。封印同时让**测试不能手工构造事实对象** —— 这直接杀死 `tests/handoff-completion-gate.test.js` 那种「门在测试里活着、生产里死着」的死法(实证:13 处调用全部手工构造 `executionObservation`)。
3. **零存在性谓词。** `hasProtocolSemanticPayload` / `hasExecutionObservationPayload` / `hasSemanticProgressObservation` 全族删除。新判据只允许分支两个显式布尔:`evidence.ok` 与 `halt.kind !== "none"`,两者都不会被上游默认填充改变含义。

> **一条诊断更正(必须写进 wiki,防下一轮重复归因):** 「平台代填 `completed` 污染了终态判定」**不成立**。`contract-outcome.js:222-253` 在 `requirements` 非空时直接由产物检查决定,根本不看 `stageRunResult.status`。注入的真实杀伤面只有 `hasProtocolSemanticPayload` → 交接门弃权,与 `hasExecutionObservationPayload` → systemAction 失败永不落终态。`"missing runtime_result"` 那句文案**已不可达**,真正活着的是「无证据默认判失败」。

---

## 四、删除清单(逐文件逐函数,按批)

> block-check 双规则(实证 `lib/dev/system-block-registry.js:248-273`):**① 1 个跨块运行时文件即 fail;② `touchedRuntimeBlocks >= 3` 即 fail。** `unclassified` 只打印不 fail。`tests/`、`lib/formal-runtime/`、`lib/dev/`、`scripts/`、`wiki/`、`docs/` 属 support(`verification-docs`),可搭任意批。

### 批 B6 · primary = `operator-cli-control`
| 文件 | 删/改 |
|---|---|
| `lib/system-action/system-action-runtime-ledger.js:114-116` | **删除** `hasExecutionObservationPayload(executionObservation)` 弃权分支(恒真 → systemAction 失败永不落终态)。改为由调用方传入 `decision.counts`,`counts===true` 时才弃权 |
| `lib/admin/runtime-admin.js:19` | `clearAllTraces` 垫片导入 → 改直连 `closeAllRounds()` |
| `lib/system-action/platform-service-toolface.js:105-125` | `submitted_output` 落点改为调 `recordDeclaration(epochKey, {..., via:"tool"})` |

### 批 B7 · primary = `local-execution`(最大一批)
| 文件 | 删除内容 |
|---|---|
| `lib/lifecycle/agent-end-graph-route.js` | `MIN_HANDOFF_OUTPUT_CHARS`(:128)、`resolveIncompleteHandoffGate`(:175-229)、`buildIncompleteHandoffOutcome`(:130-146)、`runHandoffGate`(:151-173)及 4 个调用点(:399,538,550,570)、`resolveHardStopTerminalGate`(:84-118)、`resolveHardStopProgressGate`(:74)、第二份 `summaryByReason`(:93-99)、`hasSemanticProgressObservation`(:66)、`output_commit_observed` 分支(:507-517,**删前先补一条 live 复现确认它确实无生产触发**,不要因为测试绿就当它活着) |
| `lib/runtime/hard-stop-terminalize.js` | `resolveAuthoritativeHardStopOutcome`(:77-108)、`buildHardStopTerminalOutcome`(:20-38)、`summaryByReason`(:21-27)。文件 200 行 → ~70 行,只剩 defer 判断 + 触发 |
| `lib/stage/execution-observation.js` | `hasProtocolSemanticPayload`(:138-151)、`hasExecutionObservationPayload`(:131-134);**同批重算 `collected`**(:112-116 去掉该析取项),并同批修 `lib/lifecycle/agent-end-transport.js:33` 的读者 |
| `lib/lifecycle/crash-recovery.js:170-200,299-310` | ABANDONED 直判分支 → 先 `settleAndCommitRound`,`ABANDONED` 仅在 `counts===false && 重试耗尽` 时落 |
| `lib/lifecycle/agent-timeout-sweep.js:49-66,91-102` | 纯 elapsed 强制 fail → `noteHalt({kind:"timeout"})` + `settleAndCommitRound` |
| `lib/lifecycle/agent-end-terminal.js:113-127,221-247` | `resolveGraphTerminalOutcome` + 四路优先级链 **整段删除**,改为直接读 `context.decision` |
| `lib/lifecycle/agent-end-stage-definitions.js:36,371,483-534` | `execution-trace-store` 导入改直连 `closeRound()`;`readSessionCollabFacts` 改读 `trackingState.collabFacts`(切断账本最后一个执行面读者);`clearTrace()` → `closeRound()` + 显式 `clearLoopSession()` |

### 批 B8 · primary = `graph-dispatch-queue`
| 文件 | 删除内容 |
|---|---|
| `lib/routing/mailbox/runtime-mailbox-outbox-helpers.js:313` | **`normalizeStageRunResult({}, defaults)` 默认注入撤销** —— 声明缺席即 `null`;:429-434 的 `explicitRuntimeResult` 临时布尔删除;:216-262 的三级基准新鲜度实现搬进 `artifact-evidence.js` 后原址删 |
| `lib/routing/terminal-commit.js:10-18` | `reason.startsWith("loop_budget_exhausted")` 反解删除,改读 `decision.closure` |
| `lib/routing/delivery/delivery-terminal.js:49-63` | `buildNonSuccessResultSummary` 改造(见 §六 H4) |

### 批 B9 · primary = `runtime-core`
| 文件 | 处置 |
|---|---|
| `lib/contract/contract-outcome.js`(287 行) | **整文件删除**。含 `evaluateContractOutcome`、`buildObservationOutcomeEvidence`(:151-179)、`inspectArtifact`(:45-90)、`buildFallbackRequirements`(:92-106)、`buildStageArtifactRequirements`(:113-125)、`_hardPathResult` 分支(:214-221)。`deriveTestsPassed`(:135-149)**搬家不删** → `lib/contract/reviewer-signal.js` |
| `lib/contract/terminal-outcome.js` | schema 重写:删 `verdict`/`score`/`testsPassed`/`retryable`/`actionType`/`source`,加 `basis`/`closure`/`declaredVia`/`reviewMirror` |
| `lib/evidence/session-progress-projection.js` | **删除**(读者已在 B7/B6 迁完) |
| `lib/evidence/session-trace-store.js` | **搬家改名** → `lib/audit/session-audit-log.js`,**内核一行不改**(e330c78 并发串行化 / d5e0d0a 容忍未闭合 / e37312f 自愈开账 三个修复不重踩);模块头写死「非承重、失败沉默、执行面禁止 import」 |
| `lib/evidence/evidence-bridge.js` / `session-trace-reader.js` / `tool-event-digest.js` / `trace-event-schema.js` | 一并搬 `lib/audit/`;`tool-event-digest.js` 的 `DIGESTERS` 表**新增一行 `submit_output`**,记 `status`/`reason`(今天走默认摘要器只记 `Object.keys(params)`,没有任何路径能事后回答「这一轮 agent 声明了什么」) |
| `lib/store/execution-trace-store.js`(15 行退役垫片) | **删除 —— 必须三步**:①两处 import 已在 B6/B7 改直连 → ②从 `tests/delivery-semantics.test.js:1595` 的文件清单摘掉这一行(它 `readFile` 这个路径,直接删文件会 ENOENT 撞红)→ ③删文件 |

### 保持不动(硬约束 4)
`lib/harness/**`、`harness-module-evidence.js:214,236,254`、`harness-guard-registry.js:84`、`harness-guard-checks.js:10,37`、health 的 `validateSessionTraceContent`(E-EVIDENCE-001)—— 只改 import 路径,签名逐字保留。
`contract.expectations` 声明链、`buildHopExpectations()`(已裁定边界)、`submit_plan`/`report_progress`(缓建)。

---

## 五、新建清单

| 路径 | 职责 | 预估行数 | 块 |
|---|---|---|---|
| `lib/round/round-ledger.js` | 内存台账:开账/工具调用/中断/采集/声明/读/清账 | ~120 | local-execution |
| `lib/round/round-declaration.js` | 声明归一 + L3 文件劈分(declaration / stageHints) | ~90 | local-execution |
| `lib/round/artifact-evidence.js` | **全系统唯一**产物取证器(新鲜/非空/控制载荷/minBytes/jsonPaths) | ~150 | local-execution |
| `lib/round/round-facts.js` | 唯一构造点 + deep-freeze + `ROUND_BRAND` 封印 | ~240 | local-execution |
| `lib/round/round-decide.js` | 8 行判定表,纯同步纯函数 | ~130 | local-execution |
| `lib/round/round-copy.js` | `basis → 中文 message/clarification` | ~70 | local-execution |
| `lib/round/round-terminal.js` | `settleAndCommitRound` + `projectDecisionToTerminal` | ~110 | local-execution |
| `lib/contract/reviewer-signal.js` | 评审信号唯一读取器(含搬家的 `deriveTestsPassed`) | ~70 | runtime-core |
| `lib/audit/session-audit-log.js` 等 5 文件 | 从 `lib/evidence/` 搬家,内核不改 | 0 净增 | runtime-core |
| `tests/helpers/round-fixture.js` | 建临时 workspace + 真 outbox,调真 `captureRoundFacts` 产 sealed facts | ~90 | support |

**新增 ~980 行,删除 ~1180 行**(contract-outcome 287 + terminal-outcome 85 + graph-route 门与硬停闸 ~220 + hard-stop-terminalize ~130 + projection 114 + 采集侧重复实现 ~130 + agent-end-terminal 优先级链 ~60 + 各处冗余取证 ~150)。全部文件 <300 行,无 god object。

**`lib/round/` 登记到 `local-execution`(不是 runtime-core)。**
实证:`local-execution` 的 patterns 已含 `lib/lifecycle/`、`lib/runtime/`、`hooks/`、`lib/stage/execution-observation.js`,即「一次 agent 运行周期内的判定」全在这块。若登记到 `runtime-core`,B7 接线批(primary=local-execution)一碰 `lib/round/*.js` 就变 cross-block 当场 fail —— **三份原设计都在给自己制造后面批次的红**。持久化的合约真值仍归 runtime-core(`lib/contract/terminal-outcome.js` + 合约存储),分工不变。

---

## 六、迁移

### 6.1 四个判决语汇下游

| # | 消费者 | 今天读 | 改读 | 批 |
|---|---|---|---|---|
| 1 | `lib/stage/stage-witness-engine.js:60,68` | `terminalOutcome.artifact`、`terminalOutcome.verdict` | `terminalOutcome.artifact` 保留;verdict → `resolveReviewSignal(contract.executionObservation).verdict` | B2 (`loop-stage`) |
| 2 | `lib/automation/automation-result-extractors.js:11,46,63-65` | `terminalOutcome.score` + summary/reason/clarification/artifact | score → `resolveReviewSignal(...).score`;其余字段名不变 | B3 (`automation-governance`) |
| 3 | `dashboard/dashboard-work-items.js:249,265-270` | `status/source/reason/retryable/testsPassed/ts` | `status/basis/closure/message` + `resolveReviewSignal(...).testsPassed`;`retryable`/`ts` 标签删除;i18n 两组 key 同批改 | B4 (`projection-ui`) |
| 4 | `lib/harness/harness-module-evidence.js:236,254,277` | `terminalOutcome.verdict/testsPassed`、`reason` 跑 `/timeout/` 正则 | **本轮不碰**(硬约束 4)。改读 `terminalOutcome.reviewMirror`;`/timeout/` 正则改读 `closure === "timed_out"` 的工作留给 harness 重做批 | — |

> ⚠ **次序铁律:B2–B4 必须早于 B9。** B9 先砍字段而下游还没迁,`dashboard-work-items.js:269` **无 fallback,会静默变空白** —— 正是本轮要拆的病的同型。

### 6.2 旧字段 → 新字段映射表

| 旧 (`terminalOutcome`) | 新 | 说明 |
|---|---|---|
| `status` | `status` | 值域不变(COMPLETED/FAILED/AWAITING_INPUT) |
| `source` | `basis` + `declaredVia` | `"runtime_result"` → `basis:"declared_*"` + `declaredVia:"file"\|"tool"`;`"completion_criteria"` → `basis:"inferred_from_deliverable"`;`"handoff_completion_gate"` → `basis:"no_deliverable"`;`"loop_runtime"` → `closure:"hard_stopped"` |
| `reason` | `reason` | 语义收紧:**只装机器码(=== basis)**,永不进用户文案 |
| `summary` | `summary` | 从 `decision.message` 取,**必非空** |
| `clarification` | `clarification` | 仅 AWAITING_INPUT |
| `artifact` | `artifact` | `decision.evidence.primaryPath` |
| `verdict`/`score`/`testsPassed` | `reviewMirror.{verdict,score,testsPassed}` | 仅供 harness;其余下游改读 `resolveReviewSignal` |
| `retryable` | **删除** | 0 行为读者(唯一读点是 dashboard 标签);「打回重做已作废」的代码侧铁证 |
| `actionType` / `version` / `ts` | **删除** / 保留 `version` / `ts` 移到合约层 | `actionType` 全库 0 读者 |
| — | **新增** `closure` | `verified`/`declared_stop`/`hard_stopped`/`timed_out`/`crashed`/`no_evidence`。取代 `reason.startsWith("loop_budget_exhausted")` 的字符串反解 |

### 6.3 两个 store 的迁移

| | 今天 | 重做后 |
|---|---|---|
| `lib/evidence/session-progress-projection.js` | 内存/同步/承重,住 `evidence/`;返回 7 字段,只有 `outputCommitted` 承重 | **删除**。承重内容并入 `RoundLedger`(3 字段:`outputCommitted`/`toolCalls`/`halt`);`offTrack` 降为 `RoundFacts` 的派生告警,**明确标注非承重**;`clearSessionProgress → clearLoopSession` 的连坐**显式搬迁**到 `closeRound`(漏搬 = 重复计数跨会话残留成假硬停,有锁 `session-progress-projection.test.js:129`) |
| `lib/evidence/session-trace-store.js` | 异步/失败沉默,住 `evidence/`,执行面 1 个读者 | **改名搬家 `lib/audit/session-audit-log.js`**,内核不改,执行面读者清零;补 `submit_output` digester;补 close 侧对称自愈(今天自愈开账只做在 append 侧,`session-trace-capture.test.js:53` 只锁了 append 侧,close 侧无锁 → 63 个 `synthetic_*` 是 close-only) |

**不合并。** 两者失败语义相反且各有测试锁(`evidence-bridge.test.js:60` 写失败绝不打断执行 vs `session-progress-projection.test.js:93` 未开账必须返 null)。今天的病不是「应该合并」而是「名字近似住同一目录却没有任何机制区分」→ 修法是**目录分家 + 改名 + 静态 import 禁令**,不是再写第三段注释。

### 6.4 补评委共同缺口 #4:`counts=false` 会换掉用户看到的**正文**

实证 `lib/routing/delivery/delivery-terminal.js:160-163` → `buildNonSuccessResultSummary(:53-63)`:非 COMPLETED 时用户收到的是 `buildUserFacingFailureText`,**agent 的实际输出不再投递**。三份原设计都只在「标签/统计」层面讨论 `counts=false`。

**H4 项(必做,配 live 断言):** `buildNonSuccessResultSummary` 增加产物附录 —— 当 `terminalOutcome.artifact` 非空时,失败/等待文案后附上该产物的用户可读正文。
适用场景:行 1(声明 failed 但已产出中间结果)、行 6(硬停但产物齐全)。
约束:`tests/delivery-semantics.test.js:893` 与 `delivery-terminal-runtime-copy.test.js:128` 锁死用户文案**不得出现**内部机器码 —— 附录只带产物正文与 `summary`,不带 `basis`/`reason`。

### 6.5 补评委共同缺口 #5:`awaiting_input` 的恢复语义

- AWAITING_INPUT 是终态之一,合约随之离开 `running`。
- `recoverOrphanedContracts` 只处理 `status === "running"`(`crash-recovery.js:299`)→ **等待中的合约不会被巡检重算成 FAILED**。这条要加一条显式单测锁(今天是巧合成立,没有锁)。
- 唤醒后是**新一轮**:新 `epochKey`,`openRound` 清账,旧 declaration 不跨轮(消灭 declaration-first 自认的 roundKey 跨轮残留漂移面)。
- 声明跨进程丢失的残余窗口无法消除:`declaration` 进 `createTrackingState` 字段表 + `snapshotResumableTrackingSessions`/`restore` 两张字段表,把窗口缩到「调用工具 → 结算提交」之间的进程死亡。**明写在代价页,不假装解决。**

### 6.6 补评委共同缺口 #3:`reviewerResult` 归属裁定(概念先行,代码跟随)

**裁定(先落 wiki 决策页,再动代码):**
- `executionObservation.reviewerResult` 是**执行面**的一等观测事实 —— 它由 `deriveRuntimeResultReviewerResult`(`outbox-helpers.js:416`)与 `extract_output_markers` 的 findings 从**产物正文**提取,是「agent 在文档里写了什么」的观测,不是判决。
- `contract.reviewerResult` 降级为**评审车道镜像**(两个条件性写点),不是真源。
- 判决面重做时,判决自己的 verdict 存判决账本,**不写这两处**;结算面永远不认识 verdict 这个词。

---

## 七、测试计划

### 7.1 必须逐条仍然成立(断言文本可改,结论一字不变)

| 用例 | 为什么 |
|---|---|
| `tests/contract-outcome-runtime-result-boundary.test.js` 4 条 | 硬约束 3 唯一的机器化表达。对应新表:声明 completed 不算数需产物证据 → 行 3/4;声明 failed 算数 → 行 1;声明的 artifacts 每个都要 FS 证据 → `artifact-evidence`;`contract.output` 是默认产物证据 → `buildRequirements` 第 2 条。**顺手清理**:4 条 fixture 里塞的 `explicitRuntimeResult:true` 是 dead fixture(`contract-outcome.js` 全文不读它),重写时去掉,别当语义继承 |
| `tests/contractor-handoff-terminal.test.js` 7 条负面边界 | agent 最终助手文本/控制文本/runtime guard 文本都不算产物;已写进 `contract.output` 的工具错误载荷判 FAILED |
| **`tests/hard-stop-terminalize.test.js:56-91`** | **本轮新发现的 95 行活锁,三份原设计全部漏报。** 新鲜 6 字节 `answer.md` + 硬停 + 无声明 → FAILED。由**判定表行 6** 保住 |
| `tests/delivery-terminal-runtime-copy.test.js:86,132` | 用户文案必须含 summary 原文、不得含机器码。code/message 从第一天分家后天然成立 |
| `tests/evidence-bridge.test.js:60`、`terminal-chain-trace-merge.test.js:31`、`session-trace-capture.test.js:36,53` | 账本三条可靠性契约,内核不改 |
| `tests/session-progress-projection.test.js:93,129` | **改写而非删**:迁到 `tests/round-ledger.test.js`,锁「未开账返 null 不代填」与「清账连坐 clearLoopSession」 |
| `tests/protocol-commit-reconcile.test.js:495,600,730` | 三条硬停用例走真 hook + 真 workspace,是新测试的写法范式 |

### 7.2 随重做作废(**需用户逐条批准**,纪律 5)

| 用例 | 理由 |
|---|---|
| `tests/handoff-completion-gate.test.js` 全 13 处 | 门删除;且它锁的是**生产从不产生的形状**(全部手工构造 `executionObservation`,从不走真采集)。**替换方案见 7.3** |
| `tests/agent-end-graph-route-ownership.test.js` 9 条 | 同一个病(手工构造),一起转真采集路径 |
| `tests/contract-outcome-tests-passed-derivation.test.js` 7 条 | **不删,搬家** → `tests/reviewer-signal.test.js`,含那条 `regression guard: verdict=improved → true`。派生逻辑搬到 `reviewer-signal.js` 后必须继续锁 |
| `tests/terminal-outcome.test.js:28,59` | schema 与 verdict 流转,随 B9 重写 |
| `tests/hard-path-autoexec-safety.test.js` | 仅当确认 `_hardPath` 全库无生产者后,删除**判据里**的 `_hardPathResult` 分支;`hard-path-autoexec.js` 本体保留,该测试保留 |
| `tests/output-commit-follow-graph.test.js:159` | 删前**先补一条 live 复现**确认 `commitType==="output_commit"` 确实无生产触发。不要因为测试绿就当它活着 —— 那正是交接门的同型死法 |
| `tests/system-block-registry.test.js:41-78` | 加 `lib/round/` → local-execution、`lib/audit/` → runtime-core 的断言(同批改 registry) |
| `tests/system-layer-boundary.test.js:23-36` | **P0 前置**:今天把 `contract-outcome.js`/`terminal-outcome.js` 登记在 `JUDGMENT_SIDE`,与硬约束 1 直接冲突;`:109` 还有「表里模块必须存在」的断言,删文件即红 |

### 7.3 新增用例

**A. 纯判定表穷举 — `tests/round-decide-table.test.js`(20 条)**
5(D) × 2(E) × 2(H) 全组合,逐条断言 `counts`/`status`/`basis`/`closure`。
**关键:facts 不得手工构造** —— `ROUND_BRAND` 封印禁止。用 `tests/helpers/round-fixture.js` 建临时目录、写真文件、调真 `captureRoundFacts`。20 个临时目录,毫秒级。这解决了 minimal-mechanism 未定价的「测试撰写税」。

**B. 真采集路径 — `tests/round-real-collection.test.js`(替代 handoff-completion-gate)**
照 `tests/protocol-commit-reconcile.test.js:495-600` 的写法搬(它已在跑真 `collectWorkerOutbox` + 真 hook + 真 contract 快照 + 真 workspace,只 mock 图与 loop 注册表):
- 3 字节 `note.md` + 无 requiredFiles + 无 contract.output → 行 5 判 `counts=true`(**明确记录这是行为变更**:今天交接门本该拦、实际放行;新设计**也放行**,因为质量阈值改成合约参数,不再用 24 字魔数)
- 同样 3 字节但合约声明 `minBytes:200` → 行 8 `no_deliverable`
- 上一跳 `contract.output` 陈旧镜像 + 本跳零产出 → 行 8(新鲜度)
- outbox 只有 `runtime_result.json` → 控制载荷排除 → 行 8

**C. 拔除测试(三层)**
1. `tests/round-import-closure.test.js` —— `lib/round/**` 与 `lib/contract/reviewer-signal.js` 的**传递** import 闭包不得命中 `judgment|examiner|verdict|evaluation|harness` 任一子串。**不依赖用例覆盖**,日后有人想把判据接回来,CI 立刻红。
2. `tests/round-judgment-free.test.js` —— mock 判决面模块为 `throw`,跑完整 dispatch 链,断言合约仍收 COMPLETED/FAILED。
3. **`tests/round-declaration-ablation.test.js`** —— 对全部 20 条判定用例跑两遍,一遍强制 `declaration=null`,断言**只有 `declared_*` 三个 basis 的用例结论改变**,其余逐字节相同。这是「agent 自报也是外挂」的可执行文档,也是「拔掉声明面后 `awaiting_input` 会塌成 FAILED」这个硬伤的机器化说明。

**D. schema 冻结 — `tests/round-schema-freeze.test.js`**
`RoundDecision` 键集**恰好 9 个**、`TerminalOutcome` 键集**恰好 10 个**,多一个少一个都红。判决语汇想骑回来 = 立即红(比「置 null」强,因为 null 会静默)。
外加:扫最近 N 个已收口合约,断言 `terminalOutcome` 无 `verdict`/`score`/`testsPassed`/`retryable`/`actionType` 顶层键。

**E. 反漂移 grep 锁 — `tests/round-no-existence-predicate.test.js`**
- `lib/round/**` 不得出现 `declaration &&` / `declaration ?` 形式的真值分支(只能分支 `declaration.status`)
- 全仓不得再出现 `hasProtocolSemanticPayload` / `hasExecutionObservationPayload` / `hasSemanticProgressObservation`
- `lib/round/**` 与执行面不得 import `lib/audit/`

**F. 无合约腿 — `tests/round-unmanaged.test.js`**
`contract === null` → `settleAndCommitRound` 返回 `{unmanaged:true}`,不写任何终态、不触发投递、不改路由。

**G. awaiting 恢复 — `tests/round-awaiting-recovery.test.js`**
合约收 AWAITING_INPUT 后跑 `recoverOrphanedContracts`,断言不被改成 FAILED。

### 7.4 live 负例(**验收前置条件,不是可选项**)

实证:`lib/formal-runtime/` 里 grep `maxToolCalls|hard.?stop|handoff|incomplete_output|control_payload` **零命中**;dispatch/pipeline 只断言 happy path。**四件全坏,4 预设也照样全绿** —— 「重做后 4 预设全绿」不构成任何证据。

新增 `--preset round`,7 条:

| ID | 构造 | 断言 |
|---|---|---|
| `round.no-deliverable` | worker 什么都不写 | 行 8;下游 inbox **未**收到投递;合约 FAILED |
| `round.declared-failed` | 产物齐全 + `submit_output(failed, reason:"卡在X")` | 行 1;用户文案含 reason 原文 + 产物正文附录(H4),**不含**机器码 |
| `round.declaration-ablated` | 同上但不挂 `submit_output` | 行 5 COMPLETED —— **这就是判官/声明双拔除的 live 证明** |
| `round.hardstop-silent` | `maxToolCalls=3` 触顶,产物齐全,零声明 | 行 6 FAILED + `closure:"hard_stopped"` —— 钉死 ce7913c |
| `round.hardstop-declared` | 同上 + `submit_output(completed)` | 行 3 COMPLETED + `closure:"verified"` |
| `round.stale-mirror` | 多跳第二跳零产出,上一跳 `contract.output` 仍在盘上 | 行 8(新鲜度) |
| `round.min-bytes` | 合约 `requiredFiles[0].minBytes=200`,产物 3 字节 | 行 8 `under_min_bytes` |

`health` 预设新增一条**平台服务挂载检查**:照抄 `evaluateCollabToolMounting`(`health-node-evaluators.js:224-243`)的形状,`requiredByRole` 换成「全角色必备」。今天平台服务族的 health 检查只比两张代码内的表(`health-node.js:284-297`),**「0 个 agent 能调 submit_output」在 74 项里全绿** —— 不补这条,「门死了没人发现」会原样复发一次,只是这次死的是声明入口。

---

## 八、验证方案

### 8.1 每批必跑

```bash
# 1. 拆批纪律(1 个跨块运行时文件即 fail;>=3 非 support 块即 fail)
node /Users/hakens/.openclaw/scripts/openclaw-block-check.js --primary <本批 block>

# 2. 单测
cd /Users/hakens/.openclaw/extensions/watchdog && node --test tests/

# 3. live 门(verify 门预设)
node test-runner.js --preset dispatch
```
判定标准:block-check `ok:true` 且 `problems: []`;单测全绿或失败集 ⊆ 已知 flaky 集;dispatch 8/8。

### 8.2 全量验收(B10 之后)

```bash
node test-runner.js --preset health          # 74 项 + 新增平台服务挂载检查
node test-runner.js --preset dispatch        # 8/8
node test-runner.js --preset pipeline        # 12/12
node test-runner.js --preset system-action   # 43/43
node test-runner.js --preset loop
node test-runner.js --preset round           # 新增,7 条负例,必须 7/7
```
Bug 读报告文件 `~/.openclaw/test-reports/`,不 tail 日志。

### 8.3 「拔掉判决面照跑」的可执行证明(三条,缺一不可)

```bash
# ① 结构性:import 闭包不含判决面(不依赖用例覆盖)
node --test tests/round-import-closure.test.js

# ② 运行时:判决面模块被 mock 成 throw,完整派工链仍收口
node --test tests/round-judgment-free.test.js

# ③ 声明拔除:证明 agent 自报也是外挂
node --test tests/round-declaration-ablation.test.js
```

补充证据:判决面(考官三件 + 判决账本 + 读侧 surface + 三个错误码)**已于今日整体拔除**,live 四预设全绿。所以「拔掉后照跑」不是承诺,是**当前状态**;上面三条测试跑在这个状态上。

### 8.4 挂载前置的验收(这条不过,后面全是空跑)

```bash
# submit_output 对每个 agent 是否物化(今天:0/10)
node test-runner.js --preset health | grep -i "platform-service.*mount"
# live 声明率:trace 账本里 submit_output 出现次数(今天:0;L3 文件写入:217)
grep -c "submit_output" ~/.openclaw/control-plane/trace/*.jsonl | awk -F: '{s+=$2} END {print s}'
```
判定标准:挂载检查绿(10/10 agent 可物化);跑完一轮 dispatch 后 `submit_output` 出现次数 > 0。

> ⚠ 与 declaration-first 的差别:本计划里**挂载失败不阻塞正确性**(判据不依赖声明,后果只是 failed/awaiting 被误判成 completed/failed),但**阻塞验收** —— 因为行 1/2/3 在未挂载时不可达,整张表只测到一半。

---

## 九、执行顺序与风险

### 9.1 批次表

| # | primary block | 内容 | 回滚点 |
|---|---|---|---|
| **P0-a** | —(git) | **先把在飞的改动提交收口**(判决面拔除 + 平台解耦刀1)。实测当前 8 个块各有改动 + 2 个未分类文件,`--primary <任意>` 全部 cross-block fail —— **起点就是红的,拆批纪律无法验证** | 新 tag `vN-stable` |
| **P0-b** | `verification-docs`(support) | wiki 决策页(①终态收敛归执行面 ②`reviewerResult` 归属 ③诊断更正);改 `tests/system-layer-boundary.test.js` 两张表;`lib/dev/system-block-registry.js` 加 `^…/lib/round/` → local-execution、`^…/lib/audit/` → runtime-core;同批改 `tests/system-block-registry.test.js` | 单文件 revert |
| **P0-c** | `agent-assembly` | 10 个 agent `tools.allow` 加 `group:plugins`;`skills/platform-tools/SKILL.md:47` 从「写 `outbox/runtime_result.json`」翻成「先调 `submit_output`,走不通再写文件」(一条路径原则:两条路同时被文档背书就是两套判据) | `openclaw.json` revert + 重启网关 |
| **P0-d** | `verification-docs`(support) | health 补平台服务挂载检查 + 声明率指标 | — |
| **B1** | `runtime-core` | 新建 `lib/contract/reviewer-signal.js`(含搬家的 `deriveTestsPassed` + 搬家的 7 条测试);`terminal-outcome.js` **加**新字段(`basis`/`closure`/`declaredVia`/`reviewMirror`),旧字段全留 | 零行为变化,可直接 revert |
| **B2** | `loop-stage` | `stage-witness-engine.js:68` 改读 `resolveReviewSignal` | — |
| **B3** | `automation-governance` | `automation-result-extractors.js:11` 改读 | — |
| **B4** | `projection-ui` | `dashboard-work-items.js:249,265-270` + i18n | — |
| **B5** | `local-execution` | 新建 `lib/round/` 7 模块 + 20 条判定表测试 + fixture helper。**零接线**(死代码) | 删目录即回滚 |
| **B6** | `operator-cli-control` | `deriveSystemActionTerminalOutcome` 去恒真弃权;`platform-service-toolface` 接 `recordDeclaration`;`runtime-admin` 去垫片 | — |
| **B7** | `local-execution` | **接线总批**:agent_end 新 `settle_round` stage;删交接门 + 硬停闸 + 漂移谓词族 + `collected` 重算 + `agent-end-transport` 读者;`hard-stop-terminalize` 缩身;crash/timeout/orphan 三条旁路并入;`clearTrace → closeRound + clearLoopSession` | **最大回滚点**,单独 tag |
| **B8** | `graph-dispatch-queue` | 采集侧撤默认注入;L3 劈成 declaration/stageHints;`terminal-commit` 去 `startsWith` 反解;`delivery-terminal` 读 `decision.message` + H4 产物附录 | — |
| **B9** | `runtime-core` | 删 `contract-outcome.js`;`terminal-outcome` 砍旧字段;`lib/evidence/` → `lib/audit/` + digester + close 侧自愈;删 projection;`execution-trace-store` 三步删 | — |
| **B10** | `verification-docs`(support) | `--preset round` 7 条 live 负例 + 拔除测试三层 + schema 冻结 + grep 锁 | — |
| — | `harness-assurance` | **本轮不做**(硬约束 4),靠 `reviewMirror` 顶住 | — |

### 9.2 新 agent_end 段排布

```
1  load_tracking_contract
2  collect_transport            → noteCollection(平台自证)
3  extract_output_markers       ★真依赖:_outputContent 缓存,必须在 consume 之前
4  settle_round                 ★★唯一判定点,产 decision 挂 context
5  preserve_artifact            只在 counts===true 时打包并入上游 inbox
6  graph_route                  只读 decision.counts,不再产 terminalOutcome
7  consume_system_action
8  close_audit_log              ★真依赖:合成事件先落账(有单测护栏)
9  commit_terminal              直接写 decision 投影,无优先级链
10 crash_recovery               (match !success)
```

三条真顺序依赖全部保留:`extract→consume`、`extract/consume→close`、`preserve→graph_route`。
**顺带修掉一个位置错误**:今天交接门寄生在 `graph_route` 内部(4 个调用点),必然晚于 `preserve_artifact` —— **被拦下的轮次产物包已经打好并入了 artifacts 目录**。新排布里结算在打包之前,不算数的轮次不打包、不交棒。

### 9.3 最容易弄坏的地方(按风险降序)

1. **B7 删 `hasProtocolSemanticPayload` 会静默改掉 `collected`。** 实证 `execution-observation.js:112-116`:删掉该析取项后,零产出轮次的 `collected` 从恒 `true` 翻成 `false`,直接改两个读者的行为 —— `agent-end-transport.js:33`(local-execution,B7 内)与 `system-action-runtime-ledger.js:115`(**operator-cli-control**)。**后者必须在 B6 先处理完**,否则 B7 会同时碰 local-execution + operator-cli-control(+ 任意第三块)→ 触发 `touchedRuntimeBlocks >= 3` 直接 fail。
2. **B9 早于 B2–B4 会让 dashboard 静默变空白**(`dashboard-work-items.js:269` 无 fallback)。次序铁律不可动。
3. **`execution-trace-store` 一步删会 ENOENT 撞红**(`tests/delivery-semantics.test.js:1595` 用 `readFile` 读这个路径)。必须三步:改直连(B6/B7)→ 摘测试清单行(B9)→ 删文件(B9)。这是「看着没用就删」的第三次预备役。
4. **`closeRound` 漏掉 `clearLoopSession` 连坐** → 重复计数跨会话残留成假硬停。有锁,但搬家时最容易漏。
5. **`lib/round/` 若登记到 runtime-core**,B7 当场 fail。P0-b 必须先把 pattern 加对。
6. **P0-c 挂载后模型行为不可预期**:`submit_output` 一旦可用,agent 可能开始高频声明 `hold`。行 2 会把这些轮次直接结算成 AWAITING_INPUT 且不交棒 —— 上线后前 3 天要看 `basis` 分布,`declared_awaiting` 占比异常需立刻回滚 P0-c(改 `tools.allow` + 重启网关,秒级)。
7. **`baseline.source === "none"` 时 fail-open** → 陈旧残件冒充本轮产物,且**无法用声明补救**(平台不信声明的抬升)。这是本设计唯一的 false-positive 面,必须在 dashboard 上把 `baselineSource` 显示出来。

### 9.4 代价(诚实,不藏)

| 代价 | 说明 |
|---|---|
| **质量地板依赖派工方** | 删掉 24 魔数后,3 字节的 `abc` 在无 `minBytes` 声明时仍判 `counts=true`。我拒绝把一个魔数换成另一个魔数,代价是「防 agent 交白卷」这件事**执行面不负责**,要么派工方写 `completionCriteria.minBytes`,要么等判决面重做 |
| **`awaiting_input` 依赖 agent 自报** | 平台自证永远看不出「我在等你回话」—— 盘上没东西 与 在等输入 是同一个观测。拔掉声明面它全部塌成 FAILED。`round-declaration-ablation.test.js` 是这个硬伤的可执行文档 |
| **声明的耐久性** | L1 落点是内存,进 snapshot/restore 后仍有「调用工具 → 结算提交」之间进程死亡的残余窗口,不可消除。对比之下盘上文件跨重启天然成立 |
| **热路径 IO** | 熔断收口现在也要跑一次全量取证(stat + 按需 readFile)。硬停是低频事件,可接受,但不是零成本 |
| **单点承重** | `round-decide.js` 一坏,全系统合约无法收口。今天四件分散有偶然容错 —— 虽然实际表现是四件互相掩盖(门死了没人发现)。缓解只能靠测试密度(20 条穷举 + 7 条 live),不能靠架构 |
| **过渡期更乱** | B1→B9 之间 `terminalOutcome` 是新旧字段并存的超集,`reviewMirror` 在 harness 重做前一直是一条兼容线 —— 这段时间违反「一条路径」原则。**收敛后才更干净,过程中不是** |
| **长期熵** | 判决面重做时所有新判据都会想挤进 `decideRound`。唯一防线:它的输入只接受 sealed `RoundFacts`,新判据必须先变成一条「事实」才能进来 + 9 键 schema 冻结。这条防线能撑多久,不确定 |

---

## 十、被否决的方案(防下一轮重新提)

### 来自 platform-truth

| 主张 | 为什么不选 |
|---|---|
| **`DECLARABLE_STATUSES` 砍掉 `completed`** | 会翻红 `tests/hard-stop-terminalize.test.js:56-91` 隐含的逃生口:今天 `hard-stop-terminalize.js:89` 的 `source === "runtime_result"` 采信路径允许「显式声明完成 + 有产物」在硬停轮次判 COMPLETED。砍掉之后「agent 做完了才被预算切断」永远判 FAILED。**保留该值,但用「它只解除中断歧义、不能抬升」限制其权力**,并配 grep 锁禁止 `declaration != null` 真值分支 |
| **`countsAsDone: true\|false\|null` 三态 + `partial` 快照** | 同一份文档在 §11 宣称「一个默认不放行的判据没有弃权谓词可以死」,却自己造了一个弃权态,且 `mayHandOff(null)` 的行为全文未定义。热路径熔断改为跑完整的 `captureRoundFacts`(硬停低频,IO 可接受),不需要 partial |
| **`RoundFacts.expectations[].satisfied` 在事实层算判断** | 层次倒置:C2 号称唯一裁定者,真判据(`satisfied`)却在 C1 算完了,且 `fresh:null` 如何映射进 `satisfied` 未定义。这正是「谓词读别处算出来的布尔」—— 交接门死于同一形状。本计划把取证结果留成 `checked[]` 明细 + 一个 `ok` 布尔,`ok` 的计算与判定表在同一个概念边界内 |
| **`expectations[].source` 含 `stage_declared_artifact`** | 与同文档「L3 只吸 status」自相矛盾。用 declaration-first 的 L3 劈分解决:`artifacts[].path` 只作**候选路径线索**,不构成期望 |
| **「要求每一腿都落盘」是最大代价** | 高估。实证 `buildFallbackRequirements`(`contract-outcome.js:92-106`)今天只要 `contract.output` 存在就强制 `nonEmpty + semanticText`,唯一豁免开关 `requireDefaultOutputArtifact` 全库零生产者 —— 这条今天基本已成立,迁移成本远小于自陈。真正的最大代价是 `awaiting_input` 依赖自报 与 mtime fail-open |

### 来自 declaration-first

| 主张 | 为什么不选 |
|---|---|
| **`halt` 由调用方传参给 `observeRoundFacts`** | `halted` 与 `kind` 两个字段之间无一致性约束,而判定表整整一行(行 6)骑在这个 caller-supplied 布尔上。只要哪天 timeout-sweep 统一传 `halted:true`,所有恢复出来的、产物齐全的会话集体翻 FAILED,而没有任何测试能提前发现 —— 与 `stageRunResult` 从「agent 说了什么」漂成「采集跑过了」是**同一个机制**。改为:`halt.kind` 由 `captureRoundFacts` 从平台源派生,`halted` 永远 `=== kind !== "none"`,不存在独立布尔 |
| **无条件相信 `hold`,平台零 recourse** | 采纳表行 2 的结论,但必须配 §9.3 风险 6 的观测:上线后看 `declared_awaiting` 占比,异常即回滚挂载。不能只写「代价」不写「监测」 |
| **把「L1 未挂载」当作批 0** | 挂载不是批次,是**这条路一半判据成不成立本身**(行 1/2/3 在未挂载时不可达)。本计划把它提到 P0-c 并写进验收标准 8.4:挂载检查不绿,`--preset round` 只测到 4/7 |
| **无行数预算** | 硬约束 6 未回应,`round-facts.js` 要吞 7 份重复实现,现实 250-350 行有越线风险。本计划给了逐文件预算,并把取证器单独拆成 `artifact-evidence.js` |
| **批 C「L3 劈成 declaration + stageHints」放 graph-dispatch-queue** | 劈开的动作横跨采集侧(graph-dispatch-queue)与消费侧(`lib/stage/` = loop-stage、`lib/lifecycle/` = local-execution),不可能只落一个块。本计划把「读文件劈分」放 `lib/round/round-declaration.js`(local-execution,B5 建),B8 只改采集侧调用 |

### 来自 minimal-mechanism

| 主张 | 为什么不选 |
|---|---|
| **`settleRound` 内部 `await inspectArtifactEvidence(...)`** | 破自己的封印:文档说「Settlement 的输入只接受 RoundFacts,新判据必须先变成一条事实才能进来」,而伪代码里最承重的产物证据**根本不在 sealed facts 里**。本计划把取证放进 `captureRoundFacts`,`decideRound` 保持零 IO 纯同步 —— 封印才有意义 |
| **「新鲜度顺手覆盖 ce7913c,不需要第二个机制」** | **被 `tests/hard-stop-terminalize.test.js:56-91` 实证证伪**:该用例的 `answer.md` 是当场新建的 6 字节文件,新鲜度检查会放行。新鲜度只覆盖**跨跳陈旧镜像**,覆盖不了**同一 run 内先写后停**。ce7913c 的语义必须显式写进判定表(行 6),不能靠副作用覆盖 |
| **批 2「runtime-core 删 session-progress-projection」** | 它的 4 个执行面读者全在 local-execution(`hard-stop-terminalize.js:62`、`agent-end-graph-route.js:54`、`agent-end-terminal.js:148`、`hooks/after-tool-call.js:168`),删模块与改读者不能分批 —— 批 2 一落地就有 5 个 cross-block runtime 文件,当场 fail。本计划把读者迁移放 B7(local-execution),删文件放 B9(runtime-core) |
| **`lib/round/` 登记进 runtime-core** | 登记完之后,以 local-execution 为 primary 的接线批只要碰一下 `lib/round/*.js` 就变 cross-block。改为登记 **local-execution** |
| **「RoundFacts 内存态跨进程重启即失,今天也一样」** | 说反了。今天 `contract.executionObservation` 落在合约上、outbox 文件在盘上,恢复路径可以由 FS 重新推导(`contract-outcome.js:223-253` 全是 FS 检查)。把事实收进纯内存台账是**新增**一个缺口。本计划的 `captureRoundFacts` 每次现场取证,不依赖台账的持久性;台账只提供 `outputCommitted`(且 `openedBy !== "session_start"` 时不采信) |
| **合并两个 store** | 两者失败语义相反且各有测试锁,合并意味着在两套相反契约里二选一,那三条测试就是代价表 |
| **保留交接门、把 24 换成分级阈值** | 24 与 `CONTROL_TEXT_SHORT_LIMIT=200` 是一对拍脑袋的数;换成另一个平台常量还是魔数。改为合约参数 `minBytes`(每个任务自己声明),平台默认只判形式 |

### 三份共同的一条被否决

**「4 个下游改读 `contract.reviewerResult`」** —— 该字段只有两个条件性写点(`agent-end-stage-definitions.js:267` 仅当 marker 真提到 findings;`delivery-system-action-review-verdict.js:175` 仅评审车道),非评审腿会丢数据。真源头是 `contract.executionObservation.reviewerResult`(`contract-outcome.js:155` 读的就是它)。统一改读 `resolveReviewSignal(contract.executionObservation)`。
同时:**`deriveTestsPassed` 不删** —— 三份同时「删派生函数 + 下游改读 reviewerResult」的合成效果,正是它们自己在批判的「静默变空白」。

---

## 完成 / 未完成 / 跳过

**已完成:** 十节全部产出 —— 概念与真值(3+1)与四件去向对照表、逐函数接口规格(含自证/自报标注)、8 行完整判定表(穷举 20 种组合)与三道机器化防漂移、按块拆批的删除清单、新建清单含行数预算、4 个下游迁移方案 + 完整字段映射表、测试计划(保留/作废/新增三类,含 `handoff-completion-gate` 的真采集替代方案)、可执行验证命令与拔除三层证明、10 批执行顺序 + 7 条风险 + 7 条代价、三份共 18 条被否决主张。
**补齐了两名评委指出的全部 9 个共同缺口:** `deriveTestsPassed` 搬家、`reviewerResult` 真源头与归属裁定、`collected` 重算的跨块处理、`lib/round/` 登记块、`counts=false` 换正文、无合约腿、`awaiting_input` 恢复、`tests/hard-stop-terminalize.test.js` 活锁申报、诊断过度归因更正。
**未完成 / 边界(硬约束 4):** 判决面重做(外挂,另议)、`submit_plan`/`report_progress`(缓建)、harness 子系统(靠 `reviewMirror` 顶住,债主已登记)、`contract.expectations` 声明链(留给判决面下针)。
**本轮未修改任何文件。** 新增实证:`lib/dev/system-block-registry.js:1-200,248-273`(块 pattern 与双 fail 规则)、`lib/contract/contract-outcome.js:135-149`(`deriveTestsPassed`)、`lib/routing/delivery/delivery-terminal.js:53-63,155-170`(非成功正文替换)、`tests/hard-stop-terminalize.test.js:56-95`(95 行活锁)、`lib/stage/execution-observation.js:105-155`(`collected` 重算)、`lib/system-action/system-action-runtime-ledger.js:110-125`(恒真弃权)。