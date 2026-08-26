# Harness

> 执行塑形层：限制一次执行、采集一次执行、生成一次 `HarnessRun`。

> **已退役 v226（2026-08-23）**：harness 判定账已全退役（代码全删），裁决与施工单见
> `use guide/备忘录149_[主]_裁决_阶段012开工与harness全退役_2026-08-20-0130.md` 与
> `use guide/备忘录150_[主]_评审链删除与reviewer角色退役_2026-08-22-2212.md`。
> 本页保留作历史设计记录；其中「标准化」思想（声明式模块、证据归一、配置即契约）仍然有效。
## 是什么

Harness 是执行层工具箱，不是平台总控。

它当前只允许持有三类正式对象：

1. `HarnessSelection`
2. `HarnessRun`
3. `HarnessModuleResult`

当前 active module kind 只保留 4 类：

| Kind | 作用 |
|------|------|
| `guard` | 预算、工具、作用域限制 |
| `collector` | artifact / trace 采集 |
| `gate` | 完成/验证门控 |
| `normalizer` | evaluator 输入与失败归一化 |

当前代码里的正式入口：

- [extensions/watchdog/lib/harness/harness-registry.js](/Users/hakens/.openclaw/extensions/watchdog/lib/harness/harness-registry.js)
- [extensions/watchdog/lib/harness/harness-run.js](/Users/hakens/.openclaw/extensions/watchdog/lib/harness/harness-run.js)
- [extensions/watchdog/lib/harness/harness-module-runner.js](/Users/hakens/.openclaw/extensions/watchdog/lib/harness/harness-module-runner.js)

## 冻结的模块接口

v109-stable 起，module 注册非静默拒绝不合规项：`lib/harness/harness-module-schema.js` 的 `validateHarnessModuleDefinition` 要求 `id` 必带 `harness:` 前缀、`kind`∈{guard,collector,gate,normalizer}。

正式入口 `lib/harness/harness-module-catalog.js` 冻结 **10 个模块 / 4 kind**（`freezeCatalog` 逐项经 `validateHarnessModuleDefinition`）：

| Kind | 模块 |
|------|------|
| guard | `guard.budget` / `guard.tool_access` / `guard.scope` |
| collector | `collector.artifact` / `collector.trace` |
| gate | `gate.artifact` / `gate.schema` / `gate.test` |
| normalizer | `normalizer.eval_input` / `normalizer.failure` |

对象链：`HarnessRun → CLI System → Operator → Automation`。端到端样例见 `tests/cli-chain-e2e.test.js`，验证这四关节接上（harness 产出经 `inspect.harness_runs` 被 operator 读到，再喂 automation）。源: 备忘录114 §6。

### operator 装 harness 层

operator 装配 harness 经 `lib/operator/operator-harness-recommend.js` —— **只挑 `moduleRef` 粒度**（不编 module 实现、不当第二 planner），配套 `skills/harness-build/SKILL.md`，最终经 `automations.create` 组装。

## 灵魂落地（v115，P0/P0.5）

接口归一后补齐 harness 作为"塑形工具"的完整性：

- **Run-Shape Map**：正式对象（`lib/harness/run-shape-map.js`），描述一次 run 该长什么形状 + coverage 完整性校验。
- **soft 段反逼**：`lib/harness/soft-guidance.js` 从 run 实况反推建议，喂回塑形。
- **Meta-harness 严格闸**：module 注册/组合走严格校验，拒绝不合规拼图。

## 为什么存在

- 让一次执行可限制
- 让一次执行可采证
- 让上层吃到统一 `HarnessRun`

## 和谁交互

- **向上**: 从属于 [automation-of-automation](automation-of-automation.md)（harness 是前置条件，不是目标）
- **向下**: 消费 agent 的工具调用事件
- **平行**: 为 [evaluation-result-chain](evaluation-result-chain.md) 提供 HarnessRun 数据
- **约束来源**: [system-layering](system-layering.md) 定义 harness 在分层中的位置

### Harness 不定义

- 谁与谁协作
- 合约回给谁
- 下一跳要不要继续
- automation 如何治理

## 演化

| 阶段 | 事件 |
|------|------|
| 备忘录 61 | 首次提出 harness 概念，定义执行底座职责 |
| 备忘录 62 | 明确 harness 与 platform 正交关系 |
| 备忘录 63 | 模块类型分类（guard/collector/gate/adapter） |
| 备忘录 78 | Jigsaw 模型：拼图式组合，拒绝 mega orchestrator |
| v109-stable | `validateHarnessModuleDefinition` 模块接口冻结；10 模块 / 4 kind catalog 落地 |
| v115-stable | 灵魂落地完成（Run-Shape Map / soft 反逼 / Meta-harness 严格闸）；operator-harness-recommend（moduleRef 粒度） |

## 当前状态

- 设计方向：稳定
- 正式接口：已冻结（v109，`harness-module-catalog.js` 10 模块 / 4 kind）
- 实现：灵魂落地完成（v115）；operator 经 `operator-harness-recommend.js` + `automations.create` 装配

相关概念: [CLI System](cli-system.md) | [Operator](operator.md) | [Automation of Automation](automation-of-automation.md) | [Evaluation Result Chain](evaluation-result-chain.md)
