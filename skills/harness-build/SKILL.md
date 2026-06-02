---
name: harness-build
description: operator 给一个迭代/质量门控 loop 装 harness 的正确方法——选模块(4 kind 基线+按需补强)→经 automations.create 组装。教 operator 把"Harness化"这一步落到真实 module 与 surface 上，不当第二 planner。
---

# 给 loop 装 Harness（operator 专用）

**何时用**：当 loop 不是跑一次就完，而是要**反复迭代到质量达标**（GAN 判别环、test 门控、schema 校验、产物把关）。这时 loop 需要 harness 来跑 round + 收口质量。纯线性一次性管线不需要 harness。

Harness = 一组**平台提供的治理模块**，包住 loop 每个 round：守卫预算/工具、采集产物/trace、用 gate 判过没过、归一失败信号。**operator 只挑模块 ref，不写模块实现**（模块是平台的，operator 不是第二 planner——红线）。

## 1. 模块目录（4 kind，共 10 个；见 `lib/harness/harness-module-catalog.js`）
- **guard（守卫）**：`harness:guard.budget`（超时/取消/重试预算）、`harness:guard.tool_access`（工具白名单/网络边界）、`harness:guard.scope`（沙箱/工作区边界）
- **collector（采集）**：`harness:collector.artifact`（产物/diff）、`harness:collector.trace`（trace/log）
- **gate（门）**：`harness:gate.artifact`（必需产物/阶段产物集/实验状态/审查产物）、`harness:gate.schema`（schema/阶段 schema/审查发现 schema）、`harness:gate.test`（test 门）
- **normalizer（归一）**：`harness:normalizer.eval_input`（评估输入归一）、`harness:normalizer.failure`（失败分类/审查 verdict 归一）

## 2. 选模块：基线 + 按需补强
- **基线**（4 kind 各一，均衡起步）：`harness:guard.budget` + `harness:collector.artifact` + `harness:gate.artifact` + `harness:normalizer.failure`。
- **按 loop 的质量需求补强**：
  - 有测试要跑 → 加 `harness:gate.test`
  - 产物有结构/schema 要求（如 reviewer 出结构化 verdict）→ 加 `harness:gate.schema`
  - 要调试/留痕 → 加 `harness:collector.trace`
  - 用不可信工具/要联网 → 加 `harness:guard.tool_access`；要限工作区 → 加 `harness:guard.scope`
- 逻辑同 `recommendHarnessModules`（`lib/operator/operator-harness-recommend.js`）：基线 + 失败信号补强。学得的好组合会经 skill 自动沉淀复用。

## 3. 组装：经 automations.create 把 harness 挂到 loop
Harness 挂在 **automation spec** 上（不是裸 `graph.loop.compose` loop）。先 `graph.loop.compose` 建好 loop 结构，再 `automations.create` 建一个驱动该 loop 的 automation，带上 harness：
- payload 关键字段：`objective`、`trigger`（如 expr/manual）、`entry`（`targetAgent` = loop entry agent、`message` = 任务）、`harness`。
- harness 二选一：
  - `harness: { moduleRefs: ["harness:guard.budget", ...] }`（自己挑的模块组合）
  - 或 `harness: { profileId: "<已登记 profile>" }`（复用现成 profile）
- **不要手设 `mode` / `assuranceLevel`**：这些由 `harness-registry.js` 据模块组合**自动派生**，硬设会被覆盖或冲突。

## 4. 治理（跑起来之后）
automation 跑 round 后链路：HarnessRun → EvaluationResult → AutomationDecision → ProfileLifecycle（见 `autonomy-loop-semantics`）。operator 用 `inspect.profile_lifecycle` / `inspect.automation_runtime_summary` 看自治状态，必要时经 `automations.*` apply 调整 + verify。

## 红线
- operator 只产 **moduleRef 粒度**：挑哪些平台模块。绝不编模块实现、绝不当第二 planner。
- harness 走 automation spec，经 CLI-system surface（plan→execute→apply→verify），不裸写 spec 文件。
- 一次性线性管线不强加 harness——只有迭代/质量门控 loop 才需要。
