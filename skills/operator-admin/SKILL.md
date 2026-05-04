---
name: operator-admin
description: Runtime operator 管理技能。用于读取 OpenClaw 的 inspect/apply/verify 管理面，规划 change-set 流程，并在高风险操作前保持显式确认。
---

# Runtime Operator 管理

Operator 是设置页里的系统控制 agent。它管理 runtime、graph、agent、skill、harness、automation 和验证入口。

## 管理顺序

1. `inspect`：读取事实。
2. `plan`：选择 surface、payload、验证入口和风险级别。
3. `apply`：通过 admin surface 或 change-set 修改系统。
4. `verify`：记录测试、快照或人工验证证据。

## Inspect 面

- `agents.list`
- `skills.list`
- `admin_surfaces.list`
- `admin_change_sets.list`
- `admin_change_sets.detail`
- `admin_change_sets.preview`
- `work_items.list`
- `runtime.read`
- `models.list`
- `agents.defaults.read`
- `test_runs.list`
- `test_runs.detail`

## Apply / Verify 面

- `agents.create`
- `agents.defaults.model`
- `agents.defaults.heartbeat`
- `agents.defaults.skills`
- `agents.model`
- `agents.heartbeat`
- `agents.constraints`
- `agents.name`
- `agents.description`
- `agents.card.tools`
- `agents.card.formats`
- `agents.role`
- `agents.skills`
- `admin_change_sets.save`
- `admin_change_sets.execute`
- `admin_change_sets.attach_verification`
- `test_runs.start`
- `test.inject`

## 高风险面

- `agents.delete`
- `runtime.reset`

这些 surface 使用 `risk: destructive` 和显式确认。

## stage / risk / confirmation

- `stage=inspect`：读取事实。
- `stage=apply`：改变系统状态。
- `stage=verify`：补验证证据或启动测试。
- `risk=read`：纯读取。
- `risk=safe`：局部安全变更。
- `risk=structural`：系统结构变更。
- `risk=destructive`：删除、重置或放弃运行态。
- `confirmation=none`：直接读取或低风险执行。
- `confirmation=changeset`：draft、preview、execute、attach verification。
- `confirmation=explicit`：payload 包含 `explicitConfirm: true`。

## change-set 顺序

1. `admin_surfaces.list` 读取 surface 定义。
2. `admin_change_sets.save` 保存 draft。
3. `admin_change_sets.preview` 检查 payload、确认级别和验证能力。
4. `admin_change_sets.execute` 执行。
5. `admin_change_sets.attach_verification` 或读取 `test_runs.detail`。

## 直接 apply 条件

- 单点、小范围、安全变更。
- 已 inspect 当前状态。
- payload 完整。
- surface 风险不是 destructive。
- 本轮不需要 change-set history。

## 验证入口

- 结构性改动优先 `test_runs.start`。
- 小范围探测使用 `test.inject`。
- 默认值和配置变更记录 operator snapshot 或 surface response。
- graph、contract、loop、automation 变更使用现行 formal/harness 入口回归。

## 四层归属

| 层 | 负责什么 | 典型内容 |
|---|---|---|
| `skill / soul` | 任务专业语义与本地工作规则 | 实验方法、memo 写法、错误分类、handoff 结构 |
| `harness` | 单轮执行工业化约束 | 工具调用、sandbox、timeout、artifact、trace、run result、完成条件 |
| `runtime / platform` | 系统级协作与长期真值 | AgentBinding、EdgeSpec、LoopSpec、ContractSpec、MessageEnvelope、delivery、automation governance |
| `operator` | inspect / apply / verify 管理决策 | 读哪个 surface、如何改、是否 change-set、怎么验证 |

## 判断顺序

1. 涉及协作对象、回路推进、结果回流、automation 唤醒时，归入 `runtime/platform`。
2. 涉及单轮执行稳定性、trace、artifact、timeout 时，归入 `harness`。
3. 涉及业务方法、memo、错误清单、handoff 写法时，归入 `skill`。
4. 涉及系统管理动作、风险确认和验证证据时，归入 `operator`。

## Harness 安全模块

安全 harness 模块只处理 run-level guard、run-level evidence、run-level completion。

执行守卫：

- `timeout_guard`
- `cancellation_guard`
- `retry_budget_guard`
- `tool_whitelist_guard`
- `sandbox_policy_guard`
- `network_policy_guard`
- `workspace_scope_guard`

证据收集：

- `trace_capture`
- `tool_call_recorder`
- `artifact_collector`
- `log_collector`
- `diff_collector`
- `metrics_collector`
- `run_summary_builder`

完成检测：

- `artifact_required_check`
- `schema_valid_check`
- `test_pass_required_check`
- `code_quality_gate`
- `experiment_status_connected_check`
- `result_file_exists_check`
- `completion_criteria_gate`

评估输入整理：

- `score_extractor`
- `evaluation_input_builder`
- `verdict_normalizer`
- `regression_compare_helper`
- `best_run_compare_helper`

运行连接：

- `run_state_persist`
- `run_resume_token`
- `run_checkpoint`
- `run_replay_helper`
- `run_failure_classifier`

## Harness 边界自检

新增 harness 模块或 profile 时回答：

1. 它判断单轮 run 还是长期协作？
2. 它产出 run-level evidence 还是平台真值？
3. 它失败时影响本轮完成还是 loop / automation 命运？
4. 它是否持有 agent 路由、delivery 或 replyTo 语义？
5. 它离开 graph / loop / contract 后是否仍在编排系统？
6. 它移除 prompt 文案后是否仍由 runtime 机制成立？

两个以上答案落在平台侧时，归入 runtime/platform/operator surface 设计。

## 最小操作心法

1. 先看 snapshot / graph / catalog。
2. 有 typed surface 才执行。
3. 结构变更优先 change-set。
4. destructive 变更使用显式确认。
5. 变更后记录验证证据。
