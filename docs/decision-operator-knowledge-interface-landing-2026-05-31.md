# 决策：给已还原的 meta-agent operator 配齐知识/接口/落地通道（P5）

> 阶段：P5（四关节自治计划） | Primary Block：`operator-cli-control` | 日期：2026-05-31
> 认知前提：operator = 一个 meta-agent（强 agent，本职就该理解→判断→规划）。P5 不限制它、不拆 if-else，
> 而是给它配好三样（知识/接口/落地）让它真能动手。保留 operator-brain.js advice_only 诚实兜底。

## 调研发现：三样各缺什么（file:line）

### 1. 知识（全貌）缺口
- **核心：硬编码 surface 白名单**。`operator-knowledge.js:107-124 summarizeExecutableCapabilities`
  是一份硬编码 if-else 列表（只列 11 个 surface），驱动 `buildDynamicCapabilityFragment:196-207`
  告诉 operator"你只能做这些"。实测有 30+ 个 operatorExecutable surface（schedules.* / automations.* /
  agent_joins.* / runtime.loop.start / test_runs.start / test.inject 全漏）。违反 CLAUDE.md"禁止硬编码"红线，
  新增 surface 必须手改。**operator 被低估了一半手段。**
- **verify 不可见**：brain 经 `operator-surface-policy.js:21 listOperatorExecutableCliSystemSurfaces` 只过滤
  `family:"apply"`，verify family 进不来 → operator 不知道自己能主动 verify。
- **缺 harness/ProfileLifecycle/自治回路语义**：静态片段（operator-knowledge.js:8-81）只有 test-harness 泛指，
  无自治回路对象链 / trustLevel / governance 收紧语义。

### 2. 接口（读）缺口
- P4 的 `profileLifecycle` 投影已存在（automation-runtime.js:373，经 summarizeAutomationRuntimeRegistry 暴露），
  但**没有独立 inspect surface**。P4 明确留扩展点（automation-runtime.js:371-372）："在 cli-system catalog 增
  inspect.profile_lifecycle 只读 surface 指向此投影，不碰执行路径"。operator 现在只能间接读，看不清自治治理状态。

### 3. 落地（写+验）缺口
- `operator-executor.js:24-41` 顺序执行 plan steps 经 cli-surface-executor（P2.5 已证活），但
  `operator-plan.js:168` 校验 step 用 `isOperatorExecutableSurfaceId`，后者要求 `family==="apply"`
  （operator-surface-policy.js:15）→ **operator 无法把 verify step 放进 plan**，inspect→apply→verify 闭环在
  operator 侧断在 verify 环节。

## 动手内容（最小、surgical，只补缺的）

### 知识
- `operator-knowledge.js`：`summarizeExecutableCapabilities` 改为**数据驱动**（从 live surfaces 直接列
  "id（summary）"，删硬编码 if-else 白名单）→ 自动覆盖全部 operatorExecutable surface，新增/退役自动跟随。
  `buildDynamicCapabilityFragment` 改为列 surface id + 总数收口（控制长度）。
- `operator-knowledge.js`：新增 2 个静态知识片段 `autonomy-loop-semantics`（harness/ProfileLifecycle 对象链 /
  trustLevel / governance 熔断 / inspect.profile_lifecycle 数据源）+ `operator-inspect-apply-verify`
  （inspect→apply→verify 治理闭环 + P3 commit 强制门）。
- `operator-brain.js:212`：系统提示加一行——executableSurfaces 含 apply+verify，mutate 后可追加 verify step
  （inspect→apply→verify governance loop）。保留 advice_only 诚实兜底（无对应 surface 才 advice_only）。

### 接口
- `cli-surface-catalog.js`：新增 `inspect.profile_lifecycle`（family=inspect，operatorExecutable=false，
  executable=true，只读）。
