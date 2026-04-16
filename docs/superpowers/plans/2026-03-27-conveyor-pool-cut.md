# Conveyor Pool Cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move worker-pool dispatch onto the shared `conveyor` transport primitive without changing pool lifecycle semantics.

**Architecture:** Keep `pool` responsible for worker selection, queue ownership, pending-dispatch retry, and dequeue state transitions. Move the shared transport steps inside initial pool dispatch into `conveyor`, so pipeline direct dispatch and worker-pool dispatch stop hand-rolling separate inbox+wake behavior.

**Tech Stack:** Node.js, built-in `node:test`, OpenClaw watchdog runtime, SSE alerts

---

### Task 1: Add Pool Transport Regression Tests

**Files:**
- Modify: `extensions/watchdog/tests/conveyor.test.js`
- Test: `extensions/watchdog/tests/conveyor.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("dispatchWorkerPoolContract stages worker inbox, wakes worker, and emits inbox_dispatch", async () => {
  // Assert: assignee is updated, inbox/contract.json is staged, wake called once,
  // and inbox_dispatch identifies the selected worker.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extensions/watchdog/tests/conveyor.test.js`
Expected: FAIL with missing export or missing function for worker-pool dispatch.

- [ ] **Step 3: Write minimal implementation**

```js
export async function dispatchWorkerPoolContract(...) {
  // mutate contract assignee
  // routeInbox(targetAgent)
  // wake target via hooks/heartbeat callback
  // emit inbox_dispatch alert
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test extensions/watchdog/tests/conveyor.test.js`
Expected: PASS for the new worker-pool transport regression and existing direct-inbox transport tests.

### Task 2: Make Pool Use Conveyor

**Files:**
- Modify: `extensions/watchdog/lib/pool.js`
- Modify: `extensions/watchdog/lib/conveyor.js`
- Test: `extensions/watchdog/tests/conveyor.test.js`

- [ ] **Step 1: Replace inline transport in pool dispatch**

```js
const dispatchResult = await dispatchWorkerPoolContract({
  contractId,
  targetAgent: workerId,
  api,
  logger,
});
```

- [ ] **Step 2: Preserve pending-dispatch retry ownership in pool**

```js
if (dispatchResult.ok) {
  registerPendingDispatch(workerId, contractId, dispatchIndex, api, logger);
} else {
  // rollback queue + dispatching flag exactly as before
}
```

- [ ] **Step 3: Run targeted regression tests**

Run: `node --test extensions/watchdog/tests/conveyor.test.js extensions/watchdog/tests/unified-control-plane-p0.test.js`
Expected: PASS with no regression in pipeline transport.

### Task 3: Verify Real Runtime Surfaces Still Hold

**Files:**
- Modify: none
- Test: `extensions/watchdog/tests/formal-full-path-runtime.test.js`
- Test: `extensions/watchdog/tests/contractor-start-pipeline-validity.test.js`

- [ ] **Step 1: Run object/runtime checks**

Run: `node --test extensions/watchdog/tests/formal-full-path-runtime.test.js extensions/watchdog/tests/contractor-start-pipeline-validity.test.js`
Expected: PASS

- [ ] **Step 2: Run frontend-visible preset**

Run: `node extensions/watchdog/test-runner.js --preset single --clean`
Expected: formal report finishes without new worker-pool dispatch regression.
