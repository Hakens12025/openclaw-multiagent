# Pool Runtime State Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `pool.js` 从“半截调度器”收口成 worker runtime state 的兼容层，删掉死掉的 dispatch/retry/wake 逻辑，同时保持当前 worker 生命周期、QQ typing、`pool_update` SSE 和 dashboard/API 兼容不破。

**Architecture:** 新增一个小范围的 `worker-runtime-state` 模块，成为 `workerPool/taskQueue`、持久化、`pool_update` 快照、worker claim/release 副作用的唯一拥有者。`graph-router` 继续负责图路由与排队决策，但不再直接双写 `workerPool`；`pool.js` 只保留兼容导出，不再拥有 dispatch/retry/timer。这个计划是备忘录 90/91 统一控制面的收口前置，不试图一次把非 worker agent 的 queue/busy 也并入统一控制面。

**Tech Stack:** Node.js ESM, watchdog runtime hooks/routes, SSE dashboard, QQ notification helpers, built-in `node:test`.

---

## Scope and Non-Goals

- P0: 删除 `pool.js` 内部无外部调用者的 dispatch/retry/timer 逻辑。
- P0: 保持 `pool_update` 事件 payload 兼容，暂时不改 `dashboard.js` 消费方式。
- P0: 保持 `session-bootstrap -> worker claim` 与 `runtime-lifecycle/crash-recovery -> worker release` 的可见行为一致。
- P0: 去掉 `graph-router.js` 对 `workerPool` 的直接双写，改走统一 helper。
- Non-goal: 本轮不实现 memo 91 里完整 `agent-execution-control.js`。
- Non-goal: 本轮不实现 `agentGroup` 调度抽象。
- Non-goal: 本轮不改 `graph-router` 对非 worker agent 的本地 `busyAgents/agentQueues`。
- Non-goal: 本轮不把 dashboard 改成直接读取 graph-router 内存状态。

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `extensions/watchdog/lib/routing/worker-runtime-state.js` | **Create** | worker 状态唯一真相：target sync、queue/pool 持久化、snapshot、worker claim/release、副作用 |
| `extensions/watchdog/lib/routing/pool.js` | **Modify** | 退化为兼容壳，仅 re-export 状态 helper；彻底删除 dispatch/retry/timer |
| `extensions/watchdog/lib/routing/graph-router.js` | **Modify** | 通过 state helper 查询/写入 worker dispatching/busy，不再直接摸 `workerPool` |
| `extensions/watchdog/lib/session-bootstrap.js` | **Modify** | `bindPendingWorkerContract()` 改走 `claimWorkerContract()` |
| `extensions/watchdog/lib/lifecycle/runtime-lifecycle.js` | **Modify** | session finalize 改走 `releaseWorkerContract()` |
| `extensions/watchdog/lib/lifecycle/crash-recovery.js` | **Modify** | crash release 改走 `releaseWorkerContract()` |
| `extensions/watchdog/index.js` | **Modify** | gateway_start 的 init/load/persist/getWorkerIds 改从新模块获取 |
| `extensions/watchdog/routes/api.js` | **Modify** | `/watchdog/state` 改读统一 snapshot helper，而不是散读 `taskQueue/workerPool` |
| `extensions/watchdog/lib/operator/operator-snapshot-runtime.js` | **Modify** | operator runtime snapshot 改走统一 snapshot helper |
| `extensions/watchdog/tests/worker-runtime-state.test.js` | **Create** | 新模块单测：sync、claim、release、snapshot |
| `extensions/watchdog/tests/graph-router.test.js` | **Modify** | worker dispatch/queue drain 继续成立，但改经由 state helper |
| `extensions/watchdog/tests/pool.test.js` | **Modify** | pool 兼容壳测试：保留的 API 仍可用，死 dispatch API 消失 |

---

### Task 1: Freeze Worker Runtime Semantics with Failing Tests

**Files:**
- Create: `extensions/watchdog/tests/worker-runtime-state.test.js`
- Modify: `extensions/watchdog/tests/graph-router.test.js`
- Modify: `extensions/watchdog/tests/pool.test.js`

- [ ] **Step 1: Add failing tests for the new worker state owner**

