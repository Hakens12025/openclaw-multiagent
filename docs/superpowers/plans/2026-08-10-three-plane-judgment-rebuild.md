# 三分模式重建计划 —— 记录 / 判定 / 反应

> ⚠️ **本计划已被更简的拆除路线取代**(2026-08-10/11 落地,v189/v190)。判决面最终形态 =
> `lib/judgment/expectation-check.js` 一个文件;无 veto/注册表/账本/聚合面;执行面状态词汇
> 保留(仅删 AWAITING_INPUT)。三分判准与 R1-R5 仍有效且已机器化(动态 import 消融 +
> `tests/judgment-ablation.test.js`)。本文余下部分作为**将来重建更全判决面时的设计参照**,
> 勿当作当前待办执行。现状对账见备忘录138 顶部。

> 取代 `2026-08-09-round-outcome-rebuild.md`（该版已作废，作废理由见 §0.2）。
> 外部参照：Temporal 的「执行状态 ≠ 业务结论」、LangGraph 的「平台无 status」、
> OpenAI Agents SDK 的「guardrail 是外挂对象」。

---

## 〇、为什么要推翻上一版

### 0.1 三分判准（按**产出什么**分，不按名字分）

| 面 | 输入 | 输出 | 可删除性 |
|---|---|---|---|
| **① 记录** | 世界 | **事实** | 不可删（没有事实什么都做不了） |
| **② 判定** | 事实 | **结论** | **必须可整体删除** |
| **③ 反应** | 事实（或结论） | **动作** | 不可删（不动就不是系统） |

判准里最要紧的一句：**「合格 / 不合格」这四个字一出现，就是 ②。** 不管它写在哪个文件里、叫什么名字。

### 0.2 上一版的三条硬伤（自查）

**硬伤一：`decideRound` 是判定器，被我放进了执行面。**
它的全部职责就是"从事实得出结论"。取名"收敛"、划进 `local-execution` 不改变性质。

**硬伤二：`evidence.ok` 是判定结果伪装成事实。**
`stat` 是事实，`ok` 不是。「非空 + 新鲜 + 非控制载荷 = 合格」是**判据**。把魔数 24 换成 `minBytes` 只是把判据参数化，**判据本身仍在执行面**。而我还把它封进了名叫 `RoundFacts` 的对象 —— 判定结果被贴上"事实"的标签，这比明着判更糟。

**硬伤三（最严重）：默认极性反了。**
上一版定「`counts` 默认 `false`，只有产物证据能翻成 `true`」，并宣称"一个默认不放行的判据没有弃权谓词可以死"。

**这与「判决拔掉系统照跑」直接矛盾。** 默认不放行 ⇒ 判据缺席时一切都不算数 ⇒ 拔掉判决面系统全停。
上一版之所以看起来能跑，正是因为**判据被放在执行面所以永远在场** —— 用"判决不可拔除"换来的"安全"，恰好是本次要消灭的东西。

> **判据外挂之后，默认极性必须是「放行」。**
> 判决在场 → 可以拦；判决不在 → 不拦，照跑。这才是"没兜底"的准确形态。

---

## 一、三分铁律（结构保证，不是纪律要求）

```
      ①记录 ──────────────► ③反应        允许：按事实行动
        │                      ▲
        │                      │
        ▼                      │
      ②判定 ─── veto ──────────┘          唯一一条 ②→③ 边
```

| # | 铁律 | 机器化设防 |
|---|---|---|
| R1 | **②→③ 只有一条边：`veto`**，且只能"拦"，不能"放行" | 接口只有一个否定方向的返回值 |
| R2 | **`veto` 缺席 = 放行** | 判定面不存在时，调用点拿到 `null` → 继续 |
| R3 | **② 不得回写 ①** | 判决账本是判定面私有存储；`lib/round/**` 不得被 `lib/judgment/**` import |
| R4 | **③ 不得产出结论** | 反应面禁止出现 `合格`/`ok`/`pass`/`verdict` 语义的派生 |
| R5 | **① 不得含判据** | `lib/round/**` 的导出里不得有返回"质量布尔"的函数 |

R1–R5 全部配 import 闭包测试 + grep 锁，**不依赖用例覆盖**。

---

## 二、执行面词汇去判决化

### 2.1 状态词汇（这是本计划的核心一刀）

`COMPLETED` / `FAILED` / `AWAITING_INPUT` **从执行面消失**。它们今天装了三件不同的事：

