# Unified Agent Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 graph-router、pool、tracker、crash-recovery 里重复的 busy/queue/retry/lease 逻辑收敛成一套统一协作控制面，让平台成为唯一调度者，agent 只负责执行和回报。

**Architecture:** 新增统一控制面模块，集中持有 per-agent 执行状态、per-agent FIFO 队列、dispatch confirm timer、running silence probe 和失败清理。`graph-router.js` 只负责“根据 graph 选下一跳”，不再自己持有 busy/queue；`assignee` 只表示“当前实际执行者”，排队目标和调度状态改存到持久化的 `contract.coordination`。本次实现只覆盖单目标 hop（default / round-robin / on-complete / on-fail），`fan-out` 明确阻断并返回显式错误，避免在单 contract 模型上继续假装支持并发复制。

**Tech Stack:** Node.js ESM, watchdog hooks/runtime events, shared `contracts/*.json`, existing SSE/dashboard, built-in `node:test`, existing `test-runner.js`.

---

## Scope and Non-Goals

- P0: 统一 execution control plane，修复 queued hop、busy 泄漏、dispatch failure 错误收口、前端首跳/排队不可见。
- P0: 保留现有 `pool_update` SSE 作为兼容快照来源，但数据真相改由新控制面生成。
- P0: `assignee` 只在 contract 真正进入 running/claimed 时更新；queued contract 不再提前改 `assignee`。
- P0: `before-agent-start` / `routeWorkerInbox` 必须支持按 `contractIdHint` 精确 staging 和 binding。
- P0: running silence 检测只基于 lease/heartbeat/probe，不基于 agent 输出文件内容。
- Out of scope: `fan-out` contract clone 设计；本轮直接拒绝 `execution_contract + gate=fan-out`。
- Out of scope: 大规模改写 dashboard 视觉风格；本轮只修 preload、queue badge、flow 可见性和语义。

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `extensions/watchdog/lib/agent-coordination.js` | **Create** | 统一定义 `contract.coordination` 结构、状态转移 helper、显式 fan-out guard |
| `extensions/watchdog/lib/agent-execution-control.js` | **Create** | 控制面主模块：per-agent state、queue、dispatch/release/drain、compat snapshot |
| `extensions/watchdog/lib/agent-execution-monitor.js` | **Create** | 唯一 timer owner：dispatch confirm、running lease、probe/retry budget、fail cleanup |
| `extensions/watchdog/lib/state-collections.js` | **Modify** | 新增 control-plane state map |
| `extensions/watchdog/lib/contracts.js` | **Modify** | 读写 `coordination` 辅助函数，避免 queued contract 误改 `assignee` |
| `extensions/watchdog/lib/router-inbox-handlers.js` | **Modify** | `routeWorkerInbox` 支持 `contractIdHint` / `contractPathHint` 精确 staging |
| `extensions/watchdog/lib/session-bootstrap.js` | **Modify** | worker binding 改成按精确 contract claim，而不是扫到第一个 assignee 命中的 active contract |
| `extensions/watchdog/hooks/before-agent-start.js` | **Modify** | 启动时向 control plane 报到：confirm dispatch、续租 running、只绑定当前被投递 contract |
| `extensions/watchdog/lib/graph-router.js` | **Modify** | 只做 graph hop 决策；dispatch / queue / release 全部委托给 control plane |
| `extensions/watchdog/lib/agent-end-pipeline.js` | **Modify** | 区分 routed / queued / dispatch_failed，所有 tracked path 都要 release，但不能把 dispatch_failed 误收口成 terminal |
| `extensions/watchdog/lib/runtime-lifecycle.js` | **Modify** | `finalizeAgentSession` 的 worker release 改委托 control plane，去掉第二套释放真相 |
| `extensions/watchdog/lib/crash-recovery.js` | **Modify** | 改成“构造失败结果 + 提示内容”的恢复辅助，不再自己持有独立 retry timer |
| `extensions/watchdog/lib/pool.js` | **Modify** | 退化为兼容壳：enqueue/snapshot 走 control plane，去掉自己的 dispatch/retry/busy timer |
| `extensions/watchdog/lib/ingress-standard-route.js` | **Modify** | ingress 只调用 control plane dispatch；删除手工重复 alert 逻辑 |
| `extensions/watchdog/index.js` | **Modify** | 启动时恢复 queued/dispatching/running contract 到 control plane |
| `extensions/watchdog/routes/api.js` | **Modify** | `/watchdog/state` 和相关快照改读 control plane |
| `extensions/watchdog/dashboard-init.js` | **Modify** | await `loadGraph()` + `loadAgentMeta()` 完成后再接 SSE |
| `extensions/watchdog/dashboard.js` | **Modify** | 合并新的 coordination/dispatch alerts，避免首跳丢失 |
| `extensions/watchdog/dashboard-pipeline.js` | **Modify** | queue badge 目标改读 `contract.coordination.targetAgent` |
| `extensions/watchdog/tests/agent-coordination.test.js` | **Create** | `coordination` 状态转移单测 |
| `extensions/watchdog/tests/agent-execution-control.test.js` | **Create** | queue / drain / requeue / release / compat snapshot 单测 |
| `extensions/watchdog/tests/dispatch-worker-inbox-control-plane.test.js` | **Create** | 精确 worker staging + claim 集成测试 |
| `extensions/watchdog/tests/agent-end-graph-route-control-plane.test.js` | **Create** | `dispatch_failed` 不误终态、release 全路径覆盖 |
| `extensions/watchdog/tests/dashboard-stage-visibility.test.js` | **Modify** | dashboard queue badge / graph preload / flow 去重测试 |