```javascript
import test from "node:test";
import assert from "node:assert/strict";

import { taskQueue, workerPool } from "../lib/state.js";
import {
  syncWorkerTargets,
  claimWorkerContract,
  releaseWorkerContract,
  buildPoolSnapshot,
} from "../lib/routing/worker-runtime-state.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("syncWorkerTargets adds new graph targets and prunes stale idle ones", async () => {
  workerPool.clear();
  workerPool.set("stale-idle", {
    busy: false,
    healthy: true,
    dispatching: false,
    lastSeen: 1,
    currentContract: null,
  });

  await syncWorkerTargets(["worker-a", "worker-b"], logger);

  assert.equal(workerPool.has("worker-a"), true);
  assert.equal(workerPool.has("worker-b"), true);
  assert.equal(workerPool.has("stale-idle"), false);
});

test("claimWorkerContract marks worker busy and removes queued contract", async () => {
  workerPool.clear();
  taskQueue.length = 0;
  workerPool.set("worker-a", {
    busy: false,
    healthy: true,
    dispatching: true,
    lastSeen: 1,
    currentContract: null,
  });
  taskQueue.push("TC-1");

  await claimWorkerContract({
    contractId: "TC-1",
    workerId: "worker-a",
    logger,
  });

  const state = workerPool.get("worker-a");
  assert.equal(state.busy, true);
  assert.equal(state.dispatching, false);
  assert.equal(state.currentContract, "TC-1");
  assert.equal(taskQueue.includes("TC-1"), false);
});

test("releaseWorkerContract clears worker state but keeps pool_update payload compatible", async () => {
  workerPool.clear();
  workerPool.set("worker-a", {
    busy: true,
    healthy: true,
    dispatching: false,
    lastSeen: 1,
    currentContract: "TC-1",
  });

  await releaseWorkerContract({ workerId: "worker-a", logger });
  const snapshot = buildPoolSnapshot();

  assert.deepEqual(Object.keys(snapshot), ["pool", "queue", "ts"]);
  assert.equal(snapshot.pool["worker-a"].busy, false);
  assert.equal(snapshot.pool["worker-a"].currentContract, null);
});
```

- [ ] **Step 2: Extend graph-router coverage around worker dispatch state**

```javascript
test("dispatchContract marks worker target dispatching via runtime-state helper", async () => {
  workerPool.clear();
  workerPool.set("worker-b", {
    busy: false,
    healthy: true,
    dispatching: false,
    lastSeen: 1,
    currentContract: null,
  });

  const result = await dispatchContract("C-STATE", "planner", "worker-b", api, logger);

  assert.equal(result.dispatched, true);
  assert.equal(workerPool.get("worker-b").dispatching, true);
  assert.equal(workerPool.get("worker-b").currentContract, "C-STATE");
});
```

- [ ] **Step 3: Freeze the compatibility contract for `pool.js`**

```javascript
test("pool.js keeps enqueue/dequeue/release compatibility exports after refactor", async () => {
  assert.equal(typeof enqueue, "function");
  assert.equal(typeof dequeue, "function");
  assert.equal(typeof releaseWorker, "function");
});
```

- [ ] **Step 4: Run tests to verify they fail before implementation**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/worker-runtime-state.test.js tests/graph-router.test.js tests/pool.test.js
```

Expected:
- `ERR_MODULE_NOT_FOUND` for `worker-runtime-state.js`
- or missing export failures for the new helper API

- [ ] **Step 5: Commit the red baseline**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/tests/worker-runtime-state.test.js extensions/watchdog/tests/graph-router.test.js extensions/watchdog/tests/pool.test.js
git commit -m "test(pool): freeze worker runtime state extraction semantics"
```

---

### Task 2: Introduce `worker-runtime-state.js` and Shrink `pool.js` to a Compatibility Shell

**Files:**
- Create: `extensions/watchdog/lib/routing/worker-runtime-state.js`
- Modify: `extensions/watchdog/lib/routing/pool.js`

- [ ] **Step 1: Implement the worker runtime state owner**

