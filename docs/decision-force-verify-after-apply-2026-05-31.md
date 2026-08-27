# 决策：verify 强制门焊上 operator 主动 apply 路径（forceVerify after apply，②）

> Primary Block：`operator-cli-control` | 日期：2026-05-31
> 架构评审点名"比 ProfileLifecycle 更危险"的真缺口：inspect→apply→**verify** 闭环最后一段没焊上。

## 0. 缺口核实（file:line）

- `forceVerify`/`verifyAfterApply`/`afterApply` 全 lib **grep = NONE** → 缺口确认。
- `cli-surface-executor.js:19-30` 只守"谁能执行"（四道门：actor=operator / operatorExecutable / executable /
  source=admin_surface），**无任何代码强制 apply 改完系统后走一道 verify 把改动验回来**。
- operator 主动 apply 路径：`operator-executor.js:26` `executeOperatorExecutablePlan` 顺序执行 plan steps
  经 `executeCliSystemSurface`，apply 成功即下一步，apply-and-walk-away。

## 1. 主动 apply 路径定位 + verify 门插入点

- **主动 apply 路径**：`operator-executor.js` `executeOperatorExecutablePlan`（operator 主动治理，非
  change-set commit 那条——那条 P3 已有门）。调用链 `operator-runtime.js:56 executeOperatorPlan` → 此函数。
- **verify 门插入点**：`operator-executor.js`（apply 成功后、push step 结果前）调
  `runVerifyAfterApply(...)`，把 verify 记录挂到每个 step 的 `verification` 字段。
- **门逻辑独立文件**（executor 不撑爆）：`lib/cli-system/cli-surface-verify-gate.js`
  （`isVerifyRequiredAfterApply` / `runVerifyAfterApply`）。
- **可配置**：`forceVerify` 参数（默认 **true**=强制，评审要的），经 `operator-runtime.js executeOperatorPlan`
  透传，可显式关。

## 2. 复用 P3 哪些（不造第二套真值，红线3）

- `verificationCapability`（`admin-surface-registry.js:217 buildVerificationCapability` 已对 apply surface 生成
  `{supported, presetId, cleanMode}`）——门读它判定要不要验、用哪个 preset。
- verify surface `test_runs.start`（P3 注册，operatorExecutable）——门经它启动 verify。
- `origin*` 关联（runtimeContext.originSurfaceId → test-run，`startTestRun` origin 字段）——同 P3 链路，
  把 apply surface 作为 verify run 的 origin。
- verify 状态语义同 `normalizeVerificationStatus`（started/running/failed_to_start）——不另立状态机。

## 3. 与 P3 互补不重复（同一套机制的两个插入点）

| | 路径 | 门时机 | 门逻辑 |
|--|------|--------|--------|
| **P3** (admin-change-set-commit-gate) | admin-change-set **commit** | commit-to-applied **前** | 校验「已有 passed verification 记录」 |
| **②** (cli-surface-verify-gate) | operator **主动 apply**（plan steps） | apply 成功 **后** | 强制启动一道 verify 把改动验回来 |

- 两条 apply 全路径都焊上 verify：commit 路径（P3）+ 主动 apply 路径（②）。
- **同一套 verify 机制**（同 verificationCapability + 同 test_runs.start surface + 同状态语义），
  不是两套。门插入点不同（commit 前校验 vs apply 后启动），互不重复触发：
  ② 焊在 `operator-executor`（仅 operator 主动 plan 路径），P3 焊在 `admin-change-set-executor`（commit 路径），
  二者不共用插入点，不会对同一次操作双触发。

## 4. 异步 verify 的设计取舍（与 P3 一致）

`test_runs.start` 是**异步启动**（返回 queued run handle，非同步 pass/fail）。在 operator apply 路径里
**同步等整套 test 跑完**会重且 flaky（P3 已规避）。故 ② 的"强制 verify 门"=**apply 成功后强制把 verify
启动起来并如实记录**（operator 不能 apply-and-walk-away），pass/fail 收口由既有异步 test-run →
attach_verification/summarizeVerificationRun 链路完成（同 P3），不在 apply 路径同步阻塞。

## 5. verify 不过 / 起不来怎么处理

- verify 起不来（runner 不可用等）→ 记 `status: "failed_to_start"` + `error`，**绝不放行成「已验证成功」**。
- verify 启动成功 → 记 `status: "started"` + run handle（后续异步收口 pass/fail）。
- 豁免 surface → `status: "exempt"`（如实标记，非伪装成功）。

verify 四问（复用 P3 既有链路）：验什么=verificationCapability；证据从哪=启动的 test-run（caseResults 经既有
summarizeVerificationRun 读）；成功标准=run 完成无 failedCases（normalizeVerificationStatus=passed）；
失败归因=failed_to_start+error / 既有 failedCaseIds。

## 6. 豁免清单（如实列出，复用 P3 UNSUPPORTED_VERIFICATION_SURFACES）

`verificationCapability.supported === false` 的 apply surface 豁免强制 verify（13 个，同 P3）：
`agents.defaults.model` / `agents.defaults.heartbeat` / `agents.defaults.skills` / `graph.edge.add` /
`graph.edge.delete` / `graph.loop.compose` / `graph.loop.repair` / `runtime.loop.start` /
`runtime.loop.interrupt` / `runtime.loop.resume` / `runtime.reset` / `test_runs.start` / `test.inject`。
（verify surface 本身 test_runs.start/test.inject 豁免=不自循环。）

## 7. 红线自查

- **不造第二套 verify/verification 真值**：复用 verificationCapability + test_runs.start surface + origin* 链路
  + normalizeVerificationStatus 状态语义；仅在 operator apply 路径加一个插入点。
- **强制门是代码硬路径**：apply 成功后有 capability 就 `runVerifyAfterApply`，写死在 executor 循环里，不靠自觉。
- **一条路径**：与 P3 commit 门是同一套 verify 机制的两个插入点，不是两套。
- 不碰 harness / automation 决策核心 / 前端 / SKILL.md / 在途；只在 operator-cli-control 域。
- UTF-8 无 BOM；无 god-object（门逻辑独立 91 行文件，executor 仅 65 行）。

## 8. 引用代码位置

- 门逻辑：`extensions/watchdog/lib/cli-system/cli-surface-verify-gate.js`
- 焊入点：`extensions/watchdog/lib/operator/operator-executor.js`（apply 后 runVerifyAfterApply）
- 配置透传：`extensions/watchdog/lib/operator/operator-runtime.js`（forceVerify 默认 true；后迁入 operator/ 子目录）
- 复用：`admin-surface-registry.js:217`（verificationCapability）、`apply-rest.js`（test_runs.start）、
  `admin-change-set-verification.js`（summarizeVerificationRun）、`admin-change-set-history.js:18`（normalizeVerificationStatus）
- P3 互补对照：`admin-change-set-commit-gate.js`
- 测试：`extensions/watchdog/tests/operator-force-verify-after-apply.test.js`（7 用例）
