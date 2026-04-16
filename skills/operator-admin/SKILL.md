---
name: operator-admin
description: Runtime operator 管理技能。用于读取 OpenClaw 的 inspect/apply/verify 管理面，规划 change-set 流程，并在高风险操作前保持显式确认。
---

# Runtime Operator 管理

你操作的是 OpenClaw 的管理面，不是零散文件。

目标只有四个：

- 先 inspect，再 apply
- 优先走 admin surface / change-set，不绕开 runtime
- 把验证和执行记录留在平台里
- 遇到 structural / destructive 动作时保持保守

## 当前管理面怎么分

如果你不确定 snapshot / graph / catalog / test / change-set 这些高权限工具该怎么组合使用，去看已加载的 `operator-tooling` skill。

### 1. Inspect

先读状态，不先动手。

常用 inspect 面：

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

### 2. Apply / Verify

这是当前可执行的安全操作主面：

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

### 3. Hold / later

旧研究入口已经删除，不要再规划或引用它们。

### 4. Destructive

这些面会删东西或清空运行态：

- `agents.delete`
- `runtime.reset`

它们是 `risk: destructive`，默认不自动做。

## `stage` / `risk` / `confirmation` / `operatorPhase`

### `stage`

- `inspect`：读取事实
- `apply`：改系统状态
- `verify`：补验证证据或启动测试

### `risk`

- `read`：纯读取
- `safe`：局部、可控变更
- `structural`：会触及系统结构或已知不稳区域
- `destructive`：删除、重置、放弃运行态

### `confirmation`

- `none`：可直接读
- `changeset`：优先先存 draft，再 preview，再 execute
- `explicit`：必须显式确认；当前 runtime 会检查 `explicitConfirm: true`

### `operatorPhase`

- `O1`：读图、盘点、确认边界
- `O2`：安全变更与验证
- `later`：不是当前主线默认路径

## 什么时候先 inspect

以下情况默认先 inspect：

- 你要改已有 agent、默认值、技能或约束
- 你不确定该用哪个 surface
- 你需要知道 payload 该怎么填
- 你要做 destructive 或 later 阶段操作
- 你需要先确认验证入口是否可用

如果连目标当前状态都不知道，就不要直接 apply。

## 什么时候走 change-set

优先走 change-set 的情况：

- 这不是一次性的超小改动
- 你需要 preview payload 是否完整
- 你需要 execution history
- 你计划顺手挂验证
- surface 标了 `confirmation: changeset`
- surface 是 `explicit` / `destructive`

标准顺序：

1. `admin_surfaces.list` 看 surface 定义
2. `admin_change_sets.save` 存 draft
3. `admin_change_sets.preview` 看缺参、确认级别、验证能力
4. `admin_change_sets.execute`
5. `admin_change_sets.attach_verification` 或读取 `test_runs.detail`

## 什么时候可以直接 apply

只有在这些条件同时满足时，才考虑直接 apply：

- 目标是单点、小范围、安全变更
- 你刚做过 inspect，目标状态明确
- payload 已经完整，不需要 preview 帮你补洞
- 不需要 execution history
- 不是 `later`
- 不是 destructive

当前直接 POST 路由会立刻执行，但不会替你留下 change-set 执行链。

## 验证规则

- 不是所有 apply surface 都支持自动验证
- `test_runs.start` 用于结构化验证
- `test.inject` 用于小范围注入探测
- 默认用现行 graph / pipeline / loop 链路做回归门

默认想法：

- 结构性改动后优先看 `test_runs.detail`
- 小修补可以先 `test.inject`
- 默认值类改动不一定有自动验证能力

## 决策归属表

Operator 在规划或执行前，先分清“这件事到底该由哪一层说了算”。

不要把 `skill`、`harness`、`runtime/platform`、`operator` 四层混成一团。

