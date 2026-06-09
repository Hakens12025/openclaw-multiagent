# Loop Runtime Truth And Phase Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按备忘录 74 和 75 的依赖顺序，把 OpenClaw 从“tool-call 估算 phase”推进到“runtime 持有真值、dashboard 只做统一阶段投影”的实现路径。

**Architecture:** 先做语义纠偏，立即切断 `toolCallTotal -> cursor/pct/estimatedPhase` 这条伪真值链；然后补齐 runtime 真值对象，依次正式化 `EvaluatorResult`、统一 `HarnessRun`、为 loop family 引入 `LoopPolicy / RoundSpec`；最后再把 dashboard/SSE/contract snapshot 接到统一阶段投影层。`LoopSpec` 继续只描述拓扑，runtime 继续持有 continue/rework/conclude 决策，harness 只提供 gate/evidence/evaluator input。

**Tech Stack:** Node.js, watchdog runtime, SSE/dashboard, contract snapshot persistence, existing watchdog test-runner suites.

---

### Task 1: P0 语义纠偏与伪真值切断

**Files:**
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/hooks/after-tool-call.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/session-bootstrap.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/sse.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/contracts.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/terminal-commit.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/state-persistence.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/dashboard.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-single.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-loop.js`

- [ ] 停止把 `AVG_CALLS_PER_STEP` 的计算结果继续写成 `phase/cursor/pct` 真值，至少先把它降级成 activity 字段或临时隐藏 phase strip。
- [ ] 保留 `toolCallTotal`、`lastLabel`、最近工具调用摘要，但明确这些字段只表达“忙碌度”和“最近动作”，不表达阶段完成度。
- [ ] 修掉 dashboard 把 `"1/3"` 形式 cursor 当数字比较的实现问题，避免前端继续制造伪阶段位置。
- [ ] 同步修正文案与持久化字段：`writeTaskState()`、恢复态、终态提交不再把估算 phase 写成真实阶段。
- [ ] 验证在没有真实阶段投影前，UI 降级为 activity 表达而不是继续显示假的 `%` 和阶段点位。

### Task 2: 正式化 EvaluatorResult

**Files:**
- Create: `/Users/hakens/.openclaw/extensions/watchdog/lib/evaluator-result.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/router-outbox-handlers.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/agent-end-pipeline.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/pipeline-engine.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/contracts.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-loop.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/contractor-loop-permission.test.js`

- [ ] 把 evaluator 当前 `next_action.json` / `code_verdict.json` 的弱协议收束成正式 `EvaluatorResult`，固定最小字段：`runId`、`round`、`score`、`verdict`、`continueHint`、`reworkTarget`、`bestArtifactRef`、`structuredFindings`、`constraintsForNextRound`。
- [ ] 在 `router-outbox-handlers.js` 中把 evaluator 输出统一规范化，而不是只落成 `transition` 和零散 `feedback`。
- [ ] 让 `agent-end-pipeline.js` 和 `pipeline-engine.js` 能读取 `EvaluatorResult` 作为 runtime 决策输入，但 continue/rework/conclude 仍由 runtime 决定，不让 evaluator 越权。
- [ ] 让 contract/runtime snapshot 能看到结构化 evaluator 结果，后续供 harness 和 dashboard 投影复用。
- [ ] 为 evaluator result normalization 和 runtime consumption path 加单测，避免后续又退回字符串 action。

### Task 3: 统一 HarnessRun 真值

**Files:**
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/harness-run.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/harness-run-store.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/agent-end-pipeline.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/automation-executor.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/automation-runtime.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/harness-dashboard.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/operator-snapshot.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-operator.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-agent-model.js`

- [ ] 以 `harness-run.js` 里的 rich object 为正式对象，升级 `harness-run-store.js` 成它的持久化层，不再保留单独的 weak run 叙事。
- [ ] 把 `agent-end-pipeline.js` 的 run 记录路径切到统一 `HarnessRun` 结构，补齐 `round/profileId/moduleRuns/gateSummary/toolUsage/artifact/score`。
- [ ] 让 operator、automation runtime、dashboard、loop runtime 都读同一套 `HarnessRun` 对象，避免 “automation 强对象 / operator 弱对象” 分叉。
- [ ] 明确 harness 的三段职责进入 run object：preflight、in-run、post-run，尤其是 evidence、failureClass、trace refs、score inputs。
- [ ] 扩充 operator/harness 相关测试，覆盖 active run、finalized run、recent runs、gate verdict 和 contract 绑定字段。

### Task 4: LoopPolicy 与 RoundSpec 绑定