| 今天塞进 FAILED 的 | 本质 | 重做后去哪 |
|---|---|---|
| 会话崩了 / 超时 / 硬停 | **执行状态**（≈ Temporal 的 Failed） | `closedBy: "halt"` + `halt.kind` |
| agent 自己说失败了 | **业务返回值**（≈ Temporal 的 workflow 返回值） | `declared.status: "failed"` —— **转述，不是平台的看法** |
| **平台看没产物，自己下的结论** | **判决** | **执行面不再产生它**；判定面要判就自己判 |

外部系统一致：**LangGraph 无 status；AutoGen 只有 `stop_reason` 字符串；Dify 的 failed = 节点抛异常；Temporal 的 Failed 严格指未处理异常。** 没有一个在平台层说"干得好不好"。

### 2.2 新的执行面真值

```js
// 合约执行状态 —— 全部是事实，零结论
{
  lifecycle: "running" | "closed",
  closedBy:  "agent_end" | "halt" | "declaration" | null,
  halt:      { kind: "hard_stop"|"timeout"|"crash"|"orphan", reason } | null,
  deliverable: { path, bytes, mtimeMs } | null,     // 平台看盘所见,不含"合格"
  declared:  { status, summary, reason, via, at } | null,   // agent 原话转述
  closedAt:  number | null,
}
```

**`deliverable` 是"看到了什么"，不是"合不合格"。**
非空判断、新鲜度、控制载荷分类、`minBytes` —— **全部移出执行面**，进判定面。执行面只做一件事：把 outbox 里本轮出现的文件列出来，带上 `bytes` 与 `mtimeMs` 两个**测量值**，让判定面自己去判。

> ⚠ 唯一保留在执行面的"看盘"是 **`mtimeMs >= sessionStartMs`**（本轮 vs 上一轮残件）。
> 理由：这是**归属**问题不是质量问题 —— "这个文件属于哪一轮"跟"这个文件好不好"是两件事，前者是事实。

---

## 三、模块清单（三分归位）

### ① 记录面 `lib/round/` + `lib/audit/`

| 文件 | 职责 | 行数 |
|---|---|---|
| `lib/round/round-ledger.js` | 内存台账：工具调用 / 中断 / 采集 / 声明。**零判据** | ~110 |
| `lib/round/round-declaration.js` | 声明归一（只校验 status 枚举合法，**不判对错**）+ L3 文件劈分 | ~80 |
| `lib/round/round-observation.js` | 列 outbox 本轮文件 + `bytes`/`mtimeMs`。**取代 `artifact-evidence`** | ~90 |
| `lib/round/round-facts.js` | 唯一构造点 + freeze + `ROUND_BRAND` 封印。**内含零结论** | ~150 |
| `lib/audit/session-audit-log.js` 等 5 件 | 从 `lib/evidence/` 搬家，内核不改，非承重 | 0 净增 |

对比上一版：**`round-decide.js` / `round-copy.js` 删除（它们是 ②）；`artifact-evidence.js` 降级成 `round-observation.js`（去掉 `ok`）。**

### ② 判定面 `lib/judgment/`（全新，全外挂）

| 文件 | 职责 | 行数 |
|---|---|---|
| `lib/judgment/criteria-registry.js` | 判据注册表：每条判据 = `(facts) => Finding \| null` | ~70 |
| `lib/judgment/judge.js` | 跑注册的判据，产出 `Verdict` | ~90 |
| `lib/judgment/verdict-store.js` | 判决账本（**执行面禁读，治理链要读** —— 见 §3.5） | ~80 |
| `lib/judgment/patterns.js` | **聚合面**：把 per-round verdict 卷成"系统哪里要改" | ~110 |
| `lib/judgment/veto.js` | **唯一对执行面的边**：`resolveVeto(facts) → {blocked, reason} \| null` | ~50 |

**内建判据（可全部关掉）：** 空产出、控制载荷、陈旧镜像、`minBytes` 未达、声明与产物矛盾（说 completed 但盘上什么都没有）。

```js
// Verdict —— 执行面不认识它;治理链认识
{ roundKey, agentId, contractId, verdict: "pass"|"fail"|"inconclusive",
  findings: [{ code, detail }], facts: <引用>, judgedAt }
```

### 3.5 判决面的真正主顾是治理链，不是执行面

判决的产出**不是给执行面用的**。执行面只从它拿一条 `veto`，而且缺席即放行。
真正的消费者是四关节自治链：

```
Harness(工具) ── CLI-system(手) ── Operator(脑) ── Automation(最终目标)
```

