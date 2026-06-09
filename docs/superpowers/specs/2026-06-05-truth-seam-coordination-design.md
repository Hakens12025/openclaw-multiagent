# 协调设计：三计划真值层收敛 + 协调缝 (Coordination Seam)

- **日期**: 2026-06-05
- **角色**: 本文档由 Claude Code（系统建造者层，非系统内 `system-coordinator` 角色 agent）产出，用于协调三个在飞计划在「系统真相层」的收敛。
- **协调对象**: ① RAG 设计器（已落地，operator 驱动）② 可视化大师 viz-master（`2026-06-05-viz-master-charts-design.md`，待落地）③ 系统内部优化（`PLAN-four-joint-self-governance` + `PLAN-operator-self-evolution-control-plane`，基本完工）
- **代码根**: `~/.openclaw/extensions/watchdog/`
- **grounding 证据**: workflow `w5y3y977c`（5 个并行只读 agent、~433k token、139 次工具调用），全部 file:line 核验。本文档所有「代码真相」均来自该勘探，未经核验处显式标注。
- **基线**: viz spec 记 1729/0；RAG v145–v152 后实际数以 `test-runner.js` 为准。协调缝全程保持当前门绿。
- **状态**: 三项核心裁定已锁（§2），待用户复审本文档 → 各计划转/续 writing-plans。

---

## 0. 这份文档解决什么

三个计划**在同一时刻撞向同一个「系统真相层」**——`structure-snapshot.js` 的真值枚举 + `cli-surface-executor.js` 的 meta-agent 所有权门。该层今天是**过程式硬编码、零扩展缝**。若三方各自 bolt-on，就会在同一段字面量上反复编辑，直接违反项目红线「一条路径原则」与传送带「禁止硬编码 agent 名」。

本文档**不替代**各计划自己的 spec，只定义：先建一道**协调缝**（两张声明式注册表），让三方都靠「加一行表项」接入。

---

## 1. 对照结论（代码真相，全 file:line，已验证）

### 1.1 真相层 = 过程式硬编码，2 文件 6 处，无缝
- `structure-snapshot.js:44-52` `readTruths()` = `Promise.all([loadGraph, loadGraphLoopRegistry, loadConfig, listAutomationSpecs])` → 返回固定 4 键 `{graph, loopRegistry, config, automations}`。
- 同一 4 真值在 **2 文件 6 处**重复枚举：readTruths(44-52)、restore 写回(139-142)、restored 标志(150)、头注释(2)、import(13-19)，**外加 `structure-share-code.js:106-118` 一份独立副本，信封还不同（`{v,level,graph,loops,agents,automations}`）**。
- 哈希 = 对全量真值 canonicalize 后 sha256（`structure-snapshot.js:40-42`）→ 加任何真值，所有新快照哈希全变，旧快照 `verifyAgainstSnapshot` 报 `drifted:true`。
- **现存隐患**：加 readTruths 忘了 share-code → 分享码静默丢真值（两份枚举可静默分裂）。
- `knowledge-bases.json` **不在** 4 真值内；`charts.json` 不存在。

### 1.2 meta-agent 所有权门 = 单字符串相等
- `cli-surface-executor.js:19` `if (actor !== "operator") throw`——全 lib **唯一** actor 门（grep 证实）。
- 今天**只有 1 个 meta-agent（operator）**；2 个调用点都传字面量 `"operator"`（`operator-executor.js:90`、`cli-surface-verify-gate.js:65`）。
- `meta-agent-surface-ownership.js` **不存在**；`META_AGENT_IDS` **不存在**（viz spec 假设它有，实为新建）。
- `buildAdminSurfaceSubject`（`admin-surface-subject.js:144-149`）无 chart/knowledge 分支，两者都掉进 `kind:"platform"` 兜底 → **今天 chart 和 knowledge 都不是可区分的「家族」**，且 knowledge 的 admin 操作被误归 global platform（change-set mis-grouping 隐患）。
- operator 专属性散在 4 文件：actor 门、designer-only loop 块(`operator-executor.js:54-65`，仅挡 `runtime.loop.start/resume`)、`PROTECTED_AGENT_IDS`(`agent-metadata.js:50`，**仅测试消费，非运行时承重**)、`CONTROL_PLANE_AGENT_IDS`(`agent-plane-policy.js:10`，**承重**：gate 入伍 + 控制面可见性)。