---

### Task 1: Freeze the New Semantics with Failing Tests

**Files:**
- Create: `extensions/watchdog/tests/agent-coordination.test.js`
- Create: `extensions/watchdog/tests/agent-execution-control.test.js`
- Create: `extensions/watchdog/tests/dispatch-worker-inbox-control-plane.test.js`
- Create: `extensions/watchdog/tests/agent-end-graph-route-control-plane.test.js`
- Modify: `extensions/watchdog/tests/dashboard-stage-visibility.test.js`

- [ ] **Step 1: Add failing coordination tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildQueuedCoordination,
  buildDispatchingCoordination,
  buildRunningCoordination,
  clearCoordination,
  guardUnsupportedFanOut,
} from "../lib/agent-coordination.js";

test("queued coordination does not claim assignee early", () => {
  const coordination = buildQueuedCoordination({
    contractId: "TC-1",
    fromAgent: "planner",
    targetAgent: "worker-b",
    now: 1,
  });
  assert.equal(coordination.targetAgent, "worker-b");
  assert.equal(coordination.queueState, "queued");
  assert.equal(coordination.claimedBySession, null);
});

test("fan-out execution contract is explicitly rejected", () => {
  assert.throws(
    () => guardUnsupportedFanOut({ envelope: "execution_contract", gate: "fan-out" }),
    /fan-out requires contract cloning/i,
  );
});
```

- [ ] **Step 2: Add failing control-plane tests**

```javascript
test("enqueueForBusyAgent records queued target without mutating assignee", async () => {
  // Arrange: agent busy on TC-RUNNING, queue TC-QUEUED to same target
  // Assert: queued contract persists coordination.targetAgent=worker-b, queueState=queued,
  //         assignee remains previous actual owner or null
});

test("releaseAgent requeues drained contract when wake/dispatch fails", async () => {
  // Arrange: queued contract exists, dispatch callback throws
  // Assert: agent returns to idle, queued entry remains first in queue, no silent drop
});

test("compat snapshot emits pool_update-compatible queue + busy state from control plane", async () => {
  // Assert payload shape stays compatible with dashboard/routes/api consumers
});
```

- [ ] **Step 3: Add failing worker staging test**

```javascript
test("routeWorkerInbox stages exact hinted contract before session bootstrap claim", async () => {
  // Arrange: two active contracts both target worker-a
  // Act: routeInbox("worker-a", logger, { contractIdHint: wantedId, contractPathHint })
  // Assert: inbox/contract.json contains wantedId, not first lexical match
});
```

- [ ] **Step 4: Add failing agent-end test**

```javascript
test("graph_route dispatch_failed does not commit intermediate contract to terminal state", async () => {
  // Arrange: graph_route returns { routed: false, action: "dispatch_failed" }
  // Assert: commit_success_terminal is skipped, contract remains pending/running for retry/failure handler
});