| 层 | 负责什么 | 典型内容 | 不负责什么 |
|---|---|---|---|
| `skill / soul` | 任务专业语义与本地工作规则 | 实验怎么拆、做完怎么写备忘录、错误清单怎么分类、handoff 应写什么 | agent 之间谁接下一棒、loop 是否继续、结果发给谁 |
| `harness` | 单轮执行的工业化约束 | 工具调用、sandbox、timeout、artifact 收集、trace、run result、完成条件 | 平台协作拓扑、长期 automation 治理、外部渠道回传 |
| `runtime / platform` | 系统级协作与长期真值 | `AgentBinding`、`EdgeSpec`、`LoopSpec`、`ContractSpec`、`MessageEnvelope`、`replyTo / runtimeReturn / deliveryTargets`、automation governance | 某一轮内部怎么调 shell、怎么收日志、怎么整理单轮 artifact |
| `operator` | inspect / apply / verify 的管理决策 | 先看什么、能不能改、该走 direct apply 还是 change-set、需不需要显式确认、改后怎么验证 | 伪造不存在的 surface、越过 runtime 偷改平台真值、用 prompt 硬顶执行事实 |

记忆口诀：

1. `skill` 决定“应该怎么想、怎么交付业务内容”
2. `harness` 决定“这一轮必须怎么跑、怎么留下执行证据”
3. `runtime/platform` 决定“系统为什么这样协作、结果回给谁、是否继续”
4. `operator` 决定“现在该读什么、动什么、怎么验证”

## Operator 判断顺序

当用户要求你“做个实验回路”“加个 skill”“接入 harness”“让 agent 自动跑下去”时，按这个顺序判断：

1. 先判断是不是 `runtime/platform` 问题
   - 如果问题是“谁协作、回路怎么继续、结果回给谁、自动化何时唤醒”
   - 那就是平台真值问题，不要试图靠 skill 或 harness 顶掉

2. 再判断是不是 `harness` 问题
   - 如果问题是“这一轮怎么执行得更稳、更可追踪、更可重放”
   - 那就是执行层问题，优先落到 harness 或 run-level object

3. 再判断是不是 `skill` 问题
   - 如果问题是“实验应该怎么做、memo 怎么写、错误清单怎么整理、handoff 怎么写”
   - 那就是语义层问题，优先写 skill，不要误写成 runtime 规则

4. 最后判断 operator 当前有没有真实工具面
   - 有 typed surface：可以 plan + execute
   - 没有 typed surface：只能 advice_only

## 常见混淆与处理

### 1. 用户要求“实验结束后必须写备忘录和错误清单”

归属：

- 这是 `skill` 语义要求
- 可以由 harness 补执行证据
- 不能直接上升成平台协作真值

Operator 做法：

- 优先改 skill
- 如有 harness，再让 harness 补 artifact / trace / completion check

### 2. 用户要求“实验失败后自动继续下一轮”

归属：

- 这是 `runtime/platform` 的 automation governance
- 不是 skill 文案
- 也不是 harness retry 本身

Operator 做法：

- 看 automation / loop / governance 对象
- 不要只在 skill 里写“失败后继续”

### 3. 用户要求“让执行过程更标准、更可控、更可追踪”

归属：

- 这是 `harness` 问题
- skill 只能部分逼近外观，不能替代运行保证

Operator 做法：

- 不要把 tool trace / timeout / artifact collection 全塞回 prompt
- 应优先考虑 run-level object 或 harness-style substrate

### 4. 用户要求“让 researcher、worker、evaluator 的协作更清晰”

归属：

- 这是 `runtime/platform` 的 graph / loop / envelope 问题
- harness 只能增强每一棒执行证据

Operator 做法：

- 先检查 graph / loop / contract / return truth
- 不要误以为加 harness 就等于协作真值升级

## 最小边界结论

1. `skill` 可以把 agent 训得更专业
2. `harness` 可以把执行做得更工业
3. `runtime/platform` 负责让系统长期持续协作
4. `operator` 负责守住这三层边界，不让它们互相篡位

## Harness 安全模块清单

下面这些模块默认属于“安全 harness 模块”。

只要它们仍然只判断单轮 run，不触碰平台协作真值，就可以视为执行层套件。

### A. 执行守卫类

- `timeout_guard`
- `cancellation_guard`
- `retry_budget_guard`
- `tool_whitelist_guard`
- `sandbox_policy_guard`
- `network_policy_guard`
- `workspace_scope_guard`

判断标准：

- 它们只在回答“这一轮允许怎么跑”
- 不回答“系统下一步谁来跑”

### B. 证据收集类