**角色定位**：`agent` 执行用户给予的任务；**`operator` 观测运行状态、检测运行状态，输出是优化当前的系统**。

实测 operator 已在读 12+ 个 inspect 面（`agent_graph` / `automation_runtime` / `harness_runs` /
`guidance_drift` / `pending_signals` / `loop_sessions` / `change_sets` …），
automation 消费 `governanceSnapshot` / `EvaluationResult` / `trustLevel` / `ProfileLifecycle`。

> **由此定向：判决账本按「系统哪里需要改」设计，不按「这一轮算不算数」设计。**

这条解释了旧考官为什么废。实测 241 条判决里 **185 条是零期望空判 `fulfilled`**，只有 7 条带判据。
当时诊断是"判据写入面只有一个入口" —— 那是表层。**真因是产出形状对错了主顾**：

| operator 真正要问的 | 旧考官给的 |
|---|---|
| 哪个 agent 反复空产出？ | 单轮 fulfilled |
| 哪条图边反复卡住？ | 单轮 fulfilled |
| 哪个 skill 装了不生效？ | 单轮 fulfilled |
| 哪类任务持续超预算？ | 单轮 fulfilled |

**per-round verdict 是原料，不是产品。** 判决面必须自带 `patterns.js` 聚合面 + 一个 inspect surface，
否则它产出的东西没有消费者 —— 这正是 185 条空判无人问津的结构原因。

**边的方向再明确一次：**

```
①记录 ──► ②判定 ──► 判决账本 ──► ③′治理链(harness/cli/operator/automation) ──► 改系统
             │
             └── veto ──► ③执行面        ← 唯一一条,缺席即放行
```

③′ 治理链是**另一类反应** —— 它反应的是**结论**（合法，因为它本来就是判决的下游），
而 ③ 执行面反应的是**事实**。两者都叫"反应"，但吃的东西不同，**不可混为一谈**。

### ③ 反应面（现有模块，改成读事实）

| 反应 | 今天读 | 改读 |
|---|---|---|
| 关合约 | `evaluateContractOutcome` 的结论 | 本轮结束了（事实） |
| 转不转发 | 交接门（已死） | `deliverable != null` **且** `veto` 未拦 |
| 回投什么 | `terminalOutcome.status` 分支 | `deliverable` 正文；没有就投 `declared` 原文 |
| 重不重试 | `ABANDONED` 判据 | `deliverable == null && retriesLeft > 0` |
| 熔断 | `resolveAuthoritativeHardStopOutcome` | `noteHalt` + 走同一条收口 |

---

## 四、被重新归类的整个子系统

三分不只重排函数，也重排**子系统归属**：

| 子系统 | 今天以为它是 | 实际是 | 处置 |
|---|---|---|---|
| `automation-decision.js` | 执行面 | **判决面的下游**（`:184,195,210,221` 直接按 `verdict === "fail"\|"regressed"\|"inconclusive"` 与 `continueHint` 分支） | 留在原地，但**明确登记为判决消费者**；判决缺席时降级为预算驱动（**今天已经如此**：`effectiveEval` 为 null 就走预算） |
| `harness` gate | 执行面塑形 | **第二套判定** | 本轮不动（硬约束），但登记进 ②，与新判定面的关系留给下一批 |
| `reviewerResult` 链 | 判决语汇 | **① 记录**（"agent 在文档里写了什么"的观测） | 留执行面，改名以去掉判决味 |

> `automation` 这条最值得记：它一直被当成执行面的一部分，实际它的每个分支都在读结论。
> **判决面拔掉后 automation 只能按预算跑满** —— 这个后果必须写进"没兜底"的清单，而不是当 bug 修。

---

## 五、删除清单（按批，1 个跨块运行时文件即 fail）