test("graph_route releases tracked agent on failed/crashed event", async () => {
  // Arrange: event.success = false with tracked contract
  // Assert: release callback invoked before crash handling ends
});
```

- [ ] **Step 5: Extend dashboard test coverage**

```javascript
test("queue badge targets coordination.targetAgent instead of assignee", () => {
  // Arrange contract.coordination = { targetAgent: "worker-b", queueState: "queued" }
  // Assert dashboard-pipeline renders queue badge for worker-b even when assignee is null
});

test("track_start does not fall back to replyTo when graph edges are preloaded", () => {
  // Arrange window.__graphEdges preloaded before first event
  // Assert addActiveFlow uses graph incoming edge, not replyTo fallback
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/agent-coordination.test.js tests/agent-execution-control.test.js tests/dispatch-worker-inbox-control-plane.test.js tests/agent-end-graph-route-control-plane.test.js tests/dashboard-stage-visibility.test.js
```

Expected:
- FAIL because the new modules/exports do not exist yet
- FAIL because `routeWorkerInbox` still ignores `contractIdHint`
- FAIL because `graph_route` still commits/skips incorrectly

- [ ] **Step 7: Commit the red test baseline**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/tests/agent-coordination.test.js extensions/watchdog/tests/agent-execution-control.test.js extensions/watchdog/tests/dispatch-worker-inbox-control-plane.test.js extensions/watchdog/tests/agent-end-graph-route-control-plane.test.js extensions/watchdog/tests/dashboard-stage-visibility.test.js
git commit -m "test(control-plane): freeze unified dispatch semantics"
```

---

### Task 2: Introduce Durable Coordination Metadata

**Files:**
- Create: `extensions/watchdog/lib/agent-coordination.js`
- Modify: `extensions/watchdog/lib/contracts.js`

- [ ] **Step 1: Implement the coordination schema helper**

```javascript
// lib/agent-coordination.js
export const COORDINATION_QUEUE_STATE = Object.freeze({
  QUEUED: "queued",
  DISPATCHING: "dispatching",
  RUNNING: "running",
  PROBING: "probing",
  FAILED: "failed",
});

export function buildQueuedCoordination({ contractId, fromAgent, targetAgent, now = Date.now() }) {
  return {
    contractId,
    fromAgent,
    targetAgent,
    queueState: COORDINATION_QUEUE_STATE.QUEUED,
    enqueuedAt: now,
    dispatchedAt: null,
    claimedAt: null,
    claimedBySession: null,
    retryCount: 0,
    probeCount: 0,
    lastProbeAt: null,
  };
}
```

- [ ] **Step 2: Add contract mutation helpers**

```javascript
// lib/contracts.js
export async function setContractCoordination(contractPath, logger, coordination) {
  return mutateContractSnapshot(contractPath, logger, (contract) => {
    contract.coordination = coordination || null;
  }, { touchUpdatedAt: true });
}

export async function clearContractCoordination(contractPath, logger) {
  return setContractCoordination(contractPath, logger, null);
}
```

- [ ] **Step 3: Enforce the new assignee rule**

```javascript
// queued contracts must not use assignee as future target
// assignee is only written when the control plane transitions to DISPATCHING/RUNNING
```

- [ ] **Step 4: Run the narrow tests**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/agent-coordination.test.js
```

Expected:
- PASS for pure coordination helpers

- [ ] **Step 5: Commit**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/lib/agent-coordination.js extensions/watchdog/lib/contracts.js
git commit -m "feat(control-plane): add durable coordination metadata helpers"
```

---

### Task 3: Build the Unified Execution Control Plane

**Files:**
- Create: `extensions/watchdog/lib/agent-execution-control.js`
- Create: `extensions/watchdog/lib/agent-execution-monitor.js`
- Modify: `extensions/watchdog/lib/state-collections.js`
- Modify: `extensions/watchdog/lib/pool.js`
- Modify: `extensions/watchdog/routes/api.js`

- [ ] **Step 1: Add the in-memory execution state map**

```javascript
// lib/state-collections.js
export const agentExecutionState = new Map(); // agentId -> { status, contractId, sessionKey, queue: [] }
```

- [ ] **Step 2: Implement control-plane state transitions**

```javascript
// lib/agent-execution-control.js
export const AGENT_EXECUTION_STATUS = Object.freeze({
  IDLE: "idle",
  DISPATCHING: "dispatching",
  RUNNING: "running",
  PROBING: "probing",
});

export async function enqueueContractForAgent({ contractId, fromAgent, targetAgent, logger }) {}
export async function dispatchContractToAgent({ contractId, fromAgent, targetAgent, api, logger }) {}
export async function confirmAgentClaim({ agentId, contractId, sessionKey, logger }) {}
export async function markAgentRunning({ agentId, contractId, sessionKey, logger }) {}
export async function releaseAgentExecution({ agentId, reason, api, logger }) {}
export function buildCompatPoolSnapshot() {}
```

Implementation rules:
- busy/dispatching/running truth lives here only
- queue is FIFO per agent
- drain must `peek` first, only `shift` after dispatch succeeds
- dispatch failure must leave queue entry intact or reinsert at head
- `pool.js` compatibility methods delegate here; no parallel timer ownership remains in `pool.js`

- [ ] **Step 3: Implement the single timer owner**

```javascript
// lib/agent-execution-monitor.js
export async function scheduleDispatchConfirm({ agentId, contractId, sessionKey, api, logger }) {}
export async function refreshRunningLease({ agentId, contractId, sessionKey, logger }) {}
export async function probeSilentAgent({ agentId, contractId, api, logger }) {}
export async function markExecutionFailed({ agentId, contractId, reason, logger }) {}
export function cancelExecutionTimers(agentId) {}
```

Monitor rules:
- dispatch confirm timer waits for actual claim/start signal
- running lease refreshes on tracking start/progress/heartbeat
- silence expiration triggers `requestHeartbeatNow`
- probe exhaustion marks contract failed/abandoned, clears agent state, drains next queued contract
- this module is the only owner of retry/probe timers for agent execution

- [ ] **Step 4: Replace pool internals with compatibility wrappers**

```javascript
// lib/pool.js
// keep enqueue(), broadcastPoolStatus(), get snapshot helpers
// remove independent dispatch retry / busy mutation / setTimeout drain logic
// delegate worker state + queue ownership to agent-execution-control.js
```

- [ ] **Step 5: Expose control-plane snapshot through existing API**

```javascript
// routes/api.js
// keep existing response shape where possible:
// { taskQueue, workerPool, dispatchMode, ... }
// but source queue/busy data from buildCompatPoolSnapshot()
```

- [ ] **Step 6: Run tests**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/agent-execution-control.test.js
```

Expected:
- PASS for queue/drain/requeue/compat snapshot behavior

- [ ] **Step 7: Commit**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/lib/agent-execution-control.js extensions/watchdog/lib/agent-execution-monitor.js extensions/watchdog/lib/state-collections.js extensions/watchdog/lib/pool.js extensions/watchdog/routes/api.js
git commit -m "feat(control-plane): add unified execution state and monitor"
```

---

### Task 4: Make Worker Dispatch and Claim Exact

**Files:**
- Modify: `extensions/watchdog/lib/router-inbox-handlers.js`
- Modify: `extensions/watchdog/lib/session-bootstrap.js`
- Modify: `extensions/watchdog/hooks/before-agent-start.js`
- Modify: `extensions/watchdog/lib/dispatch.js`
- Modify: `extensions/watchdog/lib/conveyor.js`

- [ ] **Step 1: Teach worker inbox routing to honor hints**

```javascript
export async function routeWorkerInbox({
  agentId,
  inboxDir,
  logger,
  sessionKey = null,
  contractIdHint = null,
  contractPathHint = null,
}) {
  // if hint present, read exact contract and stage it before fallback scan
}
```

- [ ] **Step 2: Replace “scan first assignee match” claim with explicit claim**

```javascript
// lib/session-bootstrap.js
export async function bindPendingWorkerContract({
  agentId,
  sessionKey,
  trackingState,
  logger,
  expectedContractId = null,
}) {
  // first try exact coordination/expected contract
  // only fallback scan when no explicit dispatch is active
}
```

- [ ] **Step 3: Confirm claim/start from before-agent-start**

```javascript
// hooks/before-agent-start.js
// after binding/tracking starts:
await confirmAgentClaim({ agentId, contractId: trackingState.contract.id, sessionKey, logger });
await markAgentRunning({ agentId, contractId: trackingState.contract.id, sessionKey, logger });
```

Rules:
- do not widen `allowNonDirectRequest` as a workaround
- keep unconditional `routeInbox(agentId, logger)` for new worker session staging
- when session is waking for a queued/dispatched contract, the hinted contract must win over lexical scan order

- [ ] **Step 4: Keep dispatch helpers compatible**

```javascript
// lib/dispatch.js / lib/conveyor.js
// continue to support shared dispatch callers, but pass contractIdHint + contractPathHint through
// wake functions should use wakeAgentDetailed() and preserve { ok, mode, error }
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/dispatch-worker-inbox-control-plane.test.js tests/conveyor.test.js
```

Expected:
- PASS for exact hinted worker inbox staging
- PASS for existing conveyor regressions

- [ ] **Step 6: Commit**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/lib/router-inbox-handlers.js extensions/watchdog/lib/session-bootstrap.js extensions/watchdog/hooks/before-agent-start.js extensions/watchdog/lib/dispatch.js extensions/watchdog/lib/conveyor.js
git commit -m "fix(dispatch): bind and stage exact worker contract"
```

---

### Task 5: Move Graph Routing onto the Unified Control Plane

**Files:**
- Modify: `extensions/watchdog/lib/graph-router.js`
- Modify: `extensions/watchdog/lib/ingress-standard-route.js`
- Modify: `extensions/watchdog/lib/agent-end-pipeline.js`
- Modify: `extensions/watchdog/lib/runtime-lifecycle.js`

- [ ] **Step 1: Strip busy/queue ownership out of graph-router**

```javascript
// lib/graph-router.js
// keep:
//   loadGraph()
//   getEdgesFrom()
//   choose next edge
// remove:
//   busyAgents
//   agentQueues
//   markBusy/markIdle/dequeue logic
// delegate:
//   dispatchContract()
//   routeAfterAgentEnd()
//   releaseAgent() -> agent-execution-control.js
```

- [ ] **Step 2: Make dispatch results explicit**

```javascript
return { routed: true, action: "dispatched", target }
return { routed: true, action: "queued", target }
return { routed: false, action: "dispatch_failed", target, error }
return { routed: false, action: "terminal" }
```

Rules:
- `dispatch_failed` is not terminal success and must not fall through to normal semantic completion
- `fan-out` on `execution_contract` returns explicit `dispatch_failed` with a clear error message

- [ ] **Step 3: Fix ingress alert ownership**

```javascript
// ingress-standard-route.js
// do not broadcast manual inbox_dispatch after calling graph/control-plane dispatch
// the real dispatcher owns the alert
```

- [ ] **Step 4: Fix graph_route stage behavior**

```javascript
// lib/agent-end-pipeline.js
match(context) {
  return Boolean(context.trackingState?.contract?.id);
}

async run(context) {
  await releaseAgentExecution({ agentId: context.agentId, reason: "agent_end", api: context.api, logger: context.logger });
  if (context.event.success !== true) return;
  // only set context.graphRouted = true when action is "dispatched" or "queued"
  // never set graphRouted on "dispatch_failed"
}
```

- [ ] **Step 5: Remove double release from finalizeAgentSession**

```javascript
// runtime-lifecycle.js
// worker release should be owned by control plane path above, not duplicated here
```

- [ ] **Step 6: Run tests**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/agent-end-graph-route-control-plane.test.js tests/contractor-handoff-terminal.test.js
```

Expected:
- PASS for dispatch_failed not becoming terminal commit
- PASS for tracked agent release on success/failure/crash paths

- [ ] **Step 7: Commit**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/lib/graph-router.js extensions/watchdog/lib/ingress-standard-route.js extensions/watchdog/lib/agent-end-pipeline.js extensions/watchdog/lib/runtime-lifecycle.js
git commit -m "refactor(graph-router): delegate dispatch and release to control plane"
```

---

### Task 6: Unify Failure Detection, Retry, and Recovery

**Files:**
- Modify: `extensions/watchdog/lib/agent-execution-monitor.js`
- Modify: `extensions/watchdog/lib/crash-recovery.js`
- Modify: `extensions/watchdog/index.js`

- [ ] **Step 1: Convert crash-recovery into a recovery helper, not a timer owner**

```javascript
// lib/crash-recovery.js
// keep:
//   retry hint generation
//   contract failure classification
// remove:
//   standalone setTimeout wake scheduling
// new contract:
//   return { retryable, retryCount, hint, reason } to the monitor
```

- [ ] **Step 2: Add startup reconstruction**

```javascript
// index.js
await recoverExecutionControlPlane({
  api,
  logger,
});
```

Recovery rules:
- `coordination.queueState === queued` -> rebuild per-agent FIFO
- `coordination.queueState === dispatching` with no live tracker -> re-probe once, then requeue/fail via monitor
- `coordination.queueState === running` with no active tracking session -> move to probing

- [ ] **Step 3: Implement silence probes**

```javascript
// agent-execution-monitor.js
// on lease expiry:
//   1. mark status = probing
//   2. requestHeartbeatNow(agentId, sessionKey)
//   3. if claim/progress/end signal arrives -> return to running
//   4. if retries exhausted -> mark contract failed, clear coordination, release agent, drain next queued
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/agent-execution-control.test.js tests/agent-end-graph-route-control-plane.test.js
```

Expected:
- PASS for requeue after failed drain
- PASS for probe exhaustion releasing agent and preserving queue progress

- [ ] **Step 5: Commit**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/lib/agent-execution-monitor.js extensions/watchdog/lib/crash-recovery.js extensions/watchdog/index.js
git commit -m "feat(control-plane): unify execution probes and startup recovery"
```

---

### Task 7: Fix Frontend Collaboration Visibility

**Files:**
- Modify: `extensions/watchdog/dashboard-init.js`
- Modify: `extensions/watchdog/dashboard.js`
- Modify: `extensions/watchdog/dashboard-pipeline.js`
- Modify: `extensions/watchdog/dashboard-stage-visibility.test.js`

- [ ] **Step 1: Make graph + agent metadata ready before SSE**

```javascript
// dashboard-init.js
await loadGraph();
await loadAgentMeta();
connectSSE();
loadContracts();
```

If top-level init cannot become async, wrap the chain in an async IIFE and keep the fatal error path.

- [ ] **Step 2: Merge coordination-aware alerts into dashboard state**

```javascript
// dashboard.js
if (data.type === "dispatch_state" && data.contractId) {
  mergeContractState(data.contractId, {
    assignee: data.assignee,
    coordination: data.coordination,
    updatedAt: data.ts,
  });
}

if (data.type === "graph_hop") {
  addActiveFlow(data.from, data.to, truncLabel(data.contractId), { contractId: data.contractId, type: "dispatch" });
}
```

Rules:
- do not introduce a brand-new SSE channel for `graph_hop`; keep it under `alert`
- do not use `agent-${id}` selectors; use existing `eid(agentId).qg` path indirectly through `updatePipeline()`
- avoid duplicate flow lines: if `graph_hop` already created one active edge, `track_start` must not create a second identical edge

- [ ] **Step 3: Make queue badges read the real queued target**

```javascript
// dashboard-pipeline.js
const targetAgent = contract?.coordination?.targetAgent || contract?.assignee || null;
const isQueued = contract?.coordination?.queueState === "queued";
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/dashboard-stage-visibility.test.js
```

Expected:
- PASS for graph preload order
- PASS for coordination-targeted queue badges
- PASS for no duplicate first-hop flow

- [ ] **Step 5: Commit**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/dashboard-init.js extensions/watchdog/dashboard.js extensions/watchdog/dashboard-pipeline.js extensions/watchdog/tests/dashboard-stage-visibility.test.js
git commit -m "fix(dashboard): preload graph and render control-plane queue state"
```

---

### Task 8: Remove Dead Paths and Run Full Verification

**Files:**
- Modify: `extensions/watchdog/lib/agent-end-pipeline.js`
- Modify: `extensions/watchdog/lib/ingress-standard-route.js`
- Modify: `extensions/watchdog/lib/pool.js`
- Modify: `extensions/watchdog/lib/plan-dispatch-service.js` (only if imports or compatibility hooks are now dead)

- [ ] **Step 1: Remove dead code guarded out by the new flow**

Checklist:
- delete `planner_follow_up` stage from `agent-end-pipeline.js`
- delete unused imports `wakePlanAgentWithRetry`, `hasExecutionPolicy` where no longer referenced
- delete `rememberDraftContract` import from `ingress-standard-route.js`
- delete any graph-router-local queue helpers now superseded by control plane

- [ ] **Step 2: Run focused unit/integration suites**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/agent-coordination.test.js tests/agent-execution-control.test.js tests/dispatch-worker-inbox-control-plane.test.js tests/agent-end-graph-route-control-plane.test.js tests/conveyor.test.js tests/contractor-handoff-terminal.test.js tests/dashboard-stage-visibility.test.js
```

Expected:
- all PASS

- [ ] **Step 3: Run scenario presets**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node test-runner.js --preset single
node test-runner.js --preset multi
node test-runner.js --preset concurrent
```

Expected:
- `single` PASS
- `multi` 3/3 PASS
- `concurrent` 3/3 PASS

- [ ] **Step 4: Manual verification**

Check:
- gateway log shows one release path per tracked agent end
- wake failure / probe exhaustion clears agent state and drains next queued contract
- queued contracts keep `coordination.targetAgent` while waiting and only gain `assignee` on actual start
- dashboard first hop follows graph edge
- dashboard queue badge follows queued target, not stale assignee

- [ ] **Step 5: Commit cleanup + verification**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/lib/agent-end-pipeline.js extensions/watchdog/lib/ingress-standard-route.js extensions/watchdog/lib/pool.js extensions/watchdog/lib/plan-dispatch-service.js
git commit -m "refactor(control-plane): remove dead dispatch paths and verify unified flow"
```

---

## Acceptance Criteria

- 平台只有一套 agent busy/dispatching/running/probing 真相源。
- 平台只有一套 per-agent FIFO queue 真相源。
- queued contract 不再通过提前改 `assignee` 来表达目标 agent。
- worker 启动时能按 `contractIdHint` 精确绑定当前被派发 contract。
- `dispatch_failed` 不再误触发 terminal lifecycle commit。
- crash/silence probe 失败后，contract 正确失败/回收，agent 状态被清理，后续队列继续推进。
- dashboard 首跳和排队状态都能稳定显示，不依赖错误的 DOM selector 或 `replyTo` fallback。

## Implementation Notes for Claude

- 不要一开始就大拆 dashboard；先把后端控制面真相统一，再做前端兼容层。
- 不要继续给 `graph-router.js` 添加新的 busy/queue/retry 逻辑；所有这类状态必须进入新 control plane 模块。
- 不要用“放宽 allowNonDirectRequest”掩盖 worker shared-contract 绑定问题；根因是精确 dispatch/claim 缺失。
- 不要在 queued 状态下继续复用 `assignee` 表示未来目标；这正是当前 stale claim/扫描错绑的来源。
- 任何需要 timer 的 execution behavior，都必须放进 `agent-execution-monitor.js`，不要在 `pool.js` / `graph-router.js` / `crash-recovery.js` 里各自再开一套 `setTimeout`.