### 1.3 RAG 设计器已落地且庞大，但纯 operator 驱动
- 多库注册表/摄取/per-KB 评测/时序元数据/分歧提示全 landed；8 个 `apply.knowledge_*`(operatorExecutable) + 6 个 `inspect.knowledge_*`。
- `knowledge-bases.json` 有独立 store + 锁(`store:knowledge-bases`)，**不在快照**；per-KB 索引 `kb-<id>-index.json` 也不在（可重建）。
- **operator grounding 只读 wiki**(`operator-knowledge.js:302` `searchWiki`)——**用户库零运行时 LLM 消费者**。管理先于消费。
- 「设计器」今天 = 知识库 dashboard 页（`dashboard-knowledge.js`，nav 与主页/工作流同级）；**无设计师 agent**。
- live：零持久用户库、零评测集；仅 wiki 索引（8MB）为真。

### 1.4 系统内部优化基本全完工——它是地基
- 四关节三死链全修（reworkGuidance 注入 / verify 正式面+commit 门 / governanceSnapshot 合流）、ProfileLifecycle 建好、快照/恢复/验证/分层/分享码全建。
- 控制面 UI 以**独立页** `/watchdog/control-plane-view` 发布（**非** plan 文档所称 devtools 第 4 tab）。
- 拥有 structure-snapshot + governance；硬编码恰好 4 真值、无缝、2 文件重复。
- **最近 ~12 commit 全是 RAG/KB；真相层当前静默无在飞改动 = 动它的安全窗口**。

---

## 2. 三项核心裁定（本次锁定）

| # | 裁定 | 理由 |
|---|------|------|
| **D-α** | **先建协调缝**（真值注册表 + 所有权注册表），作为 viz/RAG 落地前的前置步 | 真相层现静默=安全窗口；把 2 个硬冲突 → 纯加表项；顺带修 2 文件重复隐患；落地项目「一条路径」红线 |
| **D-β** | **knowledge-bases.json ≠ 真值**（内容/数据，留在真相层外，类比 artifacts） | 知识库=语料+可重建派生索引；纳入会引哈希 churn + 多 MB 索引/spec 同步。**附带修复**：`knowledge_remove`(destructive) 现会触发快照但快照根本没备份被删 KB → 假「可回滚」，须修（§5） |
| **D-γ** | **RAG 不建专属 meta-agent**；operator 驱动不变；所有权注册表只「认得」knowledge 家族（未来真要 kb-master = 加 1 行） | RAG 已能跑；「operator=单一 meta-agent」现有立场；传送带反对增殖具名 agent。RAG 真缺口是无运行时消费者，非缺 agent |

> charts = 第 5 真值（viz spec D1）保持锁定——viz-master 仍是合法的第 2 meta-agent（图表语法是真异质技能域）。D-γ 只否决 RAG 侧对称建 agent。

### 2.1 viz-master 与 RAG 的本质（用户澄清 2026-06-05）

