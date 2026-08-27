# 产物交接流转系统 · 静态健康报告

> ⚠️ **历史快照,勿当现状读**(标注于 2026-08-09)。此后已落地:动态协作不查图边(v179)、协作主路从 `[ACTION]` 标记换成 FC 工具、采集不再要求 `outbox/runtime_result.json` 提交令牌(v181)、`upstreamPackages` 升格为 `{path,producer,files[],primary}` 对象、`_manifest.json` 机制已删除。正文保留当时原貌。

作用范围：`agent outbox → collectOutbox → contract.output/整包留存 → routeInbox 注入 → 有界压缩 → evaluateContractOutcome/handoff 门 → delivery`
方式：**全程静态**（读码 + grep + 读测试 + 只读 ls/cat 磁盘现状）。未启动/重启网关、未跑 test-runner、未派工、未跑测试套件。少数纯函数用 `node -e` 直接 import 求值（无 I/O）。

---

## 1. 总体结论

**这条链现在是通的，但判定层不可信 —— 结论是「可运行，有明确问题，非崩溃型」。**

骨架比我预期的扎实：语义判定只有 `evaluateContractOutcome` 一份实现、终态落盘只有 `commitSemanticTerminalState` 一个入口、`saveAgentArtifact` 全库单一调用点、outbox 协议以 `runtime_result.json` 为唯一真值且硬拒 legacy、预算取舍只有 `computeContextBudgetPlan` 一个纯函数、v133 mirror-bug 的修复在 v171-v173 大重排后完整存活并有注释+命名回归测试+错误码三重加固。整条链任何一处子系统崩掉都不会打断 inbox 投递或 agent_end（try/catch 兜底是真的成立的）。**重排没有伤到核心**，现存的死代码是重排前就有的遗留。

问题不在"跑不通"，而在"静默做错"，集中在三类：**(a) 判定门用错谓词**——控制噪声分类器把一组为 20 字控制片段设计的非锚定子串正则直接 `.test()` 到整篇交付物正文上，合法长文提到「runtime 语义」「根据系统提示」就整份判 FAILED；**(b) 门的覆盖面小于它的注释**——handoff 完成门对带 `pipelineStage` 的 loop 合约完全不生效，而多环协作的主力形态正是 loop；**(c) 四个目录全都只增不清**（`inbox/upstream/`、`outbox/`、`control-plane/output/`、`artifacts/<cid>/<producer>/`），唯一的清理器 `cleanInbox` 只删顶层文件、显式跳过目录。第三类不是理论问题：此刻 `~/.openclaw/workspaces/worker/inbox/` 里 `contract.json` 已被清掉，只剩 `upstream/planner/{brief.md,manifest.json}`，manifest 写着上一份合约的 `TC-1785095975012-ba2e06` —— 上一合约的 brief 正躺在 worker 的 inbox 里等下一个合约。

一句话：**产物搬得动、搬得对；判它成没成、拦不拦下一环，这两件事现在有真实误判面。**

---

## 2. 逐环健康度

| 环 | 判定 | 一句话理由 |
|---|---|---|
| L1 采集（outbox → contract.output 正本） | 基本健康有隐患 | mirror 修复三重加固还在、协议单真值无双轨；但观测层把采集失败反转成 `collected:true`，且提交非事务化 + outbox 永不清理 |
| L2 整包留存（`artifacts/<cid>/<producer>/`） | 有明确问题 | 跨 producer 隔离与阶段序（preserve 早于 route）扎实且被测试锁死；但空产出会回退共享 `contract.output` 打成"自己的包"，hop≥2 必然是别人的字节 |
| L3 下游注入（`inbox/upstream/` + 指针） | 有明确问题 | 顺序、指针目标、`packages` 而非 `copied` 的门控都对；但 upstream 目录从不清理，且 E-CONTRACT-006 这道体检门证明不了注入真的发生 |
| L4 有界压缩（2MB 预算） | 核心健康、集成层有问题 | `computeContextBudgetPlan` 是真正的纯函数单一真值、字节池确实跨 producer 共享、大文件不饿死小文件；问题全在它之外（陈旧 marker、清单自身不计预算） |
| L5 判定门控（outcome + handoff 门） | 有明确问题（最该先修） | "runtime_result 说完成不算完成、必须有文件系统证据"这条核心防线立得住且有测试；但控制噪声谓词误杀长文、handoff 门漏掉 loop 分支、FAILED 对外是空壳 |

> 说明：L5 的对抗复核输出在第 2 条后被截断，因此 L5 的 #3/#8/#9/#10 我**亲自做了独立静态抽验**并在下文标注；其余 L5 条目按"审计已出、未经二次复核"处理，不进第 3 节。

---

## 3. 确证问题（verifier CONFIRMED，跨环重复项已合并）

### 🔴 H1 · `inbox/upstream/` 永不清理 → 跨合约上下文污染（L3-F1 ＋ L4-F1 ＋ L2-F3 合并）

**坏在哪**：写入端 `dest = join(upstreamRoot, up, f.relPath)`（`artifact-store.js:275`，该模块已于 v218 收店，后继=`lib/delivery/upstream-package-inflow.js`）**不带 contractId**，而唯一的 inbox 清理器只删顶层文件：

```js
// lib/routing/mailbox/runtime-mailbox-transport.js:69-71
for (const entry of entries) {
  if (!entry.isFile()) continue;   // ← inbox/upstream/ 是目录，永不被删
```

全库生产代码零处删除 `inbox/upstream`（只有 admin RESET 和测试 fixture 会 `rm -rf`）。而当时的 `artifact-flow.test.js`（该测试已随 v218 artifact-store 收店删除）每个用例前都自己 `rm -rf upstreamRoot` —— **测试亲手做了生产代码不做的那件事**，所以这个洞永远不会红。

**现场证据（磁盘，只读）**：`~/.openclaw/workspaces/worker/inbox/` 当前只剩 `upstream/planner/{brief.md,manifest.json}`，`manifest.contractId = TC-1785095975012-ba2e06`，同目录 `contract.json` 已被 cleanInbox 删除。另在 workflow-trace 里抓到 `TC-1780258898729-ea03c3/reviewer1/inbox/upstream/worker-e/` 同时躺着三个不同 contract 的交付物，而该包 manifest 只列 1 个文件；同一 trace 的 `inbox/contract.json` 里 `upstreamPackages:["upstream/worker-e/"]` —— **指针正指向这个混着三代产物的目录**。