**Files:**
- Create: `/Users/hakens/.openclaw/extensions/watchdog/lib/loop-policy.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/graph-loop-registry.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/pipeline-engine.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/loop-session-store.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/admin-surface-operations.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/automation-executor.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-loop.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/unified-control-plane-p0.test.js`

- [ ] 保持 `LoopSpec` 只描述 loop 拓扑，把 evaluator profile、harness profile、rubric、continue/conclude 规则放入新增 `LoopPolicy`。
- [ ] 定义 `RoundSpec` 的最小运行态：`round`、候选目标、输入 artifact refs、本轮约束、bound harness/evaluator profile、本轮 output contract。
- [ ] 在 pipeline/loop session 启动、推进、loop-back 时持久化 policy id 和 round-level runtime state，而不是只靠 `phaseOrder` 和 `continueSignal`。
- [ ] 把“下一轮输入来自上一轮 evaluator + harness + artifact”变成显式 runtime object，避免继续靠 prompt 约定。
- [ ] 增加 loop start/resume/loop-back 的测试，确保 policy 绑定后仍不破坏现有 graph-backed loop 语义。

### Task 5: 统一阶段投影协议

**Files:**
- Create: `/Users/hakens/.openclaw/extensions/watchdog/lib/stage-projection.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/contracts.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/sse.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/session-bootstrap.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/pipeline-engine.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/loop-session-store.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/harness-dashboard.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-single.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-loop-platform.js`

- [ ] 定义统一投影最小字段集合：`stagePlan`、`currentStage`、`completedStages`、`done/total/pct`、`round`、`gate`、`evidence`、`runtimeStatus`、`projectionSource`。
- [ ] 单次任务优先使用 `contract.phases + pipeline.currentStage + stageHistory + stage_result` 组合出真实阶段投影；loop 任务再叠加 `loopSession.round + phaseOrder + HarnessRun/EvaluatorResult`。
- [ ] 让 projection builder 成为唯一真值出口，contract snapshot 和 SSE 都发投影对象，不再直接把 tracker 估算字段抛给前端。
- [ ] 设计迁移期 fallback：拿不到真实阶段时只显示 activity / running status，不渲染假的阶段完成比。
- [ ] 保证 harness 只为投影提供 `gate/evidence`，不接管 phase 定义，也不直接决定 loop 继续与否。

### Task 6: Dashboard 接线与旧估算器退役

**Files:**
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/dashboard.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/routes/dashboard.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/hooks/after-tool-call.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/contracts.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/sse.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-single.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-loop.js`

- [ ] dashboard 主卡片改读统一阶段投影对象，区分 `stage truth`、`activity signal`、`gate/evidence`、`round`。
- [ ] loop 和单次任务共享一套阶段语言，只在可用时叠加 `R{n}` 和 gate verdict，不额外发明第二套 UI 协议。
- [ ] 把 `AVG_CALLS_PER_STEP` 从 `phase/cursor/pct` 真值链中完全移除；如果仍保留工具调用活跃度，字段名必须改成 activity 语义。
- [ ] 清理旧 payload 和旧前端分支，避免 projection 与 estimator 双轨并存。
- [ ] 做一次 dashboard 手工回归，确认单次任务、loop、hold/fail、resume 场景都不再出现伪 phase。

### Task 7: 测试、灰度与验证口径

**Files:**
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-single.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-loop.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-loop-platform.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-operator.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/tests/unified-control-plane-p0.test.js`

- [ ] 先独立落 Task 1，并确认“没有真实阶段时宁可降级，不再伪装 phase truth”已经成立。
- [ ] Task 2-4 完成后，再进入 Task 5-6，避免先改 UI 再返工 runtime object。
- [ ] 回归命令：
  - `node /Users/hakens/.openclaw/extensions/watchdog/test-runner.js --preset single`
  - `node /Users/hakens/.openclaw/extensions/watchdog/test-runner.js --preset loop-basic`
  - `node /Users/hakens/.openclaw/extensions/watchdog/test-runner.js --suite operator --filter harness`
  - `node /Users/hakens/.openclaw/extensions/watchdog/test-runner.js --suite loop --filter projection`
- [ ] 手工验证 SSE / dashboard：
  - 单次任务能显示真实当前阶段或安全降级
  - loop 任务能显示 `round + currentStage + gate/evidence`
  - hold / awaiting_input / failed 不再显示误导性百分比
- [ ] 最后做 T2 真实平台场景验证，不靠 prompt 硬教 choreography，确认 discriminative loop family 的 runtime 决策链真的成立。