```javascript
// lib/routing/worker-runtime-state.js
import { readFile } from "node:fs/promises";

import {
  workerPool,
  taskQueue,
  atomicWriteFile,
  QUEUE_STATE_FILE,
} from "../state.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { qqNotify, qqTypingStart, qqTypingStop, getQQTarget } from "../qq.js";
import { readCachedContractSnapshotById } from "../store/contract-store.js";
import { getContractPath } from "../contracts.js";

function createWorkerState() {
  return {
    busy: false,
    healthy: true,
    dispatching: false,
    lastSeen: Date.now(),
    currentContract: null,
  };
}

export async function syncWorkerTargets(targetIds, logger) {
  const targetSet = new Set(targetIds);

  for (const agentId of targetIds) {
    if (!workerPool.has(agentId)) workerPool.set(agentId, createWorkerState());
  }

  for (const [agentId, state] of [...workerPool.entries()]) {
    if (!targetSet.has(agentId) && !state.busy && !state.dispatching) {
      workerPool.delete(agentId);
      logger?.info?.(`[worker-runtime-state] pruned idle target ${agentId}`);
    }
  }
}

export function buildPoolSnapshot() {
  const pool = {};
  for (const [id, state] of workerPool.entries()) {
    pool[id] = {
      busy: state.busy,
      healthy: state.healthy,
      dispatching: state.dispatching,
      currentContract: state.currentContract,
      lastSeen: state.lastSeen || null,
    };
  }
  return {
    pool,
    queue: [...taskQueue],
    ts: Date.now(),
  };
}

export function emitPoolSnapshot() {
  broadcast("alert", { type: EVENT_TYPE.POOL_UPDATE, ...buildPoolSnapshot() });
}

export function listWorkerIds() {
  return [...workerPool.keys()];
}

export function isWorkerBusy(workerId) {
  const state = workerPool.get(workerId);
  return Boolean(state?.busy || state?.dispatching);
}

export function markWorkerDispatching(workerId, contractId) {
  const state = workerPool.get(workerId);
  if (!state) return false;
  state.dispatching = true;
  state.currentContract = contractId;
  state.lastSeen = Date.now();
  emitPoolSnapshot();
  return true;
}

export function rollbackWorkerDispatch(workerId) {
  const state = workerPool.get(workerId);
  if (!state) return false;
  state.dispatching = false;
  state.currentContract = null;
  state.lastSeen = Date.now();
  emitPoolSnapshot();
  return true;
}

export async function claimWorkerContract({ contractId, workerId, logger }) {
  const idx = taskQueue.indexOf(contractId);
  if (idx >= 0) taskQueue.splice(idx, 1);

  const state = workerPool.get(workerId);
  if (state) {
    state.busy = true;
    state.dispatching = false;
    state.currentContract = contractId;
    state.lastSeen = Date.now();
  }

  try {
    const contract = await readCachedContractSnapshotById(contractId, {
      contractPathHint: getContractPath(contractId),
    });
    const qqTarget = getQQTarget(contract);
    if (qqTarget) {
      qqNotify(qqTarget, `🔧 ${workerId} 开始处理你的任务`);
      qqTypingStart(contractId, qqTarget);
    }
  } catch (error) {
    logger?.warn?.(`[worker-runtime-state] claim side effects failed: ${error.message}`);
  }

  emitPoolSnapshot();
  await persistWorkerQueueState(logger);
}

export async function releaseWorkerContract({ workerId, logger }) {
  const state = workerPool.get(workerId);
  if (state?.currentContract) qqTypingStop(state.currentContract);
  if (state) {
    state.busy = false;
    state.dispatching = false;
    state.currentContract = null;
    state.lastSeen = Date.now();
  }
  emitPoolSnapshot();
  await persistWorkerQueueState(logger);
}

export async function persistWorkerQueueState(logger) {
  try {
    const savedPool = {};
    for (const [id, state] of workerPool.entries()) {
      savedPool[id] = {
        busy: state.busy,
        currentContract: state.currentContract,
      };
    }
    await atomicWriteFile(QUEUE_STATE_FILE, JSON.stringify({
      queue: taskQueue,
      pool: savedPool,
      savedAt: Date.now(),
    }, null, 2));
  } catch (error) {
    logger?.warn?.(`[worker-runtime-state] persist failed: ${error.message}`);
  }
}

export async function loadWorkerQueueState(logger) {
  try {
    const raw = await readFile(QUEUE_STATE_FILE, "utf8");
    const state = JSON.parse(raw);
    taskQueue.length = 0;
    taskQueue.push(...(Array.isArray(state.queue) ? state.queue : []));
  } catch (error) {
    logger?.info?.(`[worker-runtime-state] no saved queue to load`);
  }

  for (const workerState of workerPool.values()) {
    workerState.busy = false;
    workerState.dispatching = false;
    workerState.currentContract = null;
  }
  emitPoolSnapshot();
}

export function enqueueContract(contractId, logger) {
  if (taskQueue.includes(contractId)) return false;
  taskQueue.push(contractId);
  logger?.info?.(`[worker-runtime-state] enqueued ${contractId}`);
  emitPoolSnapshot();
  return true;
}
```