**失败场景**：reviewer 按 `role-spec-registry.js:13` 的指令「read those upstream packages under inbox/ as your brief and input for **this** contract」去读 `upstream/worker-e/`，读到本轮 + 前两轮的混合体；上游本轮没产出时（`artifact-store.js:245` `if (!existsSync(srcPkg)) continue;`）整包上一轮的残留原样留着，且因为 `packages=[]` 时不写指针，agent 连"这包是旧的"都无从判断。

**连带**：同一根因让上一轮的 `COMPRESSED_MANIFEST.md` / `_MISSING.md` 永久滞留（`artifact-store.js:85-86` 只有"不写"没有"撤销"）。`_MISSING.md` 正文是「这些上游的上下文在本 inbox 缺失——不要当作『上游没产出』」（`context-compression.js:112-113`），在上游其实完好送达的那一轮，这句话会直接把 agent 推向"我缺料"的错误分支。

**修法**：`artifact-store.js:270` 之前一行 `await rm(upstreamRoot, { recursive: true, force: true })`（本 agent 自己的 inbox，语义安全，已在 try/catch 内）。**一刀同时解掉污染与陈旧 marker**。不要去改 `cleanInbox` 递归删目录——那会波及 inbox 下其它子目录，超出本链职责；清场应由写入方负责（谁写谁清）。

---

### 🔴 H2 · 控制噪声分类器用非锚定子串匹配整篇正文 → 真交付物判 FAILED（L5-F1）

**坏在哪**：`contract-outcome.js:55-66` 对 `semanticText` 需求读**整个文件**再交分类器，而 `buildFallbackRequirements`（`:100-105`）对每个带 `contract.output` 的合约强制 `semanticText:true`——这条路径默认全开。分类器对全文做 `.test()`：

```js
// lib/delivery/runtime-user-facing-output.js:62-68
return CONTROL_TEXT_PATTERNS.some((pattern) => pattern.test(normalized));
```

`CONTROL_TEXT_PATTERNS`（`:5-16`）10 条里只有 `/^\[ACTION\]/u` 和 `/^[A-Z][A-Z0-9_:-]{2,}$/u` 有锚（后者无 `m` 标志，必须整串匹配），其余 8 条全是无锚子串：`/runtime 语义/u`、`/根据系统提示/u`、`/\[LOOP DETECTED\]/iu`、`/请直接写入本轮约定的结果文件/u`、`/Write relative path outbox\/runtime_result\.json/u` …

**为什么高频**：`runtime 语义：` 正是 `hooks/before-tool-call.js` **全部 blockReason 的固定前缀**（:182/194/206/217/228/240/257/378/395）——agent 在交付物里复述一次自己被拦的原因就中招。本平台的 agent 大量产出系统审计/运维文档，命中率不低。

**失败场景**：一份 5000 字合法 markdown，正文任意位置出现上述词 → `invalid_semantic_payload:control_text` → FAILED。用户拿到 `delivery-terminal-runtime.js:76` 的空壳「❌ 任务失败\n任务未完成。」，产物其实好好躺在盘上。

**曝光面校正（比原审计窄一档）**：loop 合约根本没有 `contract.output`（`loop-contract-builder.js` 不写 output 字段），这条检查只打 dispatch 主干 lane。另外 `hooks/before-tool-call.js:250` 有一次写时分类，但只在 `canonicalToolPath === contractOutput` 时触发，而平台约定 agent 只写 `outbox/` → 主干 lane 完全绕过写时守卫，**结局判定是唯一一次分类，误杀静默发生**。

**修法**：给 `matchesControlText` 加长度闸——只有 trim 后 ≤200 字才允许非锚定模式判 `control_text`；或把这 8 条改成"整段等于/以之开头"。分类器现在同时服务 `isToolOutcomeError`（20 字工具结果）和交付物正文（数千字），两者必须拆成两套阈值。

---

### 🔴 H3 · handoff 完成门不覆盖 loop 分支（L5-F3，我独立确证）

**坏在哪**：`agent-end-graph-route.js:440-447`（现址=`lib/lifecycle/agent-end/graph-route.js`，行号为当时快照）：

```js
const contractStage = contractRouteStage(contractData);
if (contractStage) {
  ...
  return routeLoopTaggedSharedContract(context, contractStage);   // ← 直接 return
}
```

`resolveIncompleteHandoffGate` 只在 `:484` 的非 stage 分支被调用。而 `loop-contract-builder.js:78` 给**每一个** loop 合约都写了 `pipelineStage`，`agent-end-graph-route.js:237-247` 每次 loop 路由还继续续写。

**失败场景**：研究回路里某环 agent 写了 3 字占位产物，`routeLoopTaggedSharedContract` 照常 `routeAfterAgentEnd` 派给下一环，下游拿空包继续做。**门保护的正是多环协作，而多环协作的主力形态恰是唯一不过门的形态。**

**同门另两处确证缺陷**：门只量字数（`:142-145`，阈值 24），不复用 `classifyRuntimeControlPayload`（全库该函数在 `lib/lifecycle/` 零 import）——一段 200 字的 `[ACTION] ...` blob 长度过关照样转发；门只认 `executionObservation.primaryOutputPath`，无 `contract.output` 回退（隔壁 `preserve_artifact` 有，`agent-end-stage-definitions.js:212-214`），零产出时 `return null` 直接放行；注释里说的「无文件交既有 progress gate」不成立——`resolveHardStopProgressGate` 只在 `if (hardStopGate)` 内部被调，正常路径零门。

**修法**：把门提到 `runAgentEndGraphRoute` 里两分支之前的公共位置（loop 分支在 `:305` 已有 `resolvedRoute.target`，`:309` routable 判断后立即过门）；门的判据改为 `isDeliverablePayload(content, {minChars})` 共用 helper，同时带长度与控制噪声两条；加 `|| trackingState?.contract?.output` 回退。

---

### 🔴 H4 · 空产出回退共享 `contract.output` → 幽灵包（L2-F1）

**坏在哪**：`agent-end-stage-definitions.js:212-220`

```js
const primaryOutputPath = obs.primaryOutputPath || context.trackingState?.contract?.output || null;
...
if (artifactPaths.length === 0 && primaryOutputPath) artifactPaths = [primaryOutputPath];
```