| 批 | primary | 内容 |
|---|---|---|
| **P0** | — (git) | 先把在飞改动提交收口，否则起点就是红的 |
| **B1** | `verification-docs` | wiki 三分决策页；`system-block-registry` 加 `lib/round/`→local-execution、`lib/judgment/`→**新块 judgment-plane**、`lib/audit/`→runtime-core；改 `system-layer-boundary.test.js` 两张表 |
| **B2** | `local-execution` | 新建 `lib/round/` 4 模块（**零接线，死代码**） |
| **B3** | `judgment-plane` | 新建 `lib/judgment/` 4 模块（**零接线**） |
| **B4** | `runtime-core` | `lib/evidence/` → `lib/audit/` 搬家；新建执行面状态字段（与旧 status 并存） |
| **B5** | `local-execution` | **接线总批**：agent_end 新 `settle_round`；删交接门 + 硬停闸 + 三个存在性谓词；crash/timeout/orphan 并入 |
| **B6** | `graph-dispatch-queue` | 采集侧撤默认注入；L3 劈分；`terminal-commit` 去字符串反解 |
| **B7** | `routing`(delivery) | delivery 改读事实 |
| **B8** | `projection-ui` | dashboard 改读事实 + 可选读判决账本 |
| **B9** | `runtime-core` | **删 `contract-outcome.js` 整文件**；`terminal-outcome` 换成事实 schema；删旧 status 词汇 |
| **B10** | `verification-docs` | `--preset round` live 负例 + 三层拔除测试 + grep 锁 |

**次序铁律：B7/B8 必须早于 B9。** 先砍字段而下游没迁 = 静默变空白，正是本轮要拆的病的同型。

---

## 六、验证 —— 拔除测试是唯一的验收

### 6.1 结构性（不依赖用例覆盖）

```bash
node --test tests/three-plane-import-closure.test.js
```
- `lib/round/**` 与全部 ③ 的**传递** import 闭包不得命中 `lib/judgment/`
- `lib/judgment/**` 不得 import 任何 ③
- `lib/round/**` 的导出里不得有返回质量布尔的函数（R5）

### 6.2 物理拔除（最硬的一条）

```bash
rm -rf lib/judgment/ && node test-runner.js --preset dispatch && \
node test-runner.js --preset pipeline && node test-runner.js --preset system-action
```
**判定标准：全绿。** 这不是比喻 —— 判决面整个目录删掉，四条 live 链路必须一条不断。

### 6.3 live 负例（`--preset round`，7 条）

> 实证：`lib/formal-runtime/` 里 grep `maxToolCalls|hard.?stop|handoff|control_payload` **零命中**。
> **四件全坏，现有 4 预设照样全绿** —— "重做后全绿"不构成任何证据，必须补负例。

| ID | 构造 | 断言 |
|---|---|---|
| `round.no-deliverable` | 什么都不写 | `deliverable: null`；下游**未**收到投递；合约 `closed` |
| `round.declared-failed` | 产物齐全 + `submit_output(failed)` | `declared.status: failed`；用户收到 reason 原文 **+ 产物正文** |
| `round.judgment-absent` | 删掉 `lib/judgment/` 跑同一条 | **与判决在场时的执行动作逐字节相同** |
| `round.veto-blocks` | 判决在场 + 空产出 | `veto.blocked: true`；转发被拦 |
| `round.hardstop-silent` | `maxToolCalls` 触顶 + 零声明 | `closedBy: halt`, `halt.kind: hard_stop` |
| `round.stale-mirror` | 上一跳产物仍在盘上，本跳零产出 | `deliverable: null`（归属判定，非质量） |
| `round.unmanaged` | 无合约腿 | 不写任何终态、不触发投递 |

### 6.4 挂载前置（不过就是空跑）

`submit_output` 今天对 10 个 agent **物化 0/10**。health 补一条平台服务挂载检查 —— 否则"门死了没人发现"会原样复发，这次死的是声明入口。

---

## 六甲、三条裁定（2026-08-10 用户）

### 甲-1 `AWAITING_INPUT` 整体删除

**不是砍功能，是把既有缺陷正式化。** 实证：`crash-recovery.js:322` 把它列进 `TERMINAL_STATUSES`
直接跳过；全库**零条**从 `awaiting_input` 恢复的路径；`contracts.js:159` 广播的
`TASK_AWAITING_INPUT` 事件**无消费者**。合约进去就永久停在那里。

连带清除：`clarification` 字段（`delivery-terminal.js:51` 专为它拼文案）、
`DECLARABLE_STATUSES` 里的 `awaiting_input` / `hold`、
`HARNESS_FAILURE_CLASS.AWAITING_INPUT` + `provide_missing_input_then_resume` 建议词。

删后 agent 表达"缺东西"只剩一条路：**声明 `failed` + `reason` 写清缺什么**。诚实优于假装有等待态。

`DECLARABLE_STATUSES` 收缩为 `["completed", "failed"]`。

### 甲-2 `expectations` 的归属纠正（推翻本计划早期的误判）

**误判**：本计划早期把 `expectations` 说成"agent 自己写判据 = 被评者定判据，可疑"。**错了。**

**原设计（备忘录133 §7.5 原话）**：