- [ ] **Step 2: Replace `pool.js` internals with compatibility re-exports**

```javascript
// lib/routing/pool.js
export {
  syncWorkerTargets as initDispatchTargets,
  listWorkerIds as getWorkerIds,
  loadWorkerQueueState as loadQueue,
  persistWorkerQueueState as persistQueue,
  claimWorkerContract as dequeue,
  releaseWorkerContract as releaseWorker,
  enqueueContract as enqueue,
  buildPoolSnapshot,
  emitPoolSnapshot,
  isWorkerBusy,
  markWorkerDispatching,
  rollbackWorkerDispatch,
} from "./worker-runtime-state.js";

export function ensurePendingContractQueued(contractId, api, logger) {
  if (!contractId || typeof contractId !== "string") {
    return { queued: false, reason: "invalid_contract_id" };
  }
  const queued = enqueueContract(contractId, logger);
  return { queued, reason: queued ? "enqueued" : "already_scheduled" };
}
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/worker-runtime-state.test.js tests/pool.test.js
```

Expected:
- PASS for new module tests
- FAIL in callers that still expect old `pool.js` internals

- [ ] **Step 4: Commit**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/lib/routing/worker-runtime-state.js extensions/watchdog/lib/routing/pool.js
git commit -m "refactor(pool): extract worker runtime state owner"
```

---

### Task 3: Rewire Runtime Callers to the New State Owner

**Files:**
- Modify: `extensions/watchdog/lib/routing/graph-router.js`
- Modify: `extensions/watchdog/lib/session-bootstrap.js`
- Modify: `extensions/watchdog/lib/lifecycle/runtime-lifecycle.js`
- Modify: `extensions/watchdog/lib/lifecycle/crash-recovery.js`
- Modify: `extensions/watchdog/index.js`
- Modify: `extensions/watchdog/routes/api.js`
- Modify: `extensions/watchdog/lib/operator/operator-snapshot-runtime.js`

- [ ] **Step 1: Replace direct `workerPool` mutation in `graph-router.js`**

```javascript
import {
  isWorkerBusy,
  markWorkerDispatching,
  rollbackWorkerDispatch,
  syncWorkerTargets,
} from "./worker-runtime-state.js";

function isAgentBusy(agentId) {
  if (workerPool.has(agentId)) return isWorkerBusy(agentId);
  return busyAgents.has(agentId);
}

function markBusy(agentId, contractId) {
  if (workerPool.has(agentId)) {
    markWorkerDispatching(agentId, contractId);
    return;
  }
  busyAgents.set(agentId, contractId);
}

export function markIdle(agentId) {
  if (workerPool.has(agentId)) {
    rollbackWorkerDispatch(agentId);
    return;
  }
  busyAgents.delete(agentId);
}
```

- [ ] **Step 2: Move claim/release callers onto the new helper API**

```javascript
// session-bootstrap.js
import { claimWorkerContract } from "./routing/worker-runtime-state.js";

await updateContractStatus(path, CONTRACT_STATUS.RUNNING, logger);
await claimWorkerContract({
  contractId: contract.id,
  workerId: agentId,
  logger,
});
```

```javascript
// runtime-lifecycle.js
import { releaseWorkerContract } from "../routing/worker-runtime-state.js";

if (trackingState && isWorker(agentId)) {
  const poolState = workerPool.get(agentId);
  if (poolState?.busy || poolState?.dispatching) {
    await releaseWorkerContract({ workerId: agentId, logger });
    workerReleased = true;
  }
}
```

```javascript
// crash-recovery.js
import { releaseWorkerContract } from "../routing/worker-runtime-state.js";

if (isWorker(agentId)) {
  await releaseWorkerContract({ workerId: agentId, logger });
}
```

- [ ] **Step 3: Rewire startup and snapshots**

```javascript
// index.js
import {
  initDispatchTargets,
  getWorkerIds,
  loadQueue,
  persistQueue,
} from "./lib/routing/worker-runtime-state.js";
```

```javascript
// routes/api.js / operator-snapshot-runtime.js
import { buildPoolSnapshot } from "../lib/routing/worker-runtime-state.js";