- **viz-master = operator 的隐形"代笔人"（ghostwriter）**：它**不进入用户可见的多 agent 系统、不参与 worker 派工、不在主视图露面**。**唯一入口是 operator**——operator 委派它建图，结果以 **operator 的名义**呈现给用户。**用户根本不知道 viz-master 存在，以为是 operator 建了可视化窗口，实际是 viz-master 建的**。operator 是台前的脸，viz-master 是幕后的专家。
- 这正是 §3.2 `META_AGENT_IDS → CONTROL_PLANE_AGENT_IDS` 派生的效果：控制面 agent **不是 worker、不进主视图、不可被建成 runtime 派工目标**（勘探证实：若不在 `CONTROL_PLANE_AGENT_IDS`，viz-master 会渲染进主时间线）。所有权表 `{"viz-master":["chart"]}` + 仅放 operator→viz-master 一条授权 = 「唯一入口 operator」。
- **⚠ 传送带红线（已据代码勘探 `w6qvp8s9z` 修正）**：早先担心"operator→meta 旁路 = 第二条 transport"——**勘探证伪，本条修正**。控制平面本就是独立于 worker 传送带的 substrate，且已有第一类控制面投递原语（票据 + pending-signal + 心跳）。**operator 专用旁路是对的设计，不是红线违规**。要守的纪律只有一条：旁路是**一条按所有权表驱动的通用机制**，不是 N 个 per-agent 私管 / `if(是图表)→调viz-master`。反倒是 viz spec slice-1 的「授权边(graph edge)」投递**会重入 worker 传送带**、与 meta 平面意图相悖，**该丢**。详见 §2.2。
- **RAG = 给 operator 消费的知识库**：RAG 不建 agent，正因为它的**目的就是被 operator 消费**（operator 是唯一读者兼门面）。因此「operator grounding 从 wiki 扩到 user KB（`searchWiki→searchKb`）」**不是延后的 nicety，而是 RAG 的本来目的**——见 §7 升级议题。

### 2.2 meta 平面旁路可行性 + 投递模型（裁定，代码勘探 `w6qvp8s9z`）

**裁定：底座支持 operator-hub 星型 meta 平面旁路——"两平面分离"已写死在代码里，不是"可能性"。缺口很小、全是加法、且恰好就是协调缝。**

- **两平面已物理隔离（承重好消息）**：`CONTROL_PLANE_AGENT_IDS` 全带 `autoWakeEligible:false`（`agent-plane-policy.js:10,42-48`）；worker 派工闸要求 `plane==="runtime"`（`agent-activation-policy.js:1-5`）；派工 + 唤醒两条带独立拒投控制面（`dispatch-transport.js:278-283` + `runtime-wake-transport.js:170`）。→ `plane!=="runtime"` 的 meta-agent **自动对 worker 传送带不可见/不可达** = 你要的"不进派工"是拓扑白送。
- **hub lane 已被 operator 证明**：operator brain 经 HTTP 路由 → `callOpenAICompatiblePlanner`（`llm-planner.js:121`，通用 agent 无关、零 dispatch 耦合）；执行经 `executeCliSystemSurface(actor:"operator")` 同步改真值、无队列/inbox/边/唤醒。spoke meta-agent 克隆这套 run 模式即可，并列永不链式 = 星型。
- **还有第一类控制面投递原语（非传送带）**：system-action 票据 + pending-signal + 心跳唤醒（`delivery-system-action-ticket.js` + `heartbeat-gate.js:31-37`）——`plane!=="runtime"` 的 agent 靠 `hasPendingSignal` 即可被唤醒，无 inbox 合约/graph 边。
- **缺口（全加法，非重构）**：① 所有权路由表 + `resolveSurfaceFamily`（`operator-surface-policy.js`，⚠ "family"重载：CLI 生命周期家族 apply/verify ≠ 域主家族 chart/kb，按 surface-id 前缀建**新正交分组**）② actor 门泛化（`cli-surface-executor.js:19`）③ 新 meta ID 注册控制面（`agent-plane-policy.js:10`）④ 执行循环委派分支（`operator-executor.js:86-94`，不动周围快照/回滚）⑤ 每-agent brain 配置（`brain-model-resolver.js:51` `resolveOperatorBrainModel`→按 agentId；`operator-brain.js:202` `buildOperatorBrainSystemPrompt()` 参数化）。**①②③ = 协调缝；④⑤ = 旁路本体。**
- **投递模型（用户裁定 = 两段式）**：
  - **slice-1 = B 进程内直调**：operator-executor 撞到不属于自己家族的步骤 → 按所有权表直接调 owning meta-agent 的 brain+executor（同步）。面在 `actor:"<meta>"` 下执行 = 所有权/审计仍记"该 meta 建的"。留在 operator 快照/回滚事务内、零票据/唤醒/回程 = 最快闭环最安全。
  - **A 控制面票据异步（演进，§7）**：operator 发委派票据 + pending-signal → meta-agent 自心跳醒来 → 跑自己 brain → 执行自己面 → replyTo 回结果 = meta-agent 真起自己一趟、完全解耦。等 meta 活变长/真需异步再上。
