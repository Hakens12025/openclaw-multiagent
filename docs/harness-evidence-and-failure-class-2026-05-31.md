# HarnessModule evidence key 命名规范 + failure_class 归一清单

> 日期 2026-05-31 · P0 HarnessModule 接口归一产出
> 权威代码：`extensions/watchdog/lib/harness/harness-evidence-vocab.js`
> 本文档是说明，**代码常量是真值**（冲突以代码为准）。

## 1. 5+1 对象契约（单一 schema）

`harness-module-schema.js` 是 HarnessModule 生命周期对象的**单一权威字段定义**，提供 6 个 validate：

| 对象 | producer | validate | 必填字段 |
|---|---|---|---|
| HarnessModuleDefinition | catalog | `validateHarnessModuleDefinition` | id(`harness:`前缀) / kind |
| HarnessModuleConfig | `automationSpec.harness.moduleConfig[id]` | `validateHarnessModuleConfig` | （plain object，键随模块） |
| HarnessModuleStartInput | `buildHarnessModuleStartInput` | `validateHarnessModuleStartInput` | phase="start" / module |
| HarnessModuleFinalizeInput | `buildHarnessModuleFinalizeInput` | `validateHarnessModuleFinalizeInput` | phase="finalize" / module |
| HarnessModuleResult (moduleRun) | `normalizeHarnessModuleRun` | `validateHarnessModuleResult` | moduleId / kind / status |
| HarnessRun (run 级唯一事实源) | `normalizeHarnessRun` | `validateHarnessRun` | automationId / round / status |

- **4 kind 集合** `guard|collector|gate|normalizer` 由 `VALID_HARNESS_MODULE_KINDS`（schema.js）唯一定义；`harness-module-contract.js` 复用，不重建。
- **HarnessRun.schemaVersion**：预留演化槽（P2/P4 加字段用）。validate 仅校验"非负整数"，**不实现演化逻辑**（留到 P7）。

## 2. evidence key 命名规范

`HarnessRun.moduleRuns[].evidence` 是自由 record（形状随 kind 而异），但跨模块共享的 key 在 `HARNESS_EVIDENCE_KEY` 固定命名：

| key | 常量 | 语义 | producer |
|---|---|---|---|
| `failureClass` | `FAILURE_CLASS` | 失败归类（见 §3） | `normalizer.failure` evidence |
| `path` | `ARTIFACT_REF` | 产出件路径引用 | `collector.artifact`/`gate.artifact` evidence |
| `present` | `ARTIFACT_PRESENT` | 产出件是否存在 | artifact evidence |
| `terminalStatus` | `TERMINAL_STATUS` | 终态状态透传 | `normalizer.failure` |
| `testSignal` | `TEST_SIGNAL` | 测试信号 `{status,signal,source}` | `gate.test` |

### artifactRef 红线（P2 强依赖）

P2 的 `findings.artifactRef` **只能由代码**从 HarnessRun evidence 的 artifact 路径（`collector.artifact`/`gate.artifact` 的 `evidence.path`）提取，**LLM 不得自填**（红线5：findings.artifactRef 由代码提取；找不到拒收）。`ARTIFACT_REF` 常量就是这个提取点的稳定 key。

## 3. failure_class 归一清单

`classifyFailure`（`harness-module-evidence.js`）由终态 status/reason 推导 failure_class；`FAILURE_CLASS_STRATEGIES`（消费端 `automation-decision.js`）每类对应一条 rework 策略。两端现共用 `harness-evidence-vocab.js` 的单一清单：

| failure_class | rework 策略 | 触发 |
|---|---|---|
| `timeout` | increase_timeout_or_simplify_task | reason 含 timeout |
| `awaiting_input` | provide_missing_input_then_resume | status=awaiting_input |
| `cancelled` | review_cancellation_cause_before_retry | status=cancelled |
| `abandoned` | reassess_feasibility_before_retry | status=abandoned |
| `failed` | analyze_failure_and_retry_with_fixes | status=failed |
| `review_rejected` | address_review_feedback_and_resubmit | review 拒绝 |

**非封闭枚举**：`classifyFailure` 未命中归一类时透传原始 status 字符串（兜底）；消费端 `FAILURE_CLASS_STRATEGIES` 取不到则 strategy 为 null。`KNOWN_HARNESS_FAILURE_CLASSES` 是已知归一类清单，供校验/文档，不是穷举所有可能值。

## 4. 归一的 4 处（P0 收口）

1. **4 kind 集合**：`harness-module-contract.js` 不再本地 `Object.freeze` 重定义，改 import `harness-module-schema.js` 的 `HARNESS_MODULE_KIND`/`VALID_HARNESS_MODULE_KINDS`。
2. **failure_class strategies**：`automation-decision.js` 删本地 `FAILURE_CLASS_STRATEGIES`，import `harness-evidence-vocab.js`。
3. **failure_class 产值**：`harness-module-evidence.js` `classifyFailure` 字面量改引 `HARNESS_FAILURE_CLASS` 常量。
4. **5 对象 validate**：散在 runner/run/evidence/evaluators 的隐式形状假设，收口为 schema.js 的正式 validate（接口测试锁 start/finalize/evidence 回收 + HarnessRun 聚合）。
