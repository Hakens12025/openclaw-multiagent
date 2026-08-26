---
name: openclaw-system
description: >
  OpenClaw 多 Agent 系统架构理解指南。
  何时用：需要理解 OpenClaw 多 Agent 系统架构、三关节控制链（CLI system/Operator/Automation）、
  角色两族（executor/controller）、记录面（records.db）、
  核心原则（硬软路径分界、传送带、概念预算）、如何在系统中定位自己并合规工作时使用。
  适合零上下文 agent（含 9B 本地小模型）快速上手。
---

# OpenClaw 系统理解指南

---

## 第一原则：LLM 管内容，代码管流程

这是整个系统最核心的分界线，不随版本变化。

| | 硬路径（代码保证） | 软路径（LLM 负责） |
|---|---|---|
| 内容 | 路由、状态机、调度、安全拦截、质量门控 | 任务拆解、内容生成、自然语言回复 |
| 实现 | plugin hooks、router、dispatch 逻辑 | SOUL.md、HEARTBEAT.md |
| 可靠性 | 确定性 100% | 概率性，受模型能力限制 |

**红线**：安全检查、路由分发、状态管理全部在代码里。SOUL.md 是行为引导，不是系统保证。

---

## 传送带原则（唯一 transport 原语）

传送带派工路径保持全通用：目标由图边与合约决定，不出现 agent 名称或角色专用分支。

```
agent: 读 inbox → 处理 → 写 outbox → 停止
平台: 按 pipeline 边解下一跳 + 校验投递图边 → 排队 → 目标闲时投递 → 唤醒
```

- **graph edge = 固定管线定义 + 传送带投递授权**，不是时序控制；**不是协作授权** —— agent 主动调 `assign_task`/`wake_agent` 时自己指定目标、不查图边，协作授权单源是 `collaboration-intent-policy` 角色表
- **图上成环 = 传送带沿回边重复投递**，不是独立协议（2026-08-18 起无回路运行时：`detectCycles` 只负责识环）
- **结果回传走 replyTo 元数据**，不走 graph
- **一条路径原则**：同一功能只能有一条实现路径，第二条并行通路一律合并回主路

反模式（发现即拆除）：`if (agentId === "xxx")` 的专用分支、重复复制同功能路径、以通用外衣伪装的专用代码。

---

## 运行时身体（6 个核心 runtime 对象）

| 对象 | 职责 |
|---|---|
| **Contract** | 任务载体，携带 assignee（执行者）和 replyTo（回传目标） |
| **Graph** | 固定管线拓扑 + 传送带投递授权；不管动态协作 |
| **AgentGroup** | 空间原语：GroupSpec 展开成带 groupId 的普通图边 + GroupSession |
| **Dispatch** | 外部入口 bridge，不做系统内部路由 |
| **Delivery** | 投递执行，消费 contractId 关联原始任务 |
| **Agent** | 工作单元，持有业务真值，只读写自己的 inbox/outbox |

这 6 个对象是 runtime truth 的所有者。其他层只读这些真值，不重写。

---

## 角色体系（v225 起）与记录面（v232 起）

- 系统只有 **executor + controller 两族**角色；研究/评审/施工等分支只经提示词与工具面区分。
  （评审链/reviewer/request_review、harness、回路 loop 运行时均已退役——旧文档里这些词一律按历史记录读。）
- **记账唯一真值 = `control-plane/records.db`**（代码在 `extensions/watchdog/lib/record-plane/`，
  单宽表 kind=run_event|trace_event，gseq 全局序）；体检 `node extensions/watchdog/scripts/record-reconcile.js`，
  查账 `node extensions/watchdog/scripts/run-inspect.js <id>`。

---

## 北极星：三关节控制链（重点）

三者不是顶层代码域，是 runtime 身体之上的**控制与演化关节**。
类比：手（操作面）→ 脑（治理者）→ 自治（终态）

（Harness（工具）关节已于 v226 / 2026-08-23 全退役——判定账整体删除，
裁决见备忘录149/150；「标准化」思想保留在 wiki/concepts/harness.md 作历史记录。）

```
CLI system（手）→ Operator（脑）→ Automation（自治）
```

### CLI system = 手
- **系统正式可操作表面层**：把 runtime truth 暴露成稳定可调用入口
- 五类表面：`hook`、`observe`、`inspect`、`apply`、`verify`
- 大白话：驾驶舱 + 仪表盘 + 检修口 + 合规操作面
- **系统 CLI 化** = 把散落在 hooks/timeline/snapshot/admin-surface/routes-api 的可操作表面统一收口成这一层
- **红线**：不持有业务真值，不是第四条通讯协议，不是第二控制器
- 代码：`extensions/watchdog/lib/cli-system/`

### Operator = 脑
- 治理消费层：读 formal truth + surface → inspect / apply / verify
- 只做三件事：读真值、经 CLI system 形成治理动作、验证结果
- **红线**：不准绕过 CLI system 直写真值，不当第二 planner
- 代码：`extensions/watchdog/lib/operator/`