- `trace_capture`
- `tool_call_recorder`
- `artifact_collector`
- `log_collector`
- `diff_collector`
- `metrics_collector`
- `run_summary_builder`

判断标准：

- 它们只负责把执行证据留下来
- 不负责决定协作路线

### C. 完成检测类

- `artifact_required_check`
- `schema_valid_check`
- `test_pass_required_check`
- `code_quality_gate`
- `experiment_status_connected_check`
- `result_file_exists_check`
- `completion_criteria_gate`

判断标准：

- 它们只判断“这一轮算不算完成”
- 不判断“整个 loop 是否结束”

### D. 评估输入整理类

- `score_extractor`
- `evaluation_input_builder`
- `verdict_normalizer`
- `regression_compare_helper`
- `best_run_compare_helper`

判断标准：

- 它们只把 run-level 结果整理给 evaluator / automation 使用
- 不直接代替 automation governance 下结论

### E. 运行连接类

- `run_state_persist`
- `run_resume_token`
- `run_checkpoint`
- `run_replay_helper`
- `run_failure_classifier`

判断标准：

- 它们只管理这次执行自己的生命周期
- 不拿 run state 冒充 platform thread / loop state

## Harness 越界信号清单

下面这些能力一旦开始长进 harness，就说明它在越界。

### 1. 开始决定协作对象

危险表现：

- harness 决定下一棒交给 researcher / worker / evaluator
- harness 内部直接写死 agent-to-agent 转交关系

这属于：

- `EdgeSpec`
- `ContractSpec`
- `MessageEnvelope`

不是 harness 该持有的真值。

### 2. 开始决定 loop / automation 命运

危险表现：

- harness 自己决定 `continue / conclude / pause`
- harness 自己决定 automation 何时唤醒
- harness 自己决定失败几次就结束长期任务

这属于：

- `LoopSpec`
- automation governance
- runtime wake policy

### 3. 开始持有 return / delivery 语义

危险表现：

- harness 跑完直接决定回给哪个 agent / session
- harness 跑完直接决定发 QQ / 飞书
- harness 内部持有 `replyTo / runtimeReturn / deliveryTargets`

这属于平台回桥和渠道层，不属于执行层。

### 4. 开始定义平台线程或任务身份

危险表现：

- harness session 被当成 platform thread 真值
- harness run 被当成 contract 真值
- harness job 被当成 agent identity

这会直接污染平台对象边界。

### 5. 开始变成隐形旧编排器

危险表现：

- harness flow 自己长出编排语义
- harness flow 代替 graph / loop / controller
- harness flow 自己决定阶段迁移和系统调度

这说明它已经不只是执行壳，而是在偷长控制平面。

### 6. 开始把复杂度偷偷塞回 prompt

危险表现：

- 为了配合 harness，把大量执行规则写回 skill / soul
- prompt 里开始描述 timeout、artifact sink、trace 结构、返回协议
- agent 要靠“记住一大套执行规矩”才能正常跑

这说明 harness 没真的落成运行机制，而是在借 prompt 假装落地。

## Harness 边界自检

每新增一个 harness 模块或 profile，operator 都先问这 6 个问题：

1. 它判断的是单轮 run，还是系统长期协作？
2. 它产出的是 run-level evidence，还是平台真值？
3. 它失败时影响的是本轮完成判定，还是整个 loop / automation 命运？
4. 它有没有偷偷持有 agent 路由、return、delivery 语义？
5. 它能不能在脱离 graph / loop / contract 真值的情况下独立“编排系统”？
6. 如果拿掉 prompt 文案，它还能不能靠 runtime 机制继续成立？

判定规则：

- 6 个问题里，只要有 2 个以上落到平台侧，就不要再把它叫 harness 模块
- 应改回 runtime / platform / operator surface 设计

## 最后一句

安全的 harness 是：

- run-level guard
- run-level evidence
- run-level completion

危险的 harness 是：

- route-level truth
- loop-level governance
- platform-level orchestration

## 最小操作心法

1. 先看 catalog，不要凭记忆硬填接口
2. 先看目标现状，再决定改哪里
3. 能走 change-set 就别裸奔直改
4. destructive / later 动作不当默认选项
5. 变更后补验证，不要只看 200 OK