`contract.output` 是每合约**唯一固定路径** `join(outputDir, ${contractId}.md)`（`dispatch-execution-contract-entry.js:310`），graph 转发复用同一 contractId（`agent-end-graph-route.js:481/490`），所以 A/B/C 三跳共用同一个文件。而 `artifact-store.js:151-154` 的唯一筛选是 `.filter(p => p && existsSync(p))` —— **无 producer 归属、无 mtime 新鲜度**。同仓 `protocol-commit-reconcile.js:271-278` 对 outbox commit 已有 `commitMtimeMs < contractStartMs → commit_file_stale` 的判据，说明这套标准在本仓有先例。

**决定性证据（把"可能"推到"必然"）**：让 agent 能写 `contract.output` 的工作区软链 `ensureWorkspaceContractOutputAlias` **全库零调用点**（只命中定义 `runtime-contract-output-alias.js:56` 与其测试；该模块后已整体删除，与本条 L1 的处置建议一致）。全库对 `control-plane/output/<cid>.md` 的唯一写者是 `runtime-mailbox-outbox-helpers.js:161-165` 的 mirror。所以在 hop≥2 上，`contract.output` 的内容**只可能**是上一跳（或本 agent 上一轮）的镜像 —— "空转的下游 agent 生成一个内容属于别人的产物包"是构造性成立的。

**失败场景**：A→B→C。A 完成并 mirror；B 进程 success 退出但没写 outbox（`runtime-mailbox.js:89-92` 返回 `{collected:false}`）→ 回退到 A 留下的 `output/<cid>.md` → 落成 `artifacts/<cid>/B/` 包 + `manifest{producer:B, status:completed}` → C 的 inbox 收到 `upstream/B/` 实为 A 的正文。同时 `resolveIncompleteHandoffGate` 在 outputPath 为空时 `return null` 不拦，链路照常转发，B 的空转被产物包完全掩盖。

**修法**：**不能删回退**——`artifact-flow.test.js:240` 静态断言了这一行；但测试锁的是 `artifactPaths.length===0 && primaryOutputPath`，**没锁** `|| trackingState?.contract?.output` 这个来源。加门不会撞护栏：仅当 `obs.collected === true`，或该文件 `mtime >= trackingState.startMs` 时才允许把 `contract.output` 当本 producer 的产物。

---

### 🟠 M1 · `normalizeExecutionObservation` 把采集失败反转成 `collected:true`（L1-F2 ＋ 复核漏项，合并）

**坏在哪**：`lib/stage/execution-observation.js:96-108` 的 OR 链末两项：

```js
normalized.collected = normalized.collected === true || Boolean(
  ... || normalized.primaryOutputPath || normalized.error
);
```

两条独立的错误置真通道：

1. `|| normalized.error` —— `error` 是采集失败的**唯一载体**（helpers:227 legacy manifest 拒收 / :231 缺 runtime_result / :241 invalid / :342 parse error）。纯函数实测：`{collected:false, error:'missing runtime_result.json'}` → `collected = true`。
2. `|| normalized.primaryOutputPath` —— 更宽：`agent-end-terminal.js:135-138` 用 `fallbackPrimaryOutputPath: effectiveContract?.output` **无条件**塞进去（`execution-observation.js:64-75`），而每份派工合约都有 output。实测：`materializeExecutionObservation({collected:false}, {fallbackPrimaryOutputPath:'/…/TC-X.md'})` → `collected=true`，**该文件存不存在根本没检查**。

**后果**：`agent-end-transport.js:29-31` 打印 `collectOutbox(...): success`；`system-action-runtime-ledger.js:98-99` `if (hasExecutionObservationPayload(...)) return null;` —— **system_action 失败几乎对所有合约都不再产生终态**。真值与日志双向说谎。

**修法**：从 OR 链删掉 `|| normalized.error` 与 `|| normalized.primaryOutputPath`（error 字段本身保留在记录里；fallback 只能影响 artifact 展示，不参与 `collected` 判定）。

---

### 🟠 M2 · outbox 提交非事务化 ＋ outbox 永不清理 → 陈旧产物错发（L1-F5 ＋ F6 合并）

**坏在哪**：`runtime-mailbox-outbox-helpers.js:154-172` 的循环顺序是 `copyFile(dest)` → `artifactPaths.push` → 镜像 `copyFile` → `removeFileQuietly(src)` → `collected.push`。镜像抛错时 catch 在 `:169`，留下 **dest 已写 / artifactPaths 已含 / collected 不含 / 源文件仍在 outbox** 的半提交态；`:282` 的 `removeFileQuietly(runtime_result.json)` 随后**无条件**执行。所有失败分支（`:225-228/:230-232/:239-242/:340-343`）都提前 return 且不删任何文件，全库无 outbox GC（`cleanInbox` 只清 inbox）。

**最硬的后果（比"永久瘫痪"更严重）**：截断的 `runtime_result.json` 其实是自愈的（下一轮会覆盖）；真正的毒是**未被搬走的产物文件**——它们会被下一轮 `helpers:247-251` 的隐式产物兜底原封不动采走，进 artifactPaths，还可能被 `helpers:100` 的"第一个 .md"规则选成 primary，然后镜像进**下一份合约的 contract.output**。这是内容级别的错误交付。

**另一半**：镜像用 `copyFile`（截断+写），而 `contract.output` 正是 `contract-outcome.js:45-56` 直接 stat/readFile 的目标；仓内已有 `atomicWriteFile`（`state-file-utils.js:13-17`，全库 84 处使用）却没用在产物提交上。进程中途死掉 → 截断交付物；`nonEmpty` 只看 `size>0`，半截 markdown 大概率放行。

**修法**：(1) 全部 copy 成功后再统一 unlink 源文件与 runtime_result，任一失败保留 runtime_result 保证可重放；(2) 镜像与 dest 改 tmp + rename；(3) 采集入口加陈旧检测（产物 mtime 早于本合约 stage 时间则丢弃并 warn，parse 失败的 runtime_result 改名为 `.invalid-<ts>.json` 移出采集视野）。

---

### 🟠 M3 · producer 包目录只增不清，manifest 只描述最后一次（L2-F2）