- `cli-surface-inspector.js`：新增 `inspect.profile_lifecycle` 数据源 `projectProfileLifecycle`，
  **复用既有 summarizeAutomationRuntimeRegistry 投影**在读路径内裁出 ProfileLifecycle 尾段（trustLevel/status/
  streak/governance 熔断）。**投影放在 cli-system 读路径，不跨域改 automation-runtime.js**（automation-governance
  是 P4 域，红线"不碰 automation 决策核心"）。沿用 v110-111 inspect 收口模式：只加 inspect 条目 + 数据源映射，
  不碰执行路径。

### 落地
- `operator-surface-policy.js`：可执行 family 从 `["apply"]` 扩为 `["apply","verify"]`（统一 const
  `OPERATOR_EXECUTABLE_FAMILIES`）。verify surface 本就经 cli-surface-executor 四道门（family-agnostic）+
  operatorExecutable 闸门可落地（P3 已翻 test_runs.start/test.inject 为 operatorExecutable）。这让 operator 能把
  inspect→apply→verify 串成一条治理 plan。inspect/observe/hook 仍绝不入可执行集。

## inspect / 落地闭环接全没

- **inspect**：profile_lifecycle 接全（operator 可经正式 surface 观测自治治理状态）；其余 P4 接口（automation
  runtime/summary）原已在。
- **落地闭环**：接全。operator 现在 know（知识层列全 surface + verify 可见）→ read（inspect.* 含
  profile_lifecycle）→ plan（brain executableSurfaces 含 verify）→ execute（plan 校验放行 verify family，
  executor 经 cli-surface-executor 四道门落地）→ verify（主动 test_runs.start / test.inject）。
- **强制 verify 注意**：P3 commit 强制门只管 change-set commit 路径；operator 经 plan 直接执行 apply surface
  时**不经 change-set commit**，故 P3 门管不到 operator 主动 apply——这是设计分工（operator 是强 agent，主动
  治理由其判断是否 verify，知识层已引导 inspect→apply→verify，不硬性强制 operator 每步 apply 都 verify，避免
  限制其智能）。

## 使哪些代码失效（清单）

- `operator-knowledge.js:107-124` 旧硬编码 if-else surface 白名单 **已删除**（被数据驱动版替代）——这是唯一删除项，
  且是清理红线代码（硬编码白名单）。
- 无其它代码失效；无新建并行体系。

## 红线自查

- 不限制 operator 智能：扩可执行集 + 补知识，未加 if-else 限制；保留 advice_only 诚实兜底（无对应 surface 才回）。
- 复用 EvaluationResult + source=operator，**未新建第 12 概念**：profile_lifecycle 投影复用既有
  ProfileLifecycle（第 11 概念）+ automation runtime summary，零新对象。
- 不碰 harness（P0.5）/ automation 决策核心（P4，automation-runtime.js 未改，投影放 cli-system 读路径）/
  前端 / SKILL.md / 在途包流转；只在 operator 域 + cli-system inspect 只读暴露。
- 只加 inspect 条目不碰执行路径（v110-111 模式）。UTF-8 无 BOM；无 god-object（最大 operator-knowledge.js 279 行，
  operator-snapshot.js 未动仍 375）。
- 测试更新 `cli-chain-e2e.test.js:223` 的 apply-only 断言为 apply+verify——这是反映 P5 故意的行为变更（operator
  可主动 verify），非弱化（observe/inspect 不可执行的负向断言仍在）。

## 引用代码位置

- 知识数据驱动：`extensions/watchdog/lib/operator/operator-knowledge.js`（summarizeExecutableCapabilities /
  buildDynamicCapabilityFragment / 新增 2 静态片段）
- brain 提示：`extensions/watchdog/lib/operator/operator-brain.js:212`
- 接口 surface：`extensions/watchdog/lib/cli-system/cli-surface-catalog.js`（inspect.profile_lifecycle）
- 接口数据源：`extensions/watchdog/lib/cli-system/cli-surface-inspector.js`（projectProfileLifecycle）
- 落地可执行 family：`extensions/watchdog/lib/operator/operator-surface-policy.js`
- 测试：`extensions/watchdog/tests/operator-knowledge-interface-landing.test.js`（9 用例）
