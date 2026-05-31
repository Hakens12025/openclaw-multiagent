# 决策：skill 因果链自动沉淀（④，Hermes 启发 + 证据链评判）

> Primary Block：`automation-governance` | 日期：2026-05-31
> 用户精炼设计：skill 不存产物全文，存**验证过的因果对错边界**（When/Pro/Con），每条 pro/con 挂 evidence 来源。

## 1. 触发点（file:line）

`automation-finalize.js` `finalizeAutomationRound` 尾段（`nextRuntime` 算完、`onAlert`/return 前）。
此处已有 HarnessRun（`nextHarnessRun`）+ EvaluationResult + ProfileLifecycle + `nextRuntime.recentHarnessRuns`。
调 `maybePrecipitateSkillFromRound(...)`，**包 try/catch，沉淀失败不影响主流程（best-effort）**。
先读核实 P4 在尾段加的 ProfileLifecycle/upsert 结构，沉淀焊在其**后**，不冲突。

## 2. 评判阈值（代码判，非 LLM 自评）

`shouldPrecipitateSkill({ spec, evaluationResult, profileLifecycle, harnessRun })`：
- `verdict ∈ {pass, improved}`（EvaluationResult 字段判）
- gate 过（`gateSummary.failed === 0` 且 verdict ≠ "failed"）
- `score ≥ scoreThreshold`（按 scoreMax 归一，默认 0.7）
- `successStreak ≥ minSuccessStreak`（默认 2，**复用 ProfileLifecycle.successStreak**，连续成功才沉淀，避免一次性侥幸）
- `spec.skillPrecipitation.enabled !== false`（默认开，可配置）
- **必须有 `spec.harness.profileId`**（reason=no_profile_id）：沉淀的知识挂在「任务族（harness profile）」上，
  不挂一次性 automation id。无 profileId 的临时 automation（含测试 fixture）没有稳定族身份 → 不沉淀。
  这同时避免了"一次性 automation 写出一堆孤儿 learned-<id> skill"的污染。

全部代码判 EvaluationResult/HarnessRun/ProfileLifecycle 字段；**不让 LLM 判值不值得沉淀**。
失败时返回如实 reason（streak_below_min / verdict_not_success / gate_not_passed / score_below_threshold / disabled）。

## 3. 抽因果对（Pro 从成功 evidence / Con 从 failure_class）

`extractCausalSkill({ spec, harnessRun, evaluationResult, recentHarnessRuns })`：
- **When**：从 HarnessRun 的 `profileId` + spec `objective.summary` + run `summary` 抽"什么情况"。
- **Pro**：遍历成功 HarnessRun 的 `moduleRuns`（status=passed），从 summary/testSignal evidence 抽"这么做对了"，
  **每条挂 `evidence: { harnessRunId, moduleId }`**。兜底：gate 全过则挂整体成功背书。
- **Con**：遍历 `recentHarnessRuns` 里**同 profile 任务族**的失败 run（gate.failed>0 / terminalStatus=failed），
  从 moduleRuns evidence 的 `failureClass`（**复用 P0 HARNESS_EVIDENCE_KEY.FAILURE_CLASS + FAILURE_CLASS_STRATEGIES**）
  抽"这么做错了 + 应对策略"，**每条挂 `evidence: { harnessRunId, failureClass, moduleId }`**。
- **没失败证据 → Con 留空数组，绝不编**（只留验证后的因果）。
- **没 Pro 证据 → 返回 null，不沉淀**（Pro 必须有成功 evidence 背书）。

## 4. 每条 pro/con 怎么挂 evidence（vs Hermes 关键差异）

- Pro evidence: `{ harnessRunId, moduleId }`（或 `{ harnessRunId, gateVerdict }` 兜底）——成功 HarnessRun 背书。
- Con evidence: `{ harnessRunId, failureClass, moduleId }`——失败 HarnessRun 的 failure_class 背书。
- SKILL.md 正文每条 pro/con 后内联 `_[evidence: {...}]_`，**写死证据来源**。
- **vs Hermes（LLM 自评招式）：我们的因果对有证据链（harnessRunId/failureClass），不是 LLM 拍脑袋总结。**

## 5. 写 SKILL.md + 注入 + 去重

- 写到 `~/.openclaw/skills/learned-<profileId>/`：`SKILL.md`（name/description frontmatter + When/Pro/Con，
  沿用现有 skill convention，下次经现有 progressive disclosure(v114) 注入）+ `SOURCE.json`
  （`{ harnessRunId, evaluationResultId, originHash, precipitatedAt }` 元数据）。
- **去重**：`originHash`（sha256(when+pros+cons).slice(0,16)）；写前比对已存 SOURCE.json 的 originHash，
  相同则跳过（reason=duplicate_origin_hash）。

## 6. 配置开关 + onAlert 事件

- 开关：`spec.skillPrecipitation.{enabled, scoreThreshold, minSuccessStreak, scoreMax}`（默认开）。
- 事件：新增 `EVENT_TYPE.SKILL_PRECIPITATED = "skill_precipitated"`，写成功后 onAlert 发出
  （携带 skillName/originHash/pro|conCount/harnessRunId/evaluationResultId），dashboard 可观测。

## 7. 红线自查

- **代码判评判，LLM 只产内容**：shouldPrecipitateSkill 用 EvaluationResult/HarnessRun/ProfileLifecycle 字段判，
  skill 正文从 agent 真实产出（moduleRuns summary）/failure_class 抽，不让 LLM 自评值不值得。
- **只留验证后因果**：Pro 必须有成功 harnessRunId、Con 必须有失败 failureClass，没证据的不写（Con 可空、无 Pro 不沉淀）。
- **守概念预算**：skill 是已有概念（不新增第 12）；沉淀机制是流程（代码）。与 ProfileLifecycle（调流程参数）
  不重叠——这个积累内容知识。复用 progressive disclosure(v114)、HARNESS_FAILURE_CLASS(P0)、
  ProfileLifecycle streak(P4)，不造第二真值。
- 不碰 harness 核心/operator/前端/SKILL.md（既有）/在途；UTF-8 无 BOM；无 god-object（沉淀模块 286 行独立文件，
  finalize 焊入仅 ~18 行 + import）。
- 纯增量：新建 automation-skill-precipitation.js + finalize 尾段 best-effort 调用 + 1 个 event type。

## 8. 引用代码位置

- 沉淀机制：`extensions/watchdog/lib/automation/automation-skill-precipitation.js`
  （shouldPrecipitateSkill / extractCausalSkill / precipitateSkill / maybePrecipitateSkillFromRound）
- 触发点：`extensions/watchdog/lib/automation/automation-finalize.js`（finalizeAutomationRound 尾段）
- 事件：`extensions/watchdog/lib/core/event-types.js`（SKILL_PRECIPITATED）
- 复用：`harness/harness-evidence-vocab.js`（HARNESS_FAILURE_CLASS / FAILURE_CLASS_STRATEGIES / HARNESS_EVIDENCE_KEY，P0）、
  `automation/profile-lifecycle.js`（successStreak，P4）、`harness/evaluator-result.js`（EvaluationResult）
- 测试：`extensions/watchdog/tests/automation-skill-precipitation.test.js`（13 用例）