> `primaryArtifactPath` 由 `expectations.requiredArtifacts` 指定
> —— **该交什么是派工时说好的，不是干完活由干活的人指认**

写 `expectations` 的是**派工方**（`assign_task` 调用者），约束的是**接活方**的合约 ——
**甲方定验收标准**，正当设计。防线在**受理时刻**：schema 校验，不合格当场结构化拒绝（备忘录128 §二）。

**真问题不是"谁写"，是"只有一个入口能写"** —— 原设计五个建约点，今天一个活着：

| 建约入口 | 位置 | 现状 |
|---|---|---|
| `assign_task` 派工 | `system-action-runtime.js:211` | ✅ **唯一活路径** |
| ingress 固定管线 | `dispatch-execution-contract-entry.js:291` | ⬜ `buildHopExpectations()` 恒 null |
| `request_review` 评审腿 | `system-action-request-review.js:360` | ⬜ 不传 |
| delivery 派生 | `delivery-system-action-helpers.js:155` | ⬜ 不传 |
| loop 建约 | `loop-contract-builder.js:61` | ⬜ 无此字段 |

**同时收回一条记述**：`buildHopExpectations()` 恒 null **不是"已裁定的边界"**（备忘录137 记错了）。
原文是「**不是坏了，是没有数据源**」—— 它是**决议20** 给"图 schema 静态定义期望"预留的挂点，
先落了签名与调用点。是**设计好但没建**，不是"决定不做"。

### 甲-3 `harness` 名字删除，设计原理拆进三面

**harness 不是"第二套判定"，是一个横跨三面的捆绑包** —— 这是它一直让人困惑的根因：

| kind | 实际属于 | 新家 |
|---|---|---|
| `guard.*`（budget/tool_access/scope） | **③ 反应**（执行前拦） | `lib/lifecycle/guards/` |
| `collector.*`（artifact/trace） | **① 记录** | `lib/round/collectors/` |
| `gate.*`（artifact/schema/test） | **② 判定** | `lib/judgment/criteria/` |
| `normalizer.*`（eval_input/failure） | ② 的输出归一 | `lib/judgment/` |

与新判定面重复的**只有 `gate` 那一块**，不是整个 harness。

**保留 harness 独有的两个思想：**

1. **模块化 + 组装校验** —— expectations 完全没有这层
2. **`gate_without_collector`** —— `harness-composition.js:50` 原文「有 gate 但无 collector：判定缺证据来源」。
   **这正是三分模型 R3/R5 的机器化形态，而我在计划里只写成了散文。**

**升级**：harness 今天该条是 `severity:"info"`（只提示）。新规则改为**硬约束** ——
每条 criterion 必须声明它依赖哪个 collector，**声明不出来就注册失败**。

**分工定案**：`expectations` 是**数据**（声明式、派工时定、受理时校验），
criteria 是**代码**（模块 + kind + 组装规则）。**一条 criterion 读一段 expectations。** 两者不冲突。

**名字**：不给这个捆绑包起名 —— 它本来就不该是一个东西。四块各归各家。

---

## 七、代价（诚实清单，不假装解决）

| # | 代价 | 状态 |
|---|---|---|
| 1 | ~~`AWAITING_INPUT` 唤醒回路~~ | **已裁定：整体删除**（甲-1） |
| 2 | `automation` 在判决缺席时只能按预算跑满 | 已接受，写进"没兜底"清单 |
| 3 | 爆炸半径实测 **14 个模块**在分支 `CONTRACT_STATUS` | 已排进 B7–B9 |
| 4 | 声明跨进程丢失窗口无法消除 | 缩到"调工具→结算"之间的进程死亡，明写不假装解决 |
| 5 | 判决面重建后，「谁来定判据」仍未答 | 留给判据注册表的使用者 |

---

## 八、与上一版的差异（一句话）

| | 上一版 | 本版 |
|---|---|---|
| 判定器位置 | 执行面（`decideRound`） | **判定面（可整体删除）** |
| 默认极性 | 默认不算数 | **默认放行**（否则拔掉判决就全停） |
| `evidence.ok` | 封进 `RoundFacts` 当事实 | **删除**，降为 `bytes`/`mtimeMs` 两个测量值 |
| 状态词汇 | 保留 COMPLETED/FAILED | **去判决化**为 `lifecycle` + `closedBy` |
| 验收 | 4 预设全绿 | **`rm -rf lib/judgment/` 后 4 预设全绿** |

---

**本轮未修改任何文件。**