`artifact-store.js:156-171` 只 `mkdir` + 逐文件 `copyFile`，全函数无 unlink；`:190-191` manifest 被整体覆盖。而下游取包走**目录枚举**而非 manifest：`:247 listPackageFiles(srcPkg, srcPkg, enumErrors)`，与 `manifest.files` 完全无关。同 `(cid, producer)` 二次留存两条路径都成立：loop 复用同一 contractId（`agent-end-graph-route.js:487-490`，`computeLoopNextRound` 只做 round+1）；crash retry 走 RETRY_SUSPEND 保留 tracker（`runtime-lifecycle.js:38-41`）并对同 sessionKey 重新唤醒（`crash-recovery.js:265-266`）。加重项：按 basename 落包，**异名必然堆积**。

**失败场景**：round1 产 `draft.md`、round2 产 `final.md` → 包里同时含两者，manifest 只有 final.md，但下游拿到两个且无标记；下游 LLM 可能按过期草稿行动。

**修法**：留存前按 (cid, producer) 清空包目录，或按 round 分子目录；或让 `copyUpstreamArtifactsToInbox` 以 `manifest.files` 为准、manifest 缺失才回退 readdir。

---

### 🟠 M4 · E-CONTRACT-006「upstream package flowed downstream」证明不了下游注入（L3-F6）

`suite-link.js:229-235` 只判 `probe.found`，而 `probeUpstreamPackages`（`suite-link-cases.js:75-107`）把 artifacts 侧与 inbox 侧命中 push 进同一个 locations，inbox 分支只看 `files.length > 0`（`:101`），**没有 cid 参数**，且 `suite-link.js:171-172` 把 inboxRoots 传成全体 agent 的 inbox。

**最硬证据（原审计漏掉）**：`lib/formal-runtime/error-codes.js:61` 的 E-CONTRACT-006 注册表明文写着判定标准是「the downstream inbox must contain `upstream/<producer>/` **plus an upstreamPackages pointer in the staged contract.json**」——而检查代码从头到尾**没有读过任何 contract.json 的 upstreamPackages**。这是注册表与实现之间可静态证明的矛盾。

**双重失明**：上游 preserve 成功、下游注入整条失败时，`artifacts/<cid>/<producer>/` 依然存在 → 照样 pass（叠加 H4 的幽灵包，artifacts 分支也被喂绿）；叠加 H1 的残留，上一轮遗留的文件被当成本轮流转证据（inbox 分支被喂绿）。**两条探测支路同时失去鉴别力，这个检查在"整包流转真的没发生"时几乎不可能报 fail。**

**修法**：inbox 分支读 `<producer>/manifest.json` 校验 `contractId === 本 case cid`（读不到 manifest 不算数）；artifacts 分支加 `producer ∈ 本合约实际 hop 序列` + 包内文件 `mtime >= 合约 startMs`；把 stage 拆成 producer-side「package saved」与 downstream-side「injected + pointer present」两条。

---