- **红线**：✓ 一条按所有权表驱动的通用机制，非 per-agent `if`。**禁** graph-edge 投递（会重入 worker 传送带）。
- **⚠ 诚实警告（未实证）**：以上为**静态**追码——meta-agent 概念尚不存在，该端到端流**从没被跑过**。**构造可行、未经实证**；第一刀落地必须带 live 冒烟（见 §6 step 5），别当白纸黑字成立。

---

## 3. 协调缝设计（净新前置步，system-opt 拥有落地）

### 3.1 真值注册表 `STRUCTURAL_TRUTHS`
- **做什么**：一张声明式表 `[{ key, load, save }]`，`readTruths` / `restoreStructureSnapshot` / `restored` 标志 / 哈希域 / `structure-share-code.js` **全部 iterate 这一张表**。
- **修现存隐患**：消灭 `structure-snapshot.js` 与 `structure-share-code.js` 两份独立 4 真值枚举（1.1 的静默分裂风险）。
- **信封约定**：表项**保留各真值原生形状**（graph/loopRegistry/config = 对象，automations = 裸数组），注册表只 iterate 不强制统一——避免给现有 4 真值引入行为漂移（字节级不变是回归锁）。
- **接入规则**：charts 接入 = 表加 1 行（viz slice-1，见 §4）；knowledge **明确不加**（D-β）。
- **不变量**：抽表后现有 4 真值的 capture/restore/hash 行为**字节级不变**（回归锁测试）。
- **模板**：现有 4 真值的 load/save 已满足契约（load 异步零参返回值；save 异步收值、内部 `withLock`+`atomicWriteFile`）。

### 3.2 meta-agent 所有权注册表 `meta-agent-surface-ownership.js`（净新）
- **`META_AGENT_IDS`** 单一源，置于 `agent-metadata.js`（与 `AGENT_IDS` 同处）。
  - `CONTROL_PLANE_AGENT_IDS`（承重）与 `PROTECTED_AGENT_IDS`（测试面）**spread 派生，不 replace**——否则 harness/cli-system/automation 丢控制面身份（会进主视图、可被建成 runtime agent）。
- **`META_AGENT_SURFACE_OWNERSHIP = { operator:"*", "viz-master":["chart"] }`** + `SHARED_FAMILIES=["test_run"]`（verify 基础设施人人可用）。
- **`resolveSurfaceFamily(surface) = buildAdminSurfaceSubject(surface).kind`** —— 单一家族源（与 viz spec §4.2 一致，不另造平行 resolver）。
- **`assertActorOwnsSurface(actor, surfaceId, surface)`** 替换 `cli-surface-executor.js:19` 裸门；actor 线穿 `operator-executor.js:90` + `cli-surface-verify-gate.js:65`（去字面 `"operator"` 硬编码）。
- **双重身份（关键）**：这张所有权表既是「谁能写哪个面」(actor 门)，**也是 operator 的 meta-委派路由器**（"这个家族归谁 → 投递给谁"，见 §2.2）。因此协调缝**还含旁路本体**：执行循环委派分支（`operator-executor.js:86-94`）+ 每-agent brain 配置泛化（`resolveOperatorBrainModel`→按 agentId、`buildOperatorBrainSystemPrompt()` 参数化）+ 新 meta ID 注册控制面（`agent-plane-policy.js:10`）。
- **不变量**：`operator:"*"` 保证 operator 行为字节级不变（回归锁）。

> **🔧 修订 R1（对 viz spec 的 delta，请复审）**：viz spec §6 步骤 6 / §8 修正 1 只给 `buildAdminSurfaceSubject` 加 **chart** 分支。协调缝要求**同时加 chart 和 knowledge 两个 kind 分支**——这样 RAG 的 knowledge 家族从一开始就被 `resolveSurfaceFamily` 认得（无须 RAG 日后再编辑同一函数），且**顺带修掉 1.2 的 change-set mis-grouping**（knowledge 操作不再误归 global platform）。这是 D-γ「通用机识别 knowledge 家族」的具体落点。

