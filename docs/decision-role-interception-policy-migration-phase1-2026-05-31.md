# 决策：3 个 role 劫持点迁到 policy（P6-Phase1 收窄版）

> 阶段：P6-Phase1 | Primary Block：`agent-assembly`（policy helper 所在） | 日期：2026-05-31
> 跨 3 板块（agent-assembly + graph-dispatch-queue + local-execution）——单一内聚迁移任务，
> helper 集中在 agent-assembly（P0 建处），消费者分布在 routing + heartbeat。

## 0. 调研纠正：#2 是死字段，不是劫持点

逐个核到现在代码:
- **#1 reworkTarget 回退**（reviewer-verdict.js:45）：真劫持点 ✓。
- **#2 handler matchAgent**（handler-registry.js:23）：**死字段**。`matchAgent: isExecutorAgent` 全仓
  grep 确认**从未被调用**；handler 实际解析走 `routerHandlerId` / `outboxCommitKinds`（capability profile，
  registry.js:56-73）。它劫持不了任何东西。
- **#3 heartbeat actionable-work**（heartbeat-gate.js:41,50）：真劫持点 ✓。

**裁定（push back）**：#2 把死字段"迁"到 preset flag = 给死代码套壳 + 新增无消费者 flag（违反 CLAUDE.md
"不使用的代码就是 bug 的温床"，与 Phase0 拒建空骨架同一原则）。正确处理是**删死字段**（连同唯一引用它的
`isExecutorAgent` import），而非迁移。

## 1. 迁了什么（行为等价 + 可配置）

复用 P0 已建的 binding policy 机制（outputPolicy / inboxPolicy + helper），不造新概念。
新增的 policy 字段缺省时由 role 默认推导，**默认值严格等同迁移前的 role 判定**（现有 agent 行为一字不变）。

### #1 reworkTarget → outputPolicy.canReceiveRework
- schema：`OUTPUT_POLICY_BOOLEANS=["canReceiveRework"]`（agent-binding-store-read.js）。
- helper：`canAgentReceiveRework(agentId)`（agent-identity.js）——policy 设了用 policy，
  缺省回退 `isSpecializedExecutor(agentId) || isResearcherAgent(agentId)`（迁移前判定，等价）。
- 消费：`reviewer-verdict.js:45` `if (reworkTarget && !canAgentReceiveRework(reworkTarget)) reworkTarget=回退`。

### #2 matchAgent 死字段删除
- `handler-registry.js`：删 `matchAgent: isExecutorAgent` + 删未用 `isExecutorAgent` import。
- `agent-identity.js`：删孤儿 `isExecutorAgent` export（删 #2 唯一消费后全仓+测试零引用）。
  （`isSpecializedExecutor` / `isResearcherAgent` 保留——仍被 `canAgentReceiveRework` 内部使用。）

### #3 heartbeat actionable-work → inboxPolicy.requiresContract / dedupeConcurrentTracker
- schema：`INBOX_POLICY_BOOLEANS=["preserveDrafts","requiresContract","dedupeConcurrentTracker"]`。
- helper：
  - `agentRequiresContractForHeartbeat(agentId)`——缺省 `role===EXECUTOR||RESEARCHER`（等价）。
  - `agentDedupesConcurrentTrackerForHeartbeat(agentId)`——缺省 `role===EXECUTOR`（等价）。
- 消费：`heartbeat-gate.js` 两个 role 分支合并为 policy 驱动，**逐分支行为等价**：
  - dedupe 的 agent（旧 executor 分支）：去重并发 tracker → 检查 contract/artifactContext/inbox 文件。
  - 不 dedupe 的 contract-gated agent（旧 researcher 分支）：只检查 inbox/contract.json 文件。

## 2. 行为等价证明（默认值=旧 role 判定）

实测（registerRuntimeAgents 后）：
- canReceiveRework：specialized-executor=true、plain-executor=false、researcher=true、generic-agent=false（全等价）。
- requiresContract：executor=true、researcher=true、agent=false（全等价）。
- dedupeConcurrentTracker：executor=true、researcher=false（全等价）。
可配置：设 outputPolicy.canReceiveRework / inboxPolicy.requiresContract 能翻转判定（覆盖默认）。

## 3. 6 处合法 role 查表未动（确认）

`role===X` 属性查表是合法的（role 是 agent 合法属性），未动：soul 模板、intake、notify、bridge hook、
artifact-lane（heartbeat-gate.js:62 `listArtifactLaneBindingsForRole(identity.role)` 保留）、
其余 role-spec/system-action-role-policy 等。只迁了上述 3 个会"按 role 拦截/改写非预期角色流转"的劫持点。

## 4. 红线自查

- 行为等价硬要求达成：默认 policy = 旧 role 判定，现有 agent 行为不变，现有测试全绿。
- role===X 属性查表保留不动（只迁 3 处劫持点，#2 实为删死字段）。
- 复用 P0 binding policy 机制（outputPolicy/inboxPolicy + helper），不造新概念、不造新 transport、不开免授权通道。
- 不碰 harness / automation / operator（P5）/ 前端 / SKILL.md / 在途；只在 agent-assembly + 其 2 个消费板块。
- UTF-8 无 BOM；无 god-object（agent-identity.js 447 行，净 +24 helper -4 删 isExecutorAgent，registry 文件非新增 bloat）。
- 清理：删死字段 matchAgent + 孤儿 import/export（不留遗留代码）。

## 5. 引用代码位置

- policy schema：`extensions/watchdog/lib/agent/agent-binding-store-read.js`（OUTPUT_POLICY_BOOLEANS / INBOX_POLICY_BOOLEANS + sanitize）
- helper：`extensions/watchdog/lib/agent/agent-identity.js`（canAgentReceiveRework /
  agentRequiresContractForHeartbeat / agentDedupesConcurrentTrackerForHeartbeat）
- #1 消费：`extensions/watchdog/lib/routing/runtime-mailbox-outbox-reviewer-verdict.js:45`
- #2 删除：`extensions/watchdog/lib/routing/runtime-mailbox-handler-registry.js`
- #3 消费：`extensions/watchdog/lib/heartbeat-gate.js`
- 测试：`extensions/watchdog/tests/role-interception-policy-migration.test.js`（7 用例）