### Automation = 最终目标
- 脑-手闭环成熟后自然长出的自治能力
- 消费：runtime truth + records.db 记账 + EvaluationResult + AutomationDecision
- **不是**定时器/日志爬虫/prompt 猜测器
- 当前状态：方向稳定，实现距完整还远

---

## 对象链（评估 → 能力演化）

```
EvaluationResult → AutomationDecision → ProfileLifecycle
 (评估层)           (治理消费)          (能力演化，本轮未建)
```

（原链头 HarnessRun 已随 harness 退役删除 v226；运行事实现由记录面 `records.db` 承担。）

三对象必须严格分离，各管各的问题：
- 评估（"表现如何"）≠ 决策（"该做什么"）≠ 演化（"能力如何成长"）

---

## 7 层架构（系统分层速查）

| Layer | 名称 | 核心职责 |
|---|---|---|
| L0 | Kernel | Contract, Graph, Delivery, store/lock/ledger — 系统原语 |
| L1 | Communication | ingress 归一化、conveyor dispatch、return routing |
| L2 | Control Plane | graph 固定管线与投递授权（含环检测）、collaboration-intent-policy 协作授权、AgentGroup |
| L3 | Execution Sandbox | before/after-tool-call 守卫、能力预设、执行预算（harness 塑形已退役 v226） |
| L4 | Evaluation | EvaluationResult、判定语义 |
| L5 | Governance | AutomationDecision、ProfileLifecycle、能力演化 |
| L6 | Projection | `extensions/watchdog/ui/` 零构建 SPA（指挥台/透视/管理） — **只读，不写回系统状态** |

三关节链是跨层的控制视图，不是对 7 层的替代。

---

## 纪律：概念预算

深水区（CLI system/Operator/Automation 这条线）只允许 8 个核心概念：

`EvaluationResult` / `CLISurface` / `ChangeSet` / `OperatorPlan` /
`AutomationSpec` / `AutomationRuntime` / `AutomationDecision` / `ProfileLifecycle`

（Harness 族三概念已随 harness 退役出列，v226。）

**升格规则**：必须同时满足：有稳定 schema、有明确 owner 和读写边界、有测试或实际消费点。
没有 schema/读写点/测试的词，不算正式对象，只是讨论词。

---

## 真值在哪里

1. **代码为准**，不以备忘录文字为准
2. 真值 owner：runtime truth = Contract / Graph / Delivery / AgentGroup（L0-L2）
3. 新增 agent 或功能必须先声明 primary System Block，再改代码
4. 测试门命令：
   ```bash
   node --test --experimental-test-module-mocks --test-concurrency=1 --test-timeout=30000 tests/*.test.js
   node ~/.openclaw/extensions/watchdog/test-runner.js            # 默认 health（零 LLM 体检）
   node ~/.openclaw/extensions/watchdog/test-runner.js --list     # live 预设表（清单以此为准，别在文档里复刻）
   ```

---

## System Blocks（开工纪律）

任何代码改动先声明归属板块：

| Block | 拥有 |
|---|---|
| `runtime-core` | Contract, envelope, stores, locks |
| `io-delivery` | ingress, replyTo, delivery |
| `agent-assembly` | AgentBinding, profile, skills |
| `graph-dispatch-queue` | graph 授权、conveyor dispatch、queue |
| `stage` | stage plan, stage runtime, stage result |
| `operator-cli-control` | operator, CLI system, admin surfaces |
| `automation-governance` | automation runtime, governance decisions |
| `projection-ui` | `ui/` 零构建 SPA（只读投影） |
| `verification-docs` | test runner, presets, wiki（不拥有 runtime 真值） |

跨 3 个以上非支撑板块的改动必须先拆任务。

检查命令：
```bash
node scripts/openclaw-block-check.js --primary <block-id>
```

---

## 关键文件指针

| 路径 | 内容 |
|---|---|
| `extensions/watchdog/lib/cli-system/` | CLISurface registry、catalog |
| `extensions/watchdog/lib/operator/` | operator-snapshot、surface-policy |
| `extensions/watchdog/lib/automation/` | automation runtime、governance decisions |
| `extensions/watchdog/lib/core/` | contract、delivery 等 L0 原语 |
| `docs/system-blocks/` | 各 block 交接页（agent 入场读这里） |
| `wiki/concepts/` | 编译知识层（WHY），cli-system/operator/automation/system-layering（harness.md 为已退役历史记录） |

---

## 为 agent 减负（小模型可驱动）

- SOUL.md 只写**通用行为**（状态机、inbox/outbox 流程）；领域 schema、数据列表、领域特有规则一律经 skills 注入
- workspace 只放必要文件（SOUL + HEARTBEAT + USER.md），1 KB ≈ 250 token，每次唤醒都付代价
- 执行类 agent 只注入最小上下文集