### 🟡 L 级确证项（逐条从简，均有 file:line）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| L1 | `contract.output` alias 只剩一半：`ensureWorkspaceContractOutputAlias` 生产零调用（软链从不创建），但 `canonicalizeContractOutputPath` 仍在 `hooks/before-tool-call.js:168-172` 与 `after-tool-call.js:76-89` 把写路径改写成 contract.output 并置 `commitments.outputWritten=true` | `runtime-contract-output-alias.js:56` 全库仅定义+测试 | 死代码 + 理论真值分裂；违反"不留遗留代码"红线。倾向整体删除 |
| L2 | 留存全链路零可观测：`saveAgentArtifact` 无 logger 形参、三条失败路径静默、调用方丢弃返回值 | `artifact-store.js:136-143/164-170/172/194`，`agent-end-stage-definitions.js:222-229` | 包里少文件时零痕迹。注：吞错不抛是 `:16` 写死的红线（意图），缺的只是日志与返回值检查 |
| L3 | outbox 子目录产物静默丢弃：`readdir` 未用 `withFileTypes`，目录名混入 files，`copyFile` 抛 EISDIR 仅 warn；声明的相对子路径两条分支都被过滤 | `runtime-mailbox.js:84`，helpers:`36-40/158/169-171/244-246/255-265` | 加重：目录名可能被 `helpers:88-106` 兜底选成 primary；未命中的相对路径被 `remapStageRunArtifacts:186-192` 原样保留，最终被 `contract-outcome.js:46 resolve()` 按 cwd 解析成无关绝对路径，报出误导性 missing_file |
| L4 | manifest 非原子写 + status 恒 `completed`（失败轮次也写） | `artifact-store.js:190-191/185`；`preserve_artifact` 无 match 恒执行（`agent-end-lifecycle.js:27`） | manifest.status 全库无消费方，但撕裂的 manifest 会随包进下游 LLM 上下文 |
| L5 | basename 扁平化 + 同名先到先得静默丢弃 | `artifact-store.js:159-171` `if (seen.has(name)) continue;` | 只影响 external absolute artifacts；无 failures、无 marker、下游无从知晓 |
| L6 | 压缩清单自身不计入 2MB 预算、无条目上限 | `context-compression.js:86-95` 遍历全部 rows；`artifact-store.js:292-298` 直接 writeFile | 纯函数实测 2300 条即越过 2,000,000 字节。但包文件数受 outbox 平铺限制，现实拓扑远达不到 |
| L7 | 溢出恢复指令是死指针：`<contractId>` 从未被替换 | `context-compression.js:83` 字面量；函数签名 `:76` 根本不接 contractId；`context-compression.test.js:67`（该测试已随 2026-08-16 批④ workspace 视图化删除）把它锁死 | 清单能说"缺了谁"，给不出可执行的取回动作 |
| L8 | `_MISSING.md` 写了但无指针：全失败时 `packages=[]` → 不写 upstreamPackages | `artifact-store.js:255-259`；`runtime-mailbox.js:46` 硬门控；`role-spec-registry.js:13` 只教了指针一条读法 | marker 从"只 warn 看不见"升级成"落盘但没人被指引去读"。注：`artifact-store.js:97` 已有 warn，运维侧可见 |
| L9 | 共享池按 graph 边序先到先得 | `artifact-store.js:264` `[...perProducer.values()].flat()`；`context-compression.js:52-57` 按输入序贪心 | 顺序对调结论完全反转（纯函数实测）。**但 live 图当前无任何 fan-in 节点**，今天不可触发 |
| L10 | `stat` 失败记 size=0，恒进 included 绕过预算 | `artifact-store.js:71-76`；`used+0<=cap` 在 `used<=cap` 不变式下恒真 | 竞态触发，概率极低 |
| L11 | `MANIFEST_HEAD_CHARS(800)` 与 `MANIFEST_HEAD_READ_BYTES(4096)` 之间存在未写明的不变式（≤ 读取字节/4） | `artifact-store.js:106-108` 按字节切后 `toString('utf8')` | 今天不产生乱码（比值恰好挡住），任何人把 head 调到 1200 就出 U+FFFD。零注释零测试 |
| L12 | graph edge 的 `from` 未做路径段校验就当目录名 | `agent-graph.js:25-38` 只 trim；`admin-surface-graph-operations.js:186-192` 只判非空 | 实算：源侧 `join(ARTIFACTS_ROOT,cid,'../../..')` = `~/.openclaw`（可整棵递归枚举）；目的侧解析到 `workspaces/` 根，**不在任何 inbox 内**（"密钥进下游上下文"不成立）。真实危害是越界写 + 全量递归 readdir，前置条件是控制面写图权限 |
| L13 | `listPackageFiles` 静默丢弃 symlink/特殊文件（既不拷也不记 errors） | `artifact-store.js:66-79` 只有 isDirectory/isFile 两支 | 当前包由 copyFile 生成只有普通文件，潜伏 |
| L14 | 字符串形式 `requiredFiles` 静默降级为仅存在性检查 | `contract-outcome.js:22-25` 无 nonEmpty/semanticText | 显式声明反而比不写（走 fallback 强制 nonEmpty+semanticText）更宽松，与直觉相反 |
| L15 | `requireDefaultOutputArtifact` 是零生产者死配置，且即使设置也达不到目的（我独立 grep 确证：全库仅 `contract-outcome.js:93` 一处读点） | 设了它 requirements 变空 → 落到 `:255` stageRunResult 分支 → 无 artifacts 仍 `:281-286` FAILED | 逃生口不闭合，半截 |
| L16 | handoff 门标注的 `retryable` 是死字段（我独立 grep：全库 10 处全是写入/归一化/展示，零重试驱动） | `agent-end-graph-route.js:156`；`terminal-outcome.js:39` | 字段名承诺自动恢复，实际链在此死亡需人工重派 |
| L17 | FAILED 的对外交付是空壳，判定理由不出系统（我独立确证） | `delivery-terminal-runtime.js:75` 固定 `return "❌ 任务失败\n任务未完成。"`，完全不读 outcome.reason/summary；AWAITING_INPUT 分支 `:68-73` 已是正确写法 | H2 一旦发生，用户只看到四个字，无法区分"模型没干活"与"判定门误杀"。**这是历史上 runtime 判定 bug 难定位的放大器** |
| L18 | `writeUpstreamPackagesPointer` 裸 `writeFile` 做 read-modify-write，非原子且不刷 contract-store 缓存 | `runtime-mailbox.js:62-67`；隔壁 `stageInboxContract` 用 `atomicWriteFile` + `cacheContractSnapshot`（`inbox-handlers.js:95-97`） | agent 唯一的任务真值可能读到截断 JSON；`preferCache` 读拿到没有 upstreamPackages 的旧对象 |
| L19 | `readActiveInboxContract` 硬编码 `join(OC,"workspaces",agentId,"inbox","contract.json")`，而同次采集的 outbox 走 `agentWorkspace()`（尊重 `agents.list[].workspace` 与 override） | helpers:`108-120` vs `state-agent-helpers.js:26-33` | openclaw.json 里已有目录名≠agentId 的映射（`agent-for-kksl`→`kksl`），今天不炸仅因它是 gateway agent。任何执行层 agent 一旦如此配置，**mirror 兜底整段不执行 → 确定性复现 v133 的 FAILED 形态** |
| L20 | 2MB 是**磁盘字节预算**不是 context token 预算：单文件无上限 | `context-compression.js:52` 只做聚合判定；wake 不嵌产物（`dispatch-graph-policy.js:160-165`），产物由 agent 自己 Read | 一个 1,999,999 字节的 md 完全合规，下游读进去 ~50 万 token —— 正是模块开头声称要消灭的"撑爆下游上下文" |
| L21 | 集成测试债：overflow→`COMPRESSED_MANIFEST.md`、copy 失败→`_MISSING.md` 两条路径**从未被端到端验证**；`maxBytes` 硬编在调用点不可注入 | `context-compression.test.js` 全测纯函数；`artifact-flow.test.js` 只有 4 个 copyUpstream 用例；magic number 在 `artifact-store.js:267` | 磁盘统计：817 次注入中两个文件出现 0 次。L8 那个指针漏洞能藏这么久就是因为这条路从没跑过 |

---

## 4. 需 live 确认（PLAUSIBLE-需live）

> **本次审计按要求全程静态。** 以下条目机制在代码层可证，但"是否真的发生 / 发生频率"依赖运行时状态。本项目已有**两次静态误判 runtime 判定**的前科（contract.output mirror bug 必须 live 复现才定位），因此这些**不当作确证问题**处理。

**① `contractPathsById` 索引指向 inbox 投影 → v133 mirror bug 复发通道**（L1，机制最完整）
- 已确证的机制：`contract-store.js:39-57` `rememberContractSnapshot` 对**任何**路径无条件 `contractPathsById.set(id, path)`（无共享路径守卫）；`inbox-handlers.js:96-97` 用 `atomicWriteFile` 写**投影版**、却用 `cacheContractSnapshot(dest, contract)` 缓存**完整版**（所以今天恰好能工作）；`contracts.js:48-50` `readContractSnapshotById` 不带 hint、`preferCache` 默认 true → `contract-store.js:140-142` 命中 `knownPath=inbox`。投毒点可达且不自清：`runtime-direct-envelope-queue.js:47` 用 `preferCache:false` 读 inbox/contract.json → 缓存被投影版覆盖，随后 `:98` 直接 `return 'occupied_contract'` 无 evict。
- 反向证据（为何不判确证）：`contracts.js:85 writeContractSnapshot` 会把索引重新钉回共享路径，而 `trackingState.contract.path` 正是共享路径（`session-contract-binding.js:137`）——运行期任何 `updateContractStatus` 都会修回。**投毒与修复谁最后写，静态判不了。**
- 顺带一条：那条命名回归测试**结构上永远抓不到这个复发**——`tests/outbox-stage-semantic-truth.test.js:89-129` 用 `persistContractSnapshot(getContractPath(cid), ...)` 建索引，走的是 `knownPath=共享` 的幸运分支。
- **怎么看**：在 `runtime-mailbox-outbox-handlers.js:20` 后加一行 log 打印 `shared?.output` 与实际解析到的路径 → 跑一次"worker 执行期间对同一 worker 发 direct_request" → 看 agent_end 时 output 是否为空。（不必改 `rememberContractSnapshot`。）

