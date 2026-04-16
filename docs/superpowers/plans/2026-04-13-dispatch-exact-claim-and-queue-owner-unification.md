# Dispatch Exact Claim And Queue Owner Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shared-contract dispatch succeed only when the exact target session claims the exact target contract, while removing online fallback selection from contract sessions.

**Architecture:** Reuse the existing `dispatch-runtime-state` owner for queue truth and `tracker-store` claim waiters for accept truth. Contract sessions become exact-claim only; main/recovery sessions retain recovery behavior but must prefer dispatch owner state instead of scanning shared contracts.

**Tech Stack:** Node.js, watchdog runtime hooks, tracker store, dispatch runtime state, node:test

---

### Task 1: Lock Contract Session Bootstrap To Exact Contract

**Files:**
- Modify: `extensions/watchdog/hooks/before-agent-start.js`
- Modify: `extensions/watchdog/lib/session-bootstrap.js`
- Modify: `extensions/watchdog/lib/session-keys.js`
- Test: `extensions/watchdog/tests/session-key-canonicalization.test.js`
- Test: `extensions/watchdog/tests/dispatch-graph-policy.test.js`

- [ ] **Step 1: Write the failing test for contract-session exact bind**

```js
test("contract session bootstrap binds only the contract encoded in sessionKey", async () => {
  const sessionKey = "agent:planner:contract:TC-NEW";
  const hinted = parseContractSessionKey(sessionKey);
  assert.deepEqual(hinted, { agentId: "planner", contractId: "TC-NEW" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test ~/.openclaw/extensions/watchdog/tests/session-key-canonicalization.test.js
```

Expected: FAIL because contract-session parsing does not yet exist.

- [ ] **Step 3: Implement session-key parsing helper**

```js
export function parseAgentContractSessionKey(sessionKey) {
  const normalized = normalizeString(sessionKey);
  const match = normalized?.match(/^agent:([^:]+):contract:(.+)$/i);
  if (!match) return null;
  return {
    agentId: normalizeString(match[1]),
    contractId: normalizeString(match[2]),
  };
}
```

- [ ] **Step 4: Teach before_agent_start to exact-bind contract sessions**

```js
const contractSession = parseAgentContractSessionKey(sessionKey);
if (contractSession) {
  await routeInbox(agentId, logger, {
    sessionKey,
    contractIdHint: contractSession.contractId,
    contractPathHint: getContractPath(contractSession.contractId),
  });
}
```

- [ ] **Step 5: Make contract-session binding reject fallback search**

```js
if (contractSession && !trackingState.contract) {
  await bindInboxContractEnvelope({
    agentId,
    trackingState,
    logger,
    allowNonDirectRequest: true,
    requiredContractId: contractSession.contractId,
  });
}
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
node --test ~/.openclaw/extensions/watchdog/tests/session-key-canonicalization.test.js
node --test ~/.openclaw/extensions/watchdog/tests/dispatch-graph-policy.test.js
```

Expected: PASS

---

### Task 2: Add Dispatch Claim-Confirm To Shared Contract Dispatch

**Files:**
- Modify: `extensions/watchdog/lib/routing/dispatch-transport.js`
- Modify: `extensions/watchdog/lib/routing/dispatch-graph-policy.js`
- Modify: `extensions/watchdog/lib/store/tracker-store.js`
- Test: `extensions/watchdog/tests/dispatch-graph-policy.test.js`
- Test: `extensions/watchdog/tests/retry-suspend-dispatch-graph-policy.test.js`

- [ ] **Step 1: Write the failing dispatch confirm test**

```js
test("dispatch succeeds only after target session claims the target contract", async () => {
  const result = await dispatchRouteExecutionContract("TC-CLAIM", "controller", "planner", api, logger);
  assert.equal(result.dispatched, true);
  assert.equal(result.claimed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test ~/.openclaw/extensions/watchdog/tests/dispatch-graph-policy.test.js
```

Expected: FAIL because dispatch currently returns after wake.

- [ ] **Step 3: Implement dispatch-side confirm primitive**

```js
const sessionKey = buildAgentContractSessionKey(targetAgent, contractId);
const wake = await requestDispatchWake({ ... });
const claim = await waitForTrackingContractClaim(sessionKey, contractId, 1500);
if (!claim.claimed) {
  rollbackDispatchTargetDispatch(targetAgent);
  return { ok: false, wake, claim };
}
await claimDispatchTargetContract({ contractId, agentId: targetAgent, logger });
```

- [ ] **Step 4: Update dispatch result shape to expose claim outcome**

```js
return {
  dispatched: true,
  queued: false,
  claimed: true,
  claimSource: claim.source || null,
};
```

- [ ] **Step 5: Requeue or rollback on claim miss**

```js
if (!claim.claimed) {
  rollbackDispatchTargetDispatch(targetAgent);
  return { dispatched: false, queued: false, failed: true, reason: claim.reason || "claim_miss" };
}
```

- [ ] **Step 6: Run dispatch tests**

Run:

```bash
node --test ~/.openclaw/extensions/watchdog/tests/dispatch-graph-policy.test.js
node --test ~/.openclaw/extensions/watchdog/tests/retry-suspend-dispatch-graph-policy.test.js
```

Expected: PASS

---

### Task 3: Remove Online Fallback Scanning From Contract Sessions

**Files:**
- Modify: `extensions/watchdog/lib/routing/runtime-mailbox-inbox-handlers.js`
- Modify: `extensions/watchdog/lib/session-bootstrap.js`
- Modify: `extensions/watchdog/lib/contracts.js`
- Test: `extensions/watchdog/tests/dispatch-graph-policy.test.js`
- Test: `extensions/watchdog/tests/conveyor.test.js`

