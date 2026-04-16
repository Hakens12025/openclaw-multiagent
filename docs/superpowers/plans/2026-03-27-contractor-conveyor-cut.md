# Conveyor Contractor Cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move contractor draft dispatch onto the shared `conveyor` transport primitive without changing contractor lifecycle, deferred retry, or auto-promote semantics.

**Architecture:** Keep `contractor-service` responsible for queue-head selection, deferred retry scheduling, retry exhaustion, and auto-promotion policy. Move the shared transport mechanics inside contractor dispatch into `conveyor`, so contractor and worker both reuse the same staged-inbox + wake transport boundary while lifecycle and business planning stay outside the transport layer.

**Tech Stack:** Node.js, built-in `node:test`, OpenClaw watchdog runtime, SSE alerts, shared contracts store, router inbox staging

---

### Task 1: Add Contractor Transport Regression Tests

**Files:**
- Modify: `extensions/watchdog/tests/conveyor.test.js`
- Test: `extensions/watchdog/tests/conveyor.test.js`

- [ ] **Step 1: Write the failing test for shared-contract transport without assignee mutation**

```js
test("dispatchSharedInboxContract stages contractor draft into inbox and wakes target", async () => {
  const contractId = `TC-CONVEYOR-CONTRACTOR-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  await persistContractSnapshot(contractPath, {
    id: contractId,
    task: "contractor conveyor regression",
    assignee: "worker",
    status: CONTRACT_STATUS.DRAFT,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phases: [],
    total: 1,
    protocol: { version: 1, envelope: "planner_contract" },
  }, logger);

  const result = await dispatchSharedInboxContract({
    contractId,
    targetAgent: "contractor",
    logger,
    wakeupFunc: async (agentId, payload = {}) => ({ ok: true, agentId, payload }),
    wakePayload: { sessionKey: "agent:contractor:main" },
    broadcastDispatch: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.contract?.assignee, "worker");
  const staged = JSON.parse(await readFile(join(agentWorkspace("contractor"), "inbox", "contract.json"), "utf8"));
  assert.equal(staged.id, contractId);
});
```

- [ ] **Step 2: Write the failing integration test for `wakeContractorWithRetry(...)`**

```js
test("wakeContractorWithRetry stages queue-head draft through conveyor and preserves pending retry ownership", async () => {
  const wake = await wakeContractorWithRetry(contractId, contractPath, api, logger);
  assert.equal(wake.ok, true);
  assert.equal(getPendingContractorDispatch(contractId) != null, true);
  assert.equal(heartbeatCalls.length, 1);
  const staged = JSON.parse(await readFile(contractorInboxPath, "utf8"));
  assert.equal(staged.id, contractId);
});
```

- [ ] **Step 3: Run the targeted test file and verify RED**

Run: `node --test extensions/watchdog/tests/conveyor.test.js`
Expected: FAIL with missing `dispatchSharedInboxContract` export or contractor-service still bypassing the shared conveyor transport.

### Task 2: Add Shared Conveyor Transport Primitive

**Files:**
- Modify: `extensions/watchdog/lib/conveyor.js`
- Modify: `extensions/watchdog/tests/conveyor.test.js`
- Test: `extensions/watchdog/tests/conveyor.test.js`

- [ ] **Step 1: Implement a shared staged-inbox dispatch helper**

```js
export async function dispatchSharedInboxContract({
  contractId,
  targetAgent,
  logger = null,
  wakeupFunc = null,
  wakePayload = null,
  contractPathHint = null,
  updateContract = null,
  from = null,
  dispatchAlert = null,
  broadcastDispatch = true,
} = {}) {
  const contractPath = contractPathHint || getContractPath(contractId);
  const contract = typeof updateContract === "function"
    ? (await mutateContractSnapshot(contractPath, logger, updateContract, { touchUpdatedAt: true }))?.contract
    : await readContractSnapshotByPath(contractPath, { preferCache: false });

  await routeInbox(targetAgent, logger);
  const wake = typeof wakeupFunc === "function"
    ? await wakeupFunc(targetAgent, wakePayload || {})
    : null;
  const ok = wake?.ok !== false;

  if (ok && broadcastDispatch !== false) {
    broadcast("alert", normalizeDispatchAlert({ contract, from, targetAgent, dispatchAlert }));
  }

  return { ok, targetAgent, contractId, contract, wake };
}
```

- [ ] **Step 2: Rebuild the worker helper on top of the shared helper**

```js
export async function dispatchWorkerPoolContract(options = {}) {
  return dispatchSharedInboxContract({
    ...options,
    from: options.from || "pool",
    updateContract(contract) {
      if (contract.assignee === options.targetAgent) return false;
      contract.assignee = options.targetAgent;
    },
  });
}
```

- [ ] **Step 3: Run the targeted test file and verify GREEN**

Run: `node --test extensions/watchdog/tests/conveyor.test.js`
Expected: PASS for the new contractor transport regression plus existing direct-inbox and worker-pool conveyor tests.

### Task 3: Make Contractor Service Use Conveyor

**Files:**
- Modify: `extensions/watchdog/lib/contractor-service.js`
- Modify: `extensions/watchdog/lib/conveyor.js`
- Test: `extensions/watchdog/tests/conveyor.test.js`

- [ ] **Step 1: Replace inline contractor staging + wake with conveyor dispatch**

```js
const wake = await dispatchSharedInboxContract({
  contractId: targetContractId,
  contractPathHint: targetContractPath,
  targetAgent: plannerAgentId,
  logger,
  wakeupFunc: (agentId, payload) => wakeAgentDetailed(agentId, message, api, logger, payload),
  wakePayload: { sessionKey: plannerSessionKey },
  broadcastDispatch: false,
});
```

- [ ] **Step 2: Keep contractor retry ownership exactly where it is**

```js
entry.timer = setTimeout(attemptRetry, CONTRACTOR_CONFIRM_TIMEOUT);
if (hooksConfigured) {
  scheduleContractorAutoPromote(targetContractId, targetContractPath, entry, api, logger);
}
```

- [ ] **Step 3: Move retry restaging onto the same conveyor helper**

```js
await dispatchSharedInboxContract({
  contractId: targetContractId,
  contractPathHint: targetContractPath,
  targetAgent: plannerAgentId,
  logger,
  wakeupFunc: async (agentId, payload = {}) => {
    api.runtime.system.requestHeartbeatNow({
      reason: `contractor retry #${entry.retryCount}: ${targetContractId}`,
      agentId,
      ...payload,
    });
    return { ok: true, mode: "heartbeat" };
  },
  wakePayload: { sessionKey: plannerSessionKey },
  broadcastDispatch: false,
});
```

- [ ] **Step 4: Run targeted control-plane regressions**

Run: `node --test extensions/watchdog/tests/conveyor.test.js extensions/watchdog/tests/unified-control-plane-p0.test.js`
Expected: PASS with contractor transport sharing the conveyor path and no regression in contractor bind/lifecycle semantics.

### Task 4: Verify Real Runtime Surfaces Still Hold

**Files:**
- Modify: none
- Test: `extensions/watchdog/tests/formal-full-path-runtime.test.js`
- Test: `extensions/watchdog/tests/contractor-start-pipeline-validity.test.js`
- Test: `extensions/watchdog/tests/suite-loop.js`

- [ ] **Step 1: Run runtime object checks**

Run: `node --test extensions/watchdog/tests/formal-full-path-runtime.test.js extensions/watchdog/tests/contractor-start-pipeline-validity.test.js`
Expected: PASS

- [ ] **Step 2: Run the real contractor dispatch regression**

Run: `node extensions/watchdog/test-runner.js --suite loop --filter dispatch-contractor-inbox --clean`
Expected: PASS with contractor inbox staged before wake and no regression in the real loop-facing transport path.

- [ ] **Step 3: Run a frontend-visible preset**

Run: `node extensions/watchdog/test-runner.js --preset single --clean`
Expected: PASS with no regression in the frontend-visible formal single-path report.