**② `contract.output` 陈旧产物 → 假 COMPLETED**（L5-F2）
- 已确证：`inspectArtifact`（`contract-outcome.js:45-90`）只看 isFile/size/语义/jsonPaths，无 mtime/session/round 绑定；全库无任何地方删 `control-plane/output/*.md`；`tests/terminal-outcome.test.js:137-171` 明确锁定「observation={collected:false} + 已存在的 contract.output → COMPLETED」为 intent。
- 需修正的叙事：原审计说的"loop 第 2 跳/第 2 轮"是错的——loop 合约根本不写 output 字段，fallback requirements 为空。**真实曝光面是「非 loop 多跳 graph 链的终端跳」和「crash-recovery 重试的第二次运行」。**
- **怎么看**：`--preset dispatch` 或 `pipeline` 跑一条多跳链，让终端跳 agent 故意零产出（空 outbox），抓 committed snapshot 看 `status` / `terminalOutcome.source` 是否 `completion_criteria`；顺带 `stat control-plane/output/<cid>.md` 比对 mtime 与本次 session 起点。

**③ `control-plane/output/` 扁平共享命名空间的并发覆盖**（L1-F7 ＋ L2-复核漏项）
- 已确证：`helpers:157 dest = join(OUTPUT_DIR, fileName)`，fileName 完全由 agent 决定，无 cid/agent 前缀；同目录同时住着各合约的 `<cid>.md` 正本。窗口在 `collect_transport` 与 `preserve_artifact` 之间（隔着一整个 `extract_output_markers` 阶段，含 readFile + 可能的写盘）。
- **怎么看**（只读，不需重启）：`ls ~/.openclaw/control-plane/output | wc -l` 看只增不减的规模；再对 `artifacts/<cid>/<producer>/manifest.json` 的 files 做**跨合约重名统计**——若历史上出现两份合约的包里有同名文件且 producedAt 接近，覆盖就实际发生过。**同时可用同一次观察定案 H4**：对一条跑过 ≥2 跳的 cid，比对 `artifacts/<cid>/<下游>/<cid>.md` 与 `artifacts/<cid>/<上游>/` 主产物的 md5，相同即坐实幽灵包。

**④ artifactPaths 相对路径的解析基准**（L2-F5）
- 已确证：`normalizeStageArtifact`（`stage-results.js:30-46`）只要求非空字符串，无绝对性/根域校验；未命中 outbox 的声明路径原样保留进 artifactPaths，`existsSync` 命中即 copyFile 进包并流入下游 inbox。**绝对路径变体不依赖 cwd 且已确证**（`helpers:253-265` 显式收 external absolute artifacts，是设计意图）——所以"无根域白名单"这个底层缺陷是实的。
- 未确证：相对路径按什么解析。`~/Library/LaunchAgents/ai.openclaw.gateway.plist` **没有 WorkingDirectory 键**，而 MEMORY 记的手动重启是 `cd ~/.openclaw && ...`。
- **怎么看**：`lsof -p $(pgrep -f 'openclaw gateway') | grep cwd`，一条只读命令定案。

**⑤ "无 staged contract 也照样注入"的因果归属**（L3-F2）
- 已确证可达路径：`inbox-handlers.js:145-156` 与 `:189-196` 两支先 `removeInboxContractIfExists` 再 return，而 `contractIdHint` 仍在 → `runtime-mailbox.js:41-50` 照拷 + 指针写 ENOENT 只 warn。最硬的静态例证是 `loop-cleanup.js:44-59`：中断回路先把合约置 CANCELLED、`removeDispatchContract`，紧接着 `routeInbox(assignee, {contractIdHint})` —— 把**已取消合约**的上游包拷进 assignee 的 inbox。
- 未确证：磁盘上 363 个"有 upstream/ 无 contract.json"的 trace 是否都由这条分支造成（`snapshotInboxToTrace` 用 `cp(recursive)` 合并写入、从不删，静态推不出调用顺序）。
- **怎么看**：抓一次 loop 中断或 late-join 的网关日志，看 `exact contract ... not claimable` 与 `upstream packages → inbox/upstream/` 两条 info 的先后。

---

## 5. 已澄清的"看起来像 bug 其实是设计"（不要再翻案）

1. **`contract.output` 被 task-facing inbox 剥离** — 意图。`TASK_FACING_INBOX_ALLOW_KEYS` 是白名单（`inbox-handlers.js:26-48`），`hooks/before-tool-call.js:70-74` 注释写明理由（"output 与 outbox 易混，曾有 agent 把 output 误当写入路径"）。审计中未发现任何把 output 泄回 agent 可见面的路径；判定侧通过 `collectWorkerOutbox` 从共享合约补回，这条链是通的。`upstreamPackages` **在**白名单里（`:47`），指针扛得住投影裁剪。

2. **`contract.output` 有"两个写者"（agent 直写 + 镜像覆盖）** — **REFUTED**。`agent-end-stage-definitions.js:215-216` 注释提到的"单交付物直接写 contract.output（WebUI 链路）"是 **gateway agent**，而 gateway agent **根本没有 outbox 采集**（`runtime-mailbox-transport.js:13-18` 对 `isGatewayAgent` 返回 null，`runtime-mailbox.js:76-77` 直接 `{collected:false}`），镜像永远不会在那条链路上跑，两个写者在同一合约上不可能并存。`before-tool-call.js:296-299` 的 `isContractOutputTarget` 是跨工作区守卫的**豁免项**，不是写入路径的存在证明。**不要按此改镜像逻辑**——加"仅当 contract.output 不存在才覆盖"反而会与 M2 的陈旧产物场景打架。

3. **`saveAgentArtifact` 整段吞错、成功也不抛** — 意图，`artifact-store.js:16` 写死红线「绝不破坏 agent_end」，`:195` 注释「保存失败静默」。stage 外层那层不可达的 catch 也不是缺陷，`:205` 注释明说是二层兜底，`artifact-flow.test.js:244` 还静态断言它必须存在。**可批评的只有"不抛 ≠ 不记日志"**（见 L 级 #L2）。