- [ ] **Step 1: Write the failing fallback regression test**

```js
test("contract session routeInbox never replaces exact hinted contract with an older active contract", async () => {
  const result = await routeWorkerInbox({
    agentId: "planner",
    inboxDir,
    logger,
    sessionKey: "agent:planner:contract:TC-NEW",
    contractIdHint: "TC-NEW",
    contractPathHint: newPath,
  });
  assert.equal(readInboxContract().id, "TC-NEW");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test ~/.openclaw/extensions/watchdog/tests/conveyor.test.js
```

Expected: FAIL because fallback search can still choose another contract.

- [ ] **Step 3: Make routeInbox exact when hints are present**

```js
if (normalizedContractPathHint) {
  const requestedContract = await readContractSnapshotByPath(normalizedContractPathHint, { preferCache: false });
  if (!requestedContract || requestedContract.id !== normalizedContractIdHint) {
    await removeInboxContractIfExists(inboxDir, logger, agentId);
    return;
  }
}
```

- [ ] **Step 4: Remove path-order fallback from contract sessions**

```js
if (normalizedContractIdHint) {
  await removeInboxContractIfExists(inboxDir, logger, agentId);
  logger.info(`[router] routeInbox(${agentId}): exact contract ${normalizedContractIdHint} not claimable`);
  return;
}
```

- [ ] **Step 5: Keep scanning only for recovery/main sessions**

```js
const allowFallbackSearch = !normalizedContractIdHint && !normalizedContractPathHint;
if (!allowFallbackSearch) return;
```

- [ ] **Step 6: Run inbox routing tests**

Run:

```bash
node --test ~/.openclaw/extensions/watchdog/tests/conveyor.test.js
node --test ~/.openclaw/extensions/watchdog/tests/dispatch-graph-policy.test.js
```

Expected: PASS

---

### Task 4: Align Recovery With Dispatch Owner Instead Of Shared-Contract Scan

**Files:**
- Modify: `extensions/watchdog/lib/session-bootstrap.js`
- Modify: `extensions/watchdog/lib/routing/dispatch-runtime-state.js`
- Test: `extensions/watchdog/tests/worker-runtime-state.test.js`
- Test: `extensions/watchdog/tests/retry-suspend-runtime-lifecycle.test.js`

- [ ] **Step 1: Write the failing recovery-owner test**

```js
test("recovery prefers dispatch currentContract over shared-contract scan", async () => {
  setDispatchTargetState("worker", { busy: true, currentContract: "TC-OWNER" });
  const claimed = await bindPendingWorkerContract({ agentId: "worker", sessionKey, trackingState, logger });
  assert.equal(claimed.contract.id, "TC-OWNER");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test ~/.openclaw/extensions/watchdog/tests/worker-runtime-state.test.js
```

Expected: FAIL because recovery still scans pending contracts directly.

- [ ] **Step 3: Add dispatch-owner lookup helper**

```js
export function getDispatchTargetCurrentContract(agentId) {
  return dispatchTargetStateMap.get(agentId)?.currentContract || null;
}
```

- [ ] **Step 4: Update bindPendingWorkerContract to prefer owner state**

```js
const currentContractId = getDispatchTargetCurrentContract(agentId);
if (currentContractId) {
  const currentPath = getContractPath(currentContractId);
  const currentContract = await readContractSnapshotByPath(currentPath, { preferCache: false });
  if (currentContract?.assignee === agentId && isActiveContractStatus(currentContract.status)) {
    // bind exact current contract
  }
}
```

- [ ] **Step 5: Keep scanPendingContracts only as last-resort recovery**

```js
const pending = currentContract ? null : await scanPendingContracts(logger, agentId);
```

- [ ] **Step 6: Run recovery tests**

Run:

```bash
node --test ~/.openclaw/extensions/watchdog/tests/worker-runtime-state.test.js
node --test ~/.openclaw/extensions/watchdog/tests/retry-suspend-runtime-lifecycle.test.js
```

Expected: PASS

---

### Task 5: Verify End-To-End Behavior On Live Runtime

**Files:**
- Modify: `extensions/watchdog/test-runner.js`
- Test: `extensions/watchdog/tests/suite-single.js`
- Test: `extensions/watchdog/tests/suite-model.js`

- [ ] **Step 1: Add or update test assertions for claim-confirm evidence**

```js
assert(timeline.some((item) => item.event === "agent session start" && item.agentId === "planner"));
assert(!timeline.some((item) => item.contractId && item.contractId !== contractId && item.event === "agent session start"));
```

- [ ] **Step 2: Run focused automated tests**

Run:

```bash
node --test ~/.openclaw/extensions/watchdog/tests/suite-single.js
node --test ~/.openclaw/extensions/watchdog/tests/runtime-wake-unification.test.js
```

Expected: PASS

- [ ] **Step 3: Restart gateway on new code**

Run:

```bash
bash ~/.openclaw/start.sh
```

Expected: `Gateway ready!`

- [ ] **Step 4: Run live preset verification**

Run:

```bash
node ~/.openclaw/extensions/watchdog/test-runner.js --preset single
node ~/.openclaw/extensions/watchdog/test-runner.js --preset concurrent
```

Expected:

- `single` no longer shows a new planner session bound to an older contract
- `concurrent` queue order follows dispatch owner state rather than file scan order

- [ ] **Step 5: Capture the final diagnostic grep**

Run:

```bash
rg -n "hooks-dispatch|before_agent_start|bound inbox envelope|dispatch-graph-policy|claim" ~/.openclaw/logs/gateway.log
```

Expected: exact contract session binds to the exact target contract; no older-contract takeover.
