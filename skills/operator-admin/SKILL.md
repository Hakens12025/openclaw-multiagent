---
name: operator-admin
description: Runtime operator 管理技能。用于读取 OpenClaw 的 inspect/apply/verify 管理面，规划 change-set 流程，并在高风险操作前保持显式确认。
---

# Runtime Operator 管理

你操作的是 OpenClaw 管理面。operator 是隐藏 runtime control agent，入口在 runtime operator surface。

目标：

- inspect 读取事实
- apply 使用 admin surface / change-set
- verify 留下验证证据
- structural / destructive 动作保持显式确认

## 管理面分工

### Inspect

常用读取面：

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

### Apply / Verify

常用执行面：

- `agents.create`
- `agents.defaults.model`
- `agents.defaults.heartbeat`
- `agents.defaults.skills`
- `agents.model`
- `agents.heartbeat`
- `agents.constraints`
- `agents.name`
- `agents.description`
- `agents.tools`
- `agents.card.formats`
- `agents.role`
- `agents.skills`
- `admin_change_sets.save`
- `admin_change_sets.execute`
- `admin_change_sets.attach_verification`
- `test_runs.start`
- `test.inject`

### Destructive

- `agents.delete`
- `runtime.reset`

这些面带 `risk: destructive`，执行前需要显式确认。

## 阶段字段

- `inspect`：读取事实
- `apply`：改系统状态
- `verify`：补验证证据或启动测试

## 风险字段

- `read`：纯读取
- `safe`：局部、可控变更
- `structural`：触及系统结构或已知不稳区域
- `destructive`：删除、重置、放弃运行态

## 确认字段

- `none`：可直接读
- `changeset`：先存 draft，再 preview，再 execute
- `explicit`：需要 `explicitConfirm: true`

## Operator 判断顺序

1. 判断是否属于 `runtime/platform`：谁协作、回路怎么继续、结果回给谁、自动化何时唤醒
3. 判断是否属于 `skill`：实验怎么做、memo 怎么写、错误清单怎么整理、handoff 怎么写
4. 判断当前是否有真实 typed surface：有 surface 就 plan + execute；缺 surface 就 advice_only

## 四层边界

| 层 | 负责什么 | 典型内容 |
|---|---|---|
| `skill / soul` | 任务专业语义与本地工作规则 | 实验拆解、备忘录、错误清单、handoff |
| `runtime / platform` | 系统级协作与长期真值 | `AgentBinding`、`EdgeSpec`、`GroupSpec`、`ContractSpec`、`MessageEnvelope`、delivery |
| `operator` | inspect / apply / verify 的管理决策 | 读什么、动什么、走 direct apply 还是 change-set、如何验证 |

## 操作顺序

1. 读 snapshot / graph / catalog
2. 确认目标和 surface
3. 结构性变更走 change-set
4. 执行后补 verification
5. 把结果回写到 operator 对话