const poolSnapshot = buildPoolSnapshot();
return {
  ...poolSnapshot,
  dispatchChainSize: getDispatchChainSize(),
};
```

- [ ] **Step 4: Run integration-focused tests**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/worker-runtime-state.test.js tests/graph-router.test.js tests/pool.test.js tests/contractor-handoff-terminal.test.js
```

Expected:
- PASS for worker claim/release lifecycle
- PASS for graph-router queue/dispatch behavior

- [ ] **Step 5: Commit**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/lib/routing/graph-router.js extensions/watchdog/lib/session-bootstrap.js extensions/watchdog/lib/lifecycle/runtime-lifecycle.js extensions/watchdog/lib/lifecycle/crash-recovery.js extensions/watchdog/index.js extensions/watchdog/routes/api.js extensions/watchdog/lib/operator/operator-snapshot-runtime.js
git commit -m "refactor(runtime): rewire worker lifecycle to runtime state owner"
```

---

### Task 4: Delete Dead Dispatch Logic from `pool.js` and Clean the Test Surface

**Files:**
- Modify: `extensions/watchdog/lib/routing/pool.js`
- Modify: `extensions/watchdog/tests/pool.test.js`
- Modify: `extensions/watchdog/tests/graph-router.test.js`

- [ ] **Step 1: Remove dead dispatch/retry code paths**

Delete these exports and their tests:

```javascript
dispatchNext
_dispatchNextInner
registerPendingDispatch
cancelPendingDispatch
pickIdleWorker
wakeWorkerDispatch
buildWorkerWakeMessage
```

The compat surface after cleanup should be limited to:

```javascript
initDispatchTargets
getWorkerIds
loadQueue
persistQueue
enqueue
ensurePendingContractQueued
dequeue
releaseWorker
buildPoolSnapshot
emitPoolSnapshot
```

- [ ] **Step 2: Update `pool.test.js` to assert the smaller compatibility surface**

```javascript
test("pool compat surface no longer exposes dispatch/retry internals", async () => {
  const pool = await import("../lib/routing/pool.js");

  assert.equal("dispatchNext" in pool, false);
  assert.equal("cancelPendingDispatch" in pool, false);
  assert.equal(typeof pool.releaseWorker, "function");
  assert.equal(typeof pool.dequeue, "function");
});
```

- [ ] **Step 3: Run the targeted cleanup suite**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/worker-runtime-state.test.js tests/graph-router.test.js tests/pool.test.js
```

Expected:
- PASS

- [ ] **Step 4: Run broader watchdog verification**

Run:

```bash
cd /Users/hakens/.openclaw/extensions/watchdog
node --test tests/*.test.js
```

Expected:
- No regression in worker claim/release, graph routing, API snapshot, or dashboard compatibility tests

- [ ] **Step 5: Commit**

```bash
cd /Users/hakens/.openclaw
git add extensions/watchdog/lib/routing/pool.js extensions/watchdog/tests/pool.test.js extensions/watchdog/tests/graph-router.test.js
git commit -m "cleanup(pool): remove dead dispatch and retry internals"
```

---

## Self-Review

### Spec coverage

- 覆盖了 `pool` 的真实问题：双写状态、死 dispatch/retry 逻辑、claim/release 副作用、持久化、快照兼容。
- 明确拒绝了 Claude 结论里两个边界错误：
  - 不把 QQ claim/release 副作用塞进 `graph-router`
  - 不要求 dashboard 立刻抛弃 `pool_update`
- 保留了后续 memo 91 全控制面的升级路径：`worker-runtime-state.js` 以后可以并入 `agent-execution-control.js`。

### Placeholder scan

- 没有使用 `TODO` / `TBD`
- 每个任务都给了文件路径、代码片段、命令和预期结果

### Type consistency

- 统一使用 `claimWorkerContract` / `releaseWorkerContract` / `buildPoolSnapshot`
- `pool.js` 被定义成 compat shell，不再重新发明第二套名字

---

Plan complete and saved to `docs/superpowers/plans/2026-04-08-pool-runtime-state-extraction.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
