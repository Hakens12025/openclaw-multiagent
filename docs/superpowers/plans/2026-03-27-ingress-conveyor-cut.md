# Conveyor Ingress Long-Path Cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move long-path ingress dispatch ownership onto the shared contractor conveyor path so ingress stops hand-rolling `inbox_dispatch` while frontend-visible long-path truth remains intact.

**Architecture:** Keep `ingress-standard-route` responsible for contract creation, draft registration, and ingress-chain bookkeeping. Move long-path dispatch event ownership into `wakeContractorWithRetry(...)` by passing transport metadata down to contractor transport, so long-path webhook ingress and contractor retries both reuse the same `conveyor` event semantics instead of ingress synthesizing a parallel dispatch truth.

**Tech Stack:** Node.js, built-in `node:test`, OpenClaw watchdog runtime, SSE alerts, shared contracts store, contractor service, formal runtime presets

---

### Task 1: Add Long-Path Ingress Transport Regression Test

**Files:**
- Modify: `extensions/watchdog/tests/unified-control-plane-p0.test.js`
- Test: `extensions/watchdog/tests/unified-control-plane-p0.test.js`

- [ ] **Step 1: Write the failing test for transport metadata delegation**

```js
test("long-path ingress delegates dispatch alert ownership to wakeContractor transport", async () => {
  const sse = captureSseEvents();
  const wakeCalls = [];

  const result = await handleStandardIngress({
    message: "需要 contractor 规划的长路径任务",
    source: "webhook",
    effectiveReplyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    simple: false,
    phases: ["research", "execute"],
    enqueue: () => assert.fail("enqueue should not run for long path"),
    wakeContractor: async (contractId, contractPath, transport = {}) => {
      wakeCalls.push({ contractId, contractPath, transport });
      if (transport.dispatchAlert) {
        broadcast("alert", {
          type: "inbox_dispatch",
          contractId,
          from: transport.from,
          assignee: "contractor",
          route: transport.dispatchAlert.route,
          fastTrack: transport.dispatchAlert.fastTrack,
          ts: Date.now(),
        });
      }
      return { ok: true, mode: "test" };
    },
    logger,
  });

  assert.equal(wakeCalls.length, 1);
  assert.equal(wakeCalls[0].transport.from, "controller");
  assert.equal(wakeCalls[0].transport.dispatchAlert?.route, "long");
  assert.equal(
    sse.events.filter((entry) => entry.event === "alert" && entry.data?.contractId === result.contractId).length,
    1,
  );
});
```

- [ ] **Step 2: Run the targeted test file and verify RED**

Run: `node --test extensions/watchdog/tests/unified-control-plane-p0.test.js`
Expected: FAIL because ingress does not pass transport metadata yet, or because long-path ingress still duplicates the dispatch event instead of delegating it.

### Task 2: Route Long-Path Ingress Through Contractor Conveyor Metadata

**Files:**
- Modify: `extensions/watchdog/lib/ingress-standard-route.js`
- Modify: `extensions/watchdog/lib/contractor-service.js`
- Test: `extensions/watchdog/tests/unified-control-plane-p0.test.js`

- [ ] **Step 1: Extend contractor wake to accept transport metadata**

```js
export async function wakeContractorWithRetry(contractId, contractPath, api, logger, transportOptions = {}) {
  // pass from/dispatchAlert/broadcastDispatch through dispatchSharedInboxContract
}
```

- [ ] **Step 2: Make long-path ingress pass transport metadata instead of hand-rolling alert**

```js
const wake = await wakeContractor(contractId, contractPath, {
  from: fromAgent,
  dispatchAlert: {
    route: "long",
    fastTrack: false,
    ts,
  },
  broadcastDispatch: true,
});
```

- [ ] **Step 3: Remove the ingress-owned long-path `broadcast("alert", ...)` block**

```js
return {
  ok: true,
  contractId,
  source,
  fastTrack: false,
  route: "long",
  wake: wake || null,
  targetAgent: plannerAgentId,
};
```

- [ ] **Step 4: Re-run the targeted test file and verify GREEN**

Run: `node --test extensions/watchdog/tests/unified-control-plane-p0.test.js`
Expected: PASS with the new ingress delegation regression and existing contractor/pipeline control-plane tests still green.

### Task 3: Add Real Contractor Integration Regression

**Files:**
- Modify: `extensions/watchdog/tests/unified-control-plane-p0.test.js`
- Test: `extensions/watchdog/tests/unified-control-plane-p0.test.js`

- [ ] **Step 1: Add a real ingress-to-contractor transport integration test**

```js
test("long-path ingress emits one contractor dispatch event through the real contractor transport", async () => {
  const result = await handleStandardIngress({
    message: "帮我规划一个需要 contractor 的任务",
    source: "webhook",
    effectiveReplyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
    simple: false,
    phases: ["research", "execute"],
    enqueue: () => {},
    wakeContractor: (contractId, contractPath, transport) =>
      wakeContractorWithRetry(contractId, contractPath, api, logger, transport),
    logger,
  });

  const dispatchEvents = sse.events.filter(
    (entry) => entry.event === "alert" && entry.data?.type === "inbox_dispatch" && entry.data?.contractId === result.contractId,
  );
  assert.equal(dispatchEvents.length, 1);
  assert.equal(dispatchEvents[0]?.data?.from, "controller");
  assert.equal(dispatchEvents[0]?.data?.route, "long");
});
```

- [ ] **Step 2: Run the targeted ingress/control-plane tests**

Run: `node --test extensions/watchdog/tests/unified-control-plane-p0.test.js extensions/watchdog/tests/conveyor.test.js`
Expected: PASS with ingress long-path and contractor transport both using the shared conveyor semantics.

### Task 4: Verify Frontend-Visible Long-Path Runtime

**Files:**
- Modify: none
- Test: `extensions/watchdog/tests/suite-loop-platform.js`
- Test: `extensions/watchdog/tests/suite-single.js`

- [ ] **Step 1: Run the platform long-path preset**

Run: `node extensions/watchdog/test-runner.js --preset loop-platform --clean`
Expected: PASS with the user-style webhook draft event still visible and loop elevation truth unchanged.

- [ ] **Step 2: Run a formal full-path single case**

Run: `node extensions/watchdog/test-runner.js --suite single --filter complex-02 --clean`
Expected: PASS with complex contractor -> runtime path still converging on the current formal report format.
