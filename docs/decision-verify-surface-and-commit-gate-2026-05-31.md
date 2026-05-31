# 决策：verify 暴露为正式表面 + admin-change-set commit 强制 verify 门

> 阶段：P3（死链 b 下半 = operator "手" 的真缺口） | Primary Block：`operator-cli-control` | 日期：2026-05-31
> 前置：P2.5 已裁定 admin-surface 为唯一 apply/surface 真值源（static 读层 / policy 过滤多视图）。本阶段沿用该分层，不造第二套。

## 0. 纠正一个框架性出入（实测）

任务描述说"apply 后跑 verify → 不过则不 commit"。实测 `admin-change-set-executor.js` 的流水线顺序是
**apply(写操作) → verify → record(commit)**，apply 本身已改系统状态，事后 verify 拦不住已发生的 apply。
且原 verify 是 **fire-and-forget**（`test_runs.start` 只**启动**异步测试，status="started"，不等结果、不判 pass/fail）。

因此本阶段把语义收敛为可落地、不引入长跑 flaky 的硬门：

> **commit-to-applied** 之前，apply-stage 且 `verificationCapability.supported` 的 ChangeSet
> **必须已有一条 `passed` 的 verification 记录**（经既有 `verificationHistory` 字段链落入）。
> 不过门 → **不记 applied**，改记 `verification_blocked` 并**抛错**，commit 被硬拦。

门校验的是**既有 verify 真值字段**（来自之前 `attach_verification` 从 test-run/report 产物读 pass/fail），
而非在 commit 里现跑测试——天然复用既有字段链、不长跑、不造第二套。

## 1. verify 暴露为正式 verify 表面

- 3 个 admin `stage:verify` surface 本就经 P2.5 合并入 cli-surface-registry（family=verify）。真缺口 = 它们
  `operatorExecutable:false`，operator 不能主动 verify。
- 暴露点（单源 = admin catalog，沿用 P2.5 裁定）：
  `extensions/watchdog/lib/admin/catalog/apply-rest.js:315`（`test_runs.start`）与 `:326`（`test.inject`）
  加 `operatorExecutable: true`。
- 实测合并后：cli-system `operatorExecutable` 28 → **30**；`test_runs.start` / `test.inject` 现
  `{family:verify, operatorExecutable:true, executable:true, source:admin_surface}`，过 cli-surface-executor
  四道门（family-agnostic）。`admin_change_sets.attach_verification` 无 handler → `executable:false` 保持不可执行（非旁路）。
- **未造第二套 verify family**：经唯一 cli-surface-registry 暴露，admin 单源。

## 2. commit 强制 verify 门（核心，代码硬路径）

- 门逻辑独立成模块（避免 executor god-object）：
  `extensions/watchdog/lib/admin/admin-change-set-commit-gate.js`（`evaluateCommitVerificationGate` /
  `isVerificationRequiredForCommit` / `CommitVerificationBlockedError`）。
- 插入点：`extensions/watchdog/lib/admin/admin-change-set-executor.js`
  - 函数签名加 `requireVerification = true`（默认开启）。
  - apply 成功后、`recordAdminChangeSetExecution(applied)` 之前插门（约 L92-114）：
    门 `required && !passed` → 记 `executionStatus:"verification_blocked"`（status:"failed"）+ 抛
    `CommitVerificationBlockedError`。
  - 外层 catch 对 `CommitVerificationBlockedError` 直接上抛（门已自记，防重复记录）。
- 路由透传：`routes/admin-change-sets.js:124` `requireVerification: payload.requireVerification !== false`
  （默认开，仅显式 `false` 放行——对应"explicit opt-out"，与 explicitConfirm 同形）。
- **门是代码硬路径**：不过 verify 不能进 applied 写死在 commit 路径，不靠自觉。

### verify 四问怎么落（全复用既有链路，红线四）

| 问 | 落点（既有代码） |
|----|------------------|
| 验什么 | `verificationCapability`（surface 声明，`admin-surface-registry.js:217 buildVerificationCapability`），门读 `preview.verificationCapability.supported` |
| 证据从哪 | `admin-change-set-verification.js` `resolveVerificationRun`（读 test-run / report `.json` 产物）→ `summarizeVerificationRun` 取 `caseResults`/`failedCases` |
| 成功标准 | `admin-change-set-history.js:18 normalizeVerificationStatus`（`failedCases>0`→failed，`completed && totalCases>0`→passed），门判 `lastVerificationStatus==="passed"` |
| 失败如何归因 | `verificationHistory[].failedCaseIds` / `blockedCaseIds`，门 fail 时回带 |

verify 只验证不提交（不退化成"没抛异常=成功"）：门要求**实有 passed 记录**，缺失/failed/blocked 全部拦。

## 3. 回写哪些既有字段（不造第二套，红线三）

- verify 结果落既有 `verificationHistory`（经 `attach_verification` → `mergeVerificationRecord`，
  `admin-change-sets.js:280`），派生 `lastVerificationStatus`/`lastVerificationRunId`/`verificationCount`
  （`admin-change-set-history.js:60 summarizeVerificationHistory`）。
- 门拦截写既有 `executionHistory`（`recordAdminChangeSetExecution`），`executionStatus:"verification_blocked"`。
- ChangeSet 状态仍由既有 `resolveDraftStatus`（`admin-change-set-history.js:115`）派生：passed→verified、
  failed→verification_failed、blocked → 不进 applied（落 storedStatus，关键不变量：**不变 applied**）。
- **未新增任何 verify 字段、未新增状态机真值源。**

## 4. 使哪些代码失效（清单）

- **无 runtime 代码失效、无删除**。本阶段是新增门 + 翻 2 个 verify surface 的 operatorExecutable。
- 原 executor 的 fire-and-forget `test_runs.start`（L96 区段）**保留**（startVerification 时仍可主动启动异步
  验证供后续 attach），其语义不变；门是**额外**前置校验，不替换它。
- `requireVerification` 默认 true：所有走 commit 路径的 apply-stage verify-supported surface 即起门控
  （31/44 apply 受门控，13 个 `UNSUPPORTED_VERIFICATION_SURFACES` 豁免——graph/loop/runtime ops）。

## 5. 红线自查

- 未造第二套 verify：经唯一 cli-surface-registry 暴露，admin 单源；verify 结果落既有字段。
- 强制门是代码硬路径：不过 verify 不能 commit 写死在 executor + 抛错，路由默认开。
- 未碰 harness（P0.5 已完）/ automation / 前端 / SKILL.md / 在途包流转（未碰 dispatch-graph-policy / runtime-mailbox）。
- UTF-8 无 BOM；surgical；executor 202 行（未超 god-object 阈值，门逻辑外置成 68 行独立模块）。

## 6. 引用代码位置

- verify 暴露：`extensions/watchdog/lib/admin/catalog/apply-rest.js:315,326`
- 门模块：`extensions/watchdog/lib/admin/admin-change-set-commit-gate.js`
- 门插入点：`extensions/watchdog/lib/admin/admin-change-set-executor.js`（apply 后 / record applied 前 + 外层 catch 放行门错）
- 路由透传：`extensions/watchdog/routes/admin-change-sets.js:124`
- verify 字段链：`admin-change-set-verification.js`、`admin-change-set-history.js:18,60,115`、`admin-change-sets.js:258,280`
- verificationCapability：`admin-surface-registry.js:217`
- 测试：`extensions/watchdog/tests/admin-change-set-verify-gate.test.js`（10 用例）