---

## 4. 各计划如何接缝（整合契约）

### 4.1 viz-master（受益最大；spec 的若干步被缝吸收）
协调缝吸收 viz spec §6 的以下步骤（viz slice-1 **不再各自实现**，改为「加表项」）：
- 步骤 3/4（readTruths/restore 插 charts）→ **改为 `STRUCTURAL_TRUTHS` 表加 1 行 `{key:"charts", load:loadCharts, save:saveCharts}`**。
- 步骤 6（subject chart 分支）→ 并入协调缝 R1（chart+knowledge 一起加）。
- 步骤 7/8/9/10/11（所有权注册表、换门、actor 穿线、META_AGENT_IDS、protected 派生）→ **全部由协调缝 §3.2 落地**；viz 只在 `META_AGENT_SURFACE_OWNERSHIP` 加 1 行 `"viz-master":["chart"]` + AGENT_IDS/openclaw.json 加 viz-master 块。

viz slice-1 **剩余净 viz 工作**：chart 自有件——`chart-registry.js`(loadCharts/saveCharts，供 §3.1 表引用) / `chart-operations.js` / `chart-spec-schema.js` / `viz-master-brain.js` / `chart-build` skill / 前端三件套 + charts.html / catalog+route+input-fields。即 viz spec Phase A/D/E/F 去掉被缝吸收的 B/C 大部分。

> **🔧 修订 R2（对 viz spec D3 的 delta，请复审）**：viz spec slice-1 的投递用「operator 建 viz-master + **授权边(graph edge)** + viz-master 自己跑」——**改为 §2.2 的 B 进程内直调**（graph-edge 会重入 worker 传送带，与 meta 平面旁路意图相悖）。viz-master 仍是真·第二 meta-agent（控制面、operator 唯一入口、用户不可见）；只是 slice-1 的"执行"= operator 同 pass 内按所有权表直调其 brain+executor，真异步票据(A)留作演进（§7）。

### 4.2 RAG 设计器（零真值层改动）
- **不进真相层**（D-β）。
- **受益**：R1 给 `buildAdminSurfaceSubject` 加 knowledge kind → 修 change-set mis-grouping。
- **附带修复**：`knowledge_remove` 假回滚（§5）。
- **不建 agent**（D-γ）；所有权表已为未来 kb-master 留位（1 行）。

### 4.3 系统内部优化（拥有协调缝落地）
- 协调缝改的是 `structure-snapshot.js` / `structure-share-code.js` / actor 门——**system-opt 的真相层收尾泛化**，归它所有。
- 现真相层静默，是落地协调缝的安全窗口；缝落地后 viz/RAG 对真相层**只读表 + 加行**，不再触 system-opt 核心。

---

## 5. 附带修复（D-β 强制）：`knowledge_remove` 假回滚

- **现状**：`maybePreApplyStructureSnapshot`(`admin-surface-operations.js:411-420`) 谓词 = `risk ∈ {destructive, structural}`。`apply.knowledge_remove` 是 destructive → 触发结构快照，但快照只存 graph/config/loops/automations，**不含被删 KB** → 污染 20 槽快照环 + 给出虚假「可回滚」承诺。
- **修复**：谓词改为 `risk ∈ {destructive, structural} 且 resolveSurfaceFamily(surface) 是 truth-backed 家族`。knowledge 非真值 → 不触发结构快照 → 不再假回滚。**该谓词依赖 §3.2 的 `resolveSurfaceFamily`**，故顺序上紧随协调缝。

---

## 6. 落地顺序（依赖序）