4. **空 artifactPaths 回退 primaryOutputPath 打包** — 回退本身是意图，被 `artifact-flow.test.js:240` 静态锁死。H4 缺的是**归属/新鲜度门**，不是回退本身；且测试没锁 `|| trackingState.contract.output` 这个来源，加门不撞护栏。

5. **reviewer verdict=fail 仍判 COMPLETED** — 意图，`tests/terminal-outcome.test.js:112-127` 明确锁定：返工走 transition/graph，不走结局判定；`deriveTestsPassed` 只填 evidence。推论要记住：`status=completed && testsPassed=false` 是**合法状态**，下游消费者不能只看 status。

6. **loop 预算耗尽直接判 COMPLETED** — 有意（`terminal-commit.js:11-17` 注释亲口承认"被 origin 标为 COMPLETED 以优雅收敛"，`buildTerminalLabel` 只在 label 层区分）。但要记账为**真值分裂的雏形**：`agent-end-loop-budget-governance.js:47-95` 全程不看产物，且经 `agent-end-terminal.js:227-235` 短路掉整个语义判定；跑满预算、reviewer 从未 approve、产物可能是空的 loop 合约最终 `status=completed`。建议后续单列 CONCLUDED/EXHAUSTED 终态，但这是设计讨论不是 bug。

7. **产物按 producer 整包流转、agent 从不读中央 output 路径、wake 不嵌产物正文** — 意图，`artifact-store.js:1-16` 抬头注释、`decision-dual-file-package-flow-2026-05-31.md`、`dispatch-graph-policy.js:160-163` 三方一致，`artifact-flow.test.js:262-270` 反向断言 wake 消息不再内嵌上游产物正文。

8. **顺带纠正三条流传中的错误事实**（避免后续基于它们做判断）：
   - live 图**有 4 条边**（controller→planner / planner→worker / worker→reviewer1 / worker→worker2），不是"唯一一条 controller→planner"；"planner→worker 被误删"的猜测不成立。
   - `readPathScope` **有消费点**：`hooks/before-tool-call.js:332-360` 完整实现了 inbox/contract 两种 scope 的 block，planner/reviewer 是真被沙箱限制的，不是死配置。
   - `control-plane/artifacts` 下**确实有多 producer 合约**（最近 60 个里至少 5 个 planner+worker 双 producer），这条注入链在本机跑通过很多次，不是"从未跑过的潜伏路径"。

---

## 6. 系统性观察

### 真正扎实的部分（不是客套）

- **单一真值这条纪律守住了**：`evaluateContractOutcome` 只有一份实现（`contract-outcome.js:181`，`contracts.js:251` 只是 re-export，全库唯一语义调用点 `terminal-outcome.js:76`）；`commitSemanticTerminalState` 是唯一写 COMPLETED/FAILED 的入口（只有 2 个调用方）；`saveAgentArtifact` 全库单一调用点（旧的 `cleanup_transport` 调用已删且有反向测试守）；`computeContextBudgetPlan` 是唯一的字节取舍真值（无 I/O、无 Date、无随机，输入顺序即决策顺序，入参防御完整）；outbox 协议以 `runtime_result.json` 为唯一真值，legacy `_manifest.json` 硬拒并带 error。**没有野生的平行实现。**
- **最关键的那条防线立得住**：「runtime_result 的 `status:completed` 只是元数据、不构成完成，必须有文件系统证据」——`contract-outcome.js:255-286` + `contract-outcome-runtime-result-boundary.test.js:39-61`（该测试后随判决机拆除删除）明确锁定"runtime 说完成 + artifacts:[] → FAILED"。这挡住了 agent 自我宣告完成，是整个门控最重要的一条。
- **阶段序被静态护栏锁死**：`collect_transport(107) → extract_output_markers(124) → preserve_artifact(206) → graph_route(240)`，留存严格早于任何下一跳派工，`artifact-flow.test.js` 用 stage id 索引断言；`routeInbox` 里 `handlerIdx < copyIdx` 同样被钉死。
- **v133 mirror-bug 的修复在 reorg 后完整存活并三重加固**（长注释 + 还原 live 事故形态的命名回归测试 + `E-CONTRACT-004` 登记复发点）。这说明大重排没有伤到核心逻辑。
- **hard-stop 收口是 fail-closed 的**：`resolveAuthoritativeHardStopOutcome`（`hard-stop-terminalize.js:77-108`）只在有真实证据时才接受 COMPLETED，否则回落 FAILED。这个方向是对的。
- **有界注入的消费侧比生产侧扎实**：枚举失败/单文件复制失败/清单写失败全部记入 failures 并落可见 `_MISSING.md`；超大单文件进 overflow 但不累加 `used`，不会饿死后面的小文件（有注释有两个测试）；`readHead` 只读前 4096 字节不整读大文件；`packages`（copied ∪ compressed）而非 `copied` 作为指针门控——这是个极容易写成 `if (copied.length>0)` 然后让"全溢出的上游"彻底隐身的地方，这里没写错。
- **兜底红线是真的**：产物子系统崩了绝不打断 inbox 投递或 agent_end，双层 try/catch，2816 个工作区里没有该路径导致投递中断的痕迹。

### 反复出现的模式（跨环同根）

**① "按 id 取合约"这个原语目前不可信** —— 三处同类：`contractPathsById` 无共享路径守卫，任何路径（含 inbox 投影副本）都能建立 id 映射（`contract-store.js:39-57`）；`readActiveInboxContract` 硬编码 `workspaces/<agentId>` 绕过 `agentWorkspace()`；`writeUpstreamPackagesPointer` 裸写不刷缓存造成同一 store 内缓存/磁盘分叉。**一处改动（只允许 `isSharedContractPath` 写索引）能同时封死这一整类**，比在调用点逐个加 hint 彻底得多。

**② "谁写谁清"全面缺位** —— `inbox/upstream/`、`outbox/`、`control-plane/output/`、`artifacts/<cid>/<producer>/` 四个目录**全部只增不清**，唯一的 `cleanInbox` 只删顶层文件。H1/M2/M3 和 L2-F5 的放大器都是同一根因。而且这个洞被测试 fixture 系统性掩盖了（`artifact-flow.test.js` 每个用例自己 `rm -rf`）。**要立一条规矩：写入方负责清场，测试 fixture 不许替生产代码做清理。**

