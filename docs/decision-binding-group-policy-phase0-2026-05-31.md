# 决策：通用 binding policy 机制（P6-Phase0，agent-group 三阶段第一步）

> 阶段：P6-Phase0 | Primary Block：`agent-assembly` | 日期：2026-05-31
> 三阶段：Phase0 建通用机制不删 contractor → Phase1 迁 contractor 到 policy → Phase2 AgentGroup 宏展开。
> 本阶段纯增量建机制，零删除、零行为变更。

## 0. 调研纠正：任务前提与实测的重大偏差

任务前提说"executionPolicy 今天不存在于 agent-binding-store.js，Phase0 第一步是建出 schema"。
**实测：大部分 Phase0 机制已经存在**（先前 phase 已建），不能重建（会造真值分裂，违反一条路径原则）：

- `agent-binding-store-read.js:13-15` 已声明 `executionPolicy` schema：
  `EXEC_POLICY_BOOLEANS=["planRequired","draftLifecycle","autoFollowUp","noDirectIntake"]`、
  `EXEC_POLICY_NUMBERS=["autoPromoteTimeout"]`、`EXEC_POLICY_ENUMS={sessionCleanup:["immediate","deferred"]}`。
  备忘录86 想要的 `executionPolicy.planRequired` 已存在并有 validate（`sanitizeBindingPolicies` read.js:196-217）+
  序列化（write.js:84-86）+ admin patch（agent-admin-policies.js:75-80）。
- helper 已建且有真实消费者：`getExecutionPolicy`（agent-identity.js:341）、`hasExecutionPolicy`（:348），
  消费者 `before-start-ingress.js:69` 用 `!hasExecutionPolicy(agentId,"noDirectIntake")`。
- `dispatchOrigin` 配置位已存在：`agent-identity.js:291-292` 读 `config.agents.dispatchOrigin || config.graph.dispatchOrigin`。

## 1. contractor 硬编码全图（Phase1 迁移目标，本阶段只调研不动）

- **运行时 contractor 硬编码已被迁走**：无 `contractor-service.js`、无 `resolvePlannerAgentId` /
  `collectContractorOutbox` / `routeContractorInbox` / `autoPromoteDraft`。系统已用 `planner` role
  （agent-metadata.js:5 `PLANNER:"planner"`、ROLE_FALLBACK_IDS:20-21）。
- 剩 15 处 "contractor" 引用**全在 formal-runtime 测试套件**（suite-loop-direct.js / suite-loop-platform.js /
  test-locks.js:117）——是测试 fixture（workspace 名 + "ContractorContract" 测试概念），非运行时硬编码。
- 当前真正的"role 硬编码"分布在：role-spec-registry.js / system-action-role-policy.js /
  capability-preset-registry.js / runtime-admin.js / agent-enrollment-discovery.js / soul-template-builder.js —
  这是 Phase1 该评估的 role→policy 迁移点（不是 contractor）。

## 2. 裁定与建了什么（最小纯增量）

裁定：**不重建已存在的 executionPolicy/helper/dispatchOrigin**（避免真值分裂）。只补备忘录86 列的、当前确实
不存在、且纯增量的两个 policy 容器字段：`outputPolicy` + `inboxPolicy`。

**不建 `plan-dispatch-service` 空骨架**：当前无任何消费者、planner role 路径仍在，空 service 会成死代码
（违反 CLAUDE.md"不使用的代码是 bug 温床"）。留到 Phase1 有消费者时再建。

新增（全部有 schema+validate+round-trip 测试）：
- `outputPolicy { format:"contract-json"|"passthrough", aggregateGroup:string }`
  （替代 collectContractorOutbox 硬编码 + 为 Phase2 group 出边聚合预留 aggregateGroup）。
- `inboxPolicy { preserveDrafts:bool }`（替代 routeContractorInbox 保留 DRAFT 硬编码）。

落点（file:line）：
- schema 常量 + validate：`agent-binding-store-read.js`（OUTPUT_POLICY_ENUMS/OUTPUT_POLICY_STRINGS/
  INBOX_POLICY_BOOLEANS + `sanitizeOutputPolicy` / `sanitizeInboxPolicy` + sanitizeBindingPolicies 接入 +
  readTopLevelPolicies 顶层读取）。
- 序列化：`agent-binding-store-write.js:84-93`（buildStoredBindingDocument 与 executionPolicy 对称写入）。
- effective profile 投影：`effective-profile-composer.js`（policies 块新增 outputPolicy/inboxPolicy，纯配置无默认合并）。
- 运行时快照 + helper：`agent-identity.js`（registerRuntimeAgents 快照新增 2 字段 + `getOutputPolicy` /
  `getInboxPolicy` / `hasInboxPolicy`，与 getExecutionPolicy 对称）。
- 测试：`tests/binding-group-policy-phase0.test.js`（8 用例）。

## 3. 零删除零行为变更确认

- 未删任何代码、未改 contractor / executionPolicy / planner role 任何现有行为。
- 新字段无运行时消费者（Phase0 允许"空跑/无消费者"），但每个字段有 schema+validate+测试。
- validate 在边界丢弃非法值、空对象回 null（不落空对象，无 policy noise）；与既有 executionPolicy 共存互不干扰。
- 既有 binding/policy 测试全绿（agent-binding-store-runtime-interop / execution-policy-chain /
  intake-policy-regression / max-tool-calls-hard-stop / w2-agent-assembly-bugs = 22/22）。

## 4. 红线自查

- 纯增量建机制，contractor 老路径原样；不造新 transport（复用既有 binding store 的 read/write/compose 链路，
  无新路由/协议）；不开免授权通道（policy 只是配置投影，不参与授权判定）。
- 不碰 harness / automation 决策核心 / operator（P5）/ cli-system 执行 / 前端 / SKILL.md / 在途；只在
  agent-assembly 域。
- UTF-8 无 BOM；无 god-object（最大改动文件 agent-identity.js 419 行，+20 行未引入新 god-object）。
- 复用项目现有 schema 风格（EXEC_POLICY_* 常量表 + sanitize 模式），不造异构 schema。

## 5. 引用代码位置

- binding schema/validate：`extensions/watchdog/lib/agent/agent-binding-store-read.js`
- binding 序列化：`extensions/watchdog/lib/agent/agent-binding-store-write.js`
- effective profile 投影：`extensions/watchdog/lib/effective-profile-composer.js`
- 运行时 helper：`extensions/watchdog/lib/agent/agent-identity.js`（getOutputPolicy/getInboxPolicy/hasInboxPolicy）
- 测试：`extensions/watchdog/tests/binding-group-policy-phase0.test.js`
- 已存在（未动）：executionPolicy schema（read.js:13-15）、helper（agent-identity.js:341,348）、
  dispatchOrigin（agent-identity.js:291-292）