1. **协调缝·真值注册表**：抽 `readTruths`/`restore`/`restored`/hash/`structure-share-code` → `STRUCTURAL_TRUTHS` 表（charts 暂不加，4 真值字节级不变 + 消除 2 文件重复）+ 往返/哈希回归测试。
2. **协调缝·所有权注册表**：`META_AGENT_IDS`（+ CONTROL_PLANE/PROTECTED spread 派生）+ `META_AGENT_SURFACE_OWNERSHIP` + `resolveSurfaceFamily`(经 subject.kind) + `buildAdminSurfaceSubject` 加 **chart+knowledge** kind（R1）+ `assertActorOwnsSurface` 换门 + actor 穿线 + 对抗测试（operator 字节级不变；未注册 actor 被拒；viz-master 在 `agents.create`/`graph.*` 被拒、`apply.chart_*`/`test_run` 通过）。
3. **附带修复**：`knowledge_remove` 假回滚（§5，依赖 step 2 的 resolveSurfaceFamily）。
4. **旁路本体（B 投递）**：`operator-executor.js:86-94` 加委派分支（不属于自己家族 → 按所有权表直调 owning meta-agent brain+executor）+ 每-agent brain 配置泛化（`resolveOperatorBrainModel`→按 agentId、`buildOperatorBrainSystemPrompt()` 参数化）+ 新 meta ID 注册控制面（`agent-plane-policy.js:10`）。
5. **viz-master slice-1**：charts = 真值表加 1 行 + ownership 加 1 行 + chart 自有件（按 viz spec Phase A/D/E/F，删去被 step 1/2/4 吸收的步骤）。**含 live 冒烟**：端到端实跑 operator→(B 直调)→viz-master 建图→落 charts.json→仪表盘渲染——**旁路从未实证，必须实跑**（§2.2 警告）。
6. **RAG**：无真值层/旁路动作；受益 R1 + §5；真缺口 per-KB consumer 另立（§7）。

---

## 7. 待定项（显式记账，不阻塞本协调）

- **RAG per-KB 运行时消费者**（⬆ 升级候选）：`operator grounding searchWiki → searchKb` 扩展，让用户库真被读。**经 §2.1 用户澄清"RAG=给 operator 消费的库"后，这已非延后 nicety，而是 RAG 的本来目的**——operator 当前根本没读用户库（`operator-knowledge.js:302` 只读 wiki）。**待定**：升进主协调计划（紧随协调缝）还是另立。否则建好的库永远没人读。
- **A 投递（控制面票据异步 meta pass）**：slice-1 用 B 进程内直调；当 meta 活变长 / 真需异步解耦时升级到 A（票据 + pending-signal + 心跳唤醒 + replyTo 回程，`delivery-system-action-ticket.js`）。等价 viz spec slice-2 的直接 meta→meta 交接；协调缝 ownership + §2.2 已铺好地基。
- **是否实例化 kb-master**：D-γ 选「不」；通用机已预留，1 行可加；待 viz-master slice-1 验证 meta→meta 模式后回看。
- **真值层 schema-version 字段**：加真值改哈希域使旧快照 `drifted:true`（可接受，20 环快速换出）；若日后频繁加真值，再议是否引版本字段。

---

## 8. 红线核对

- **一条路径**：✓ 真值与所有权各收敛成单一注册表；resolveSurfaceFamily 单一家族源。
- **传送带不硬编码 agent 名**：✓ ownership 数据驱动；resolveSurfaceFamily 按 family（chart/knowledge）非 agent id 分支。meta 委派是**一条按所有权表驱动的通用机制**（非 per-agent `if`、非 graph-edge 重入 worker 带）——见 §2.2。
- **两平面分离**：✓ 控制面（operator + meta-agents）与 worker 传送带物理隔离，已由 `autoWakeEligible:false` + 双拒投在代码里强制（§2.2）；meta-agent `plane!=="runtime"` 自动不进派工/不入主视图。
- **概念预算**：✓ 两张表是把**现有隐式概念显式化**（真值早存在；ownership 是 operator 单例的泛化），非新增第 12 概念。
- **god object**：✓ 两净新文件各 < 100 行。
- **不留遗留**：✓ 裸门、2 文件重复枚举被注册表替代后**删除**，不留兼容 shim。

---

## 9. 开放问题

无阻塞性。D-α/D-β/D-γ 已锁；两个派生工程决策（R1 = subject 同加 chart+knowledge；§5 = 谓词依赖 resolveSurfaceFamily）已在文内标注，待用户复审认可即转 writing-plans 出协调缝实施计划。