**③ 静默吞错的习惯不对称** —— 消费侧（`copyUpstream` 落 `_MISSING.md`）做得很好，生产侧（`saveAgentArtifact` 零日志、单文件 copy 失败空 catch、观测层把失败反转成 success）几乎全静默。同一个文件里两种纪律并存。

**④ 门与判定用两套不共享的谓词** —— handoff 门只量字数不做控制噪声判定；结局判定不做最短长度；E-CONTRACT-006 的注册表说要校验指针、实现没校验。**同一份内容在链中位置不同判定相反**：200 字的 `[ACTION]` blob 在中间节点过关转发、在终端节点判 control_text FAILED；5 字 "hello" 在终端节点 COMPLETED、在中间节点被拦。这类漂移只会继续扩大，除非抽出共用 `isDeliverablePayload(content, {minChars})`。

**⑤ reorg 缝**：重排本身干净——核心修复、注释、测试、错误码登记都跟着搬过来了。真正的缝是**重排前就存在的半套遗留**：`runtime-contract-output-alias.js` 创建端零调用、消费端还在跑；`requireDefaultOutputArtifact` 只有读点没有写点；`retryable` 只有写点没有驱动。三处都是"留了一半"，符合 CLAUDE.md 明令禁止的遗留代码形态。

---

## 7. 建议动作（按性价比排序）

| # | 动作 | 类型 | 一句话理由 |
|---|---|---|---|
| 1 | `execution-observation.js:96-108` 删掉 `\|\| normalized.error` 与 `\|\| normalized.primaryOutputPath` | **静态可改** | 两行；同时修复"日志说 success"与"system_action 失败不再终结合约"。改完 `tests/outbox-*-truth.test.js` 的既有断言正好对齐 |
| 2 | `artifact-store.js:270` 之前加 `await rm(upstreamRoot, {recursive:true, force:true})` | **静态可改** | 一行；同时解掉 H1（跨合约污染）与陈旧 `COMPRESSED_MANIFEST.md`/`_MISSING.md` |
| 3 | contract-store 加索引守卫：只有 `isSharedContractPath` 才允许写 `contractPathsById`；同时 `readActiveInboxContract` 改用 `agentWorkspace()` | **静态可改**（效果需 live 验证） | 一处改动封死"按 id 取合约取到副本"整类问题（含 L19 的确定性变体），比逐个加 hint 彻底 |
| 4 | `matchesControlText` 加长度闸（trim 后 ≤200 字才允许非锚定模式） | **静态可改** | 直接消掉 H2 这个高频假阴性；同时把交付物正文判定与工具结果判定拆成两套阈值 |
| 5 | 把 `resolveIncompleteHandoffGate` 提到 loop/非 loop 两分支之前的公共位置，判据改为长度 + `classifyRuntimeControlPayload` 共用 helper，并加 `contract.output` 回退 | **静态可改** | H3；顺带修掉"注释声称的 progress gate 不存在"这条 |
| 6 | `preserve_artifact` 的 `contract.output` 回退加归属/新鲜度门（`obs.collected===true` 或 `mtime >= trackingState.startMs`），复用 `protocol-commit-reconcile.js:271-278` 的 stale 判据 | **静态可改** | H4；测试锁的是回退那一行、不是 output 这个来源，加门不撞护栏 |
| 7 | `helpers:154-172` 提交事务化（全 copy 成功后再统一 unlink），镜像与 dest 改 `atomicWriteFile`；采集入口加陈旧产物检测，parse 失败的 runtime_result 改名移出视野 | **静态可改** | M2；防"上一轮产物被镜像成下一份合约的交付物"这类内容级错发 |
| 8 | E-CONTRACT-006 probe 校验 `manifest.contractId === cid` + 下游 `contract.json` 的 `upstreamPackages` 非空；stage 拆成 producer-side / downstream-side 两条 | **静态可改** | M4；注册表 `error-codes.js:61` 本来就是这么写的，只是实现没跟上。修完前，这道门的绿灯不能当证据用 |
| 9 | 清死代码：删 `runtime-contract-output-alias.js` 及两个 hook 的 canonicalize 调用与测试；`requireDefaultOutputArtifact` 补全 `:281-286` 的放行或删掉；`retryable` 接上真实驱动或改名 `manualRetryHint` | **静态可改** | 三处"留了一半"，违反不留遗留代码红线 |
| 10 | FAILED 分支复用 `isInternalDeliveryReason` 过滤后输出 `outcome.summary/reason`（照抄 AWAITING_INPUT 分支写法） | **静态可改** | L17；成本几乎为零，但它是所有判定 bug 的定位放大器——修完下次误判能一眼看出是门拦的还是模型没干活 |
| 11 | producer 包留存前按 (cid, producer) 清空目录或按 round 分子目录；`copyUpstreamArtifactsToInbox` 改以 `manifest.files` 为准 | **静态可改** | M3 |
| 12 | 补两个集成用例：overflow → `COMPRESSED_MANIFEST.md` 落盘 + packages 含该 producer；不可读目录 → `_MISSING.md` 落盘 + 指针断言。`maxBytes` 提为参数 | **静态可改** | L21；这两条路径生产 817 次注入 0 命中，L8 的漏洞就藏在这里 |
| 13 | 其余 L 级（outbox 目录产物、symlink 分支、manifest 原子写、graph edge 校验 + `resolve(dest).startsWith(upstreamRoot)`、字符串 requiredFiles 补 `nonEmpty:true`、压缩清单条目上限、`readHead` UTF-8 边界、单文件软上限） | **静态可改** | 全是低风险小改，可打成一个包 |
| 14 | 定案 ①`contractPathsById` 投毒实际发生率 / ②陈旧 `contract.output` 假阳性 / ③OUTPUT_DIR 并发覆盖 + 幽灵包 md5 比对 / ④gateway cwd / ⑤363 个孤儿 trace 的因果 | **需先 live 复现** | 观察方法见第 4 节。③④是纯只读命令，不需重启网关，可以最先做 |

**如果只做三件事**：#1（两行，修真值与日志双向说谎）、#2（一行，修盘上已经存在的污染）、#4（修高频误杀）。**如果只允许一次 live 观测**：对一条跑过 ≥2 跳的 cid 比对 `artifacts/<cid>/<下游>/<cid>.md` 与上游主产物的 md5——相同即同时坐实 H4 与观察项③；顺手 `lsof -p $(pgrep -f 'openclaw gateway') | grep cwd` 定案④。