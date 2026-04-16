# Unified Control Plane P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Close the P0 control-plane seams from memo69 so every currently observed `start_pipeline` / contractor / planner / loop-platform path resolves to one lifecycle interpretation instead of six incompatible ones.

**Architecture:** Keep the broader transport topology in place for this turn and repair the lifecycle/control-plane boundaries that are already breaking real runs. The implementation must accept legacy runtime intents at ingress, bind contractor tracking to the shared contract truth, ensure pending system actions are consumed even when agent-end success is false, preserve planner typed-outbox artifacts, and make T2 assert root-contract lifecycle truth explicitly.

**Tech Stack:** Node.js ESM, watchdog runtime modules, built-in `node:test`, existing `test-runner.js` harness, persistent gateway started via `start.sh`.

---

## File Map

- Create: `extensions/watchdog/tests/unified-control-plane-p0.test.js`
- Modify: `extensions/watchdog/lib/session-bootstrap.js`
- Modify: `extensions/watchdog/hooks/before-agent-start.js`
- Modify: `extensions/watchdog/lib/system-action-runtime-ledger.js`
- Modify: `extensions/watchdog/lib/router-handler-registry.js`
- Modify: `extensions/watchdog/lib/protocol-primitives.js`
- Modify: `extensions/watchdog/lib/system-actions.js`
- Modify: `extensions/watchdog/lib/agent-end-pipeline.js`
- Modify: `extensions/watchdog/tests/suite-loop-platform.js`
- Reference only: `extensions/watchdog/lib/router-outbox-handlers.js`
- Reference only: `extensions/watchdog/lib/pipeline-engine.js`
- Reference only: `extensions/watchdog/test-runner.js`
- Reference only: `use guide/备忘录69_[主]_统一通讯协议ConveyorBelt改造计划_2026-03-26-1400.md`

## Task 1: Add P0 Regression Coverage For All Confirmed Control-Plane Gaps

**Files:**
- Create: `extensions/watchdog/tests/unified-control-plane-p0.test.js`
- Reference: `extensions/watchdog/lib/session-bootstrap.js`
- Reference: `extensions/watchdog/lib/system-action-runtime-ledger.js`
- Reference: `extensions/watchdog/lib/protocol-primitives.js`
- Reference: `extensions/watchdog/lib/system-actions.js`
- Reference: `extensions/watchdog/lib/agent-end-pipeline.js`
- Reference: `extensions/watchdog/lib/router-handler-registry.js`

- [x] **Step 1: Write failing tests for the original three seams plus the newly confirmed runtime gaps**

```js
test("contractor inbox draft contract binds into tracking state", async () => {
  // inbox/contract.json contains a contractor draft contract
  // bind with allowNonDirectRequest=true
  // assert trackingState.contract.id is populated
});

test("start_pipeline dispatched is treated as accepted runtime action", () => {
  // accepted dispatch should not synthesize a terminal failure
});

test("legacy contractor start_pipeline payload normalizes into runtime schema", () => {
  // action/pipeline/context.task/target.agentId -> type + params.startAgent + params.requestedTask + params.loopId
});

test("contractor terminal commit updates shared root contract instead of inbox copy", async () => {
  // shared contract path must receive terminal state, inbox copy stays draft
});

test("consumeSystemAction starts pipeline from contractor legacy start_pipeline payload", async () => {
  // legacy payload variants must still produce DISPATCHED + pipeline_state.json
});

test("agent_end consume_system_action still runs when outbox action exists but event.success=false", async () => {
  // pending outbox/system_action.json should bypass old success gate
});

test("planner outbox manifest passes contract_update artifact path to contractor collector", async () => {
  // typed manifest must reach contractor collector
});
```

- [x] **Step 2: Run the new regression file and confirm RED before implementation**

Run:
```bash
node --test ~/.openclaw/extensions/watchdog/tests/unified-control-plane-p0.test.js
```

Expected:
- FAIL on contractor non-direct bind
- FAIL on accepted `start_pipeline` lifecycle handling
- FAIL on planner manifest forwarding
- FAIL on at least one legacy runtime payload or agent-end gating case

## Task 2: Bind Contractor Tracking To The Shared Contract Truth

**Files:**
- Modify: `extensions/watchdog/lib/session-bootstrap.js`
- Modify: `extensions/watchdog/hooks/before-agent-start.js`
- Test: `extensions/watchdog/tests/unified-control-plane-p0.test.js`

- [x] **Step 1: Generalize the inbox contract binder so contractor sessions can bind non-direct draft contracts**

```js
export async function bindInboxContractEnvelope({
  agentId,
  trackingState,
  logger,
  allowNonDirectRequest = false,
}) {
  // read inbox/contract.json
  // bind direct_request envelopes by default
  // also accept contractor planner/execution drafts when explicitly allowed
}
```

- [x] **Step 2: When binding a non-direct inbox contract, resolve the tracking path back to the shared contract store if it exists**

```js
async function resolveTrackingEnvelopeBinding(contract, fallbackPath) {
  const sharedPath = getContractPath(contract.id);
  const sharedContract = await readContractSnapshotByPath(sharedPath, { preferCache: false });
  return sharedContract?.id === contract.id
    ? { contract: sharedContract, path: sharedPath }
    : { contract, path: fallbackPath };
}
```

- [x] **Step 3: Switch before-start contractor flow to use the generic binder after `routeInbox(...)`**

```js
if (!trackingState.contract) {
  await bindInboxContractEnvelope({
    agentId,
    trackingState,
    logger,
    allowNonDirectRequest: isContractorAgent(agentId),
  });
}
```

- [x] **Step 4: Re-run the targeted contractor binding tests and confirm GREEN**

Run:
```bash
node --test ~/.openclaw/extensions/watchdog/tests/unified-control-plane-p0.test.js --test-name-pattern "contractor inbox draft|shared root contract"
```

Expected:
- PASS for both contractor bind and shared contract commit tests

## Task 3: Normalize Legacy `start_pipeline` Payloads At Ingress And Runtime

**Files:**
- Modify: `extensions/watchdog/lib/protocol-primitives.js`
- Modify: `extensions/watchdog/lib/system-actions.js`
- Test: `extensions/watchdog/tests/unified-control-plane-p0.test.js`

- [x] **Step 1: Accept legacy `action` as an alias for system-intent `type`, and normalize legacy start-pipeline fields into `params`**

```js
const intentType = normalizeString(intent.type)
  || normalizeString(protocol.intentType)
  || normalizeString(action.type)
  || normalizeString(action.action);

if (intentType === INTENT_TYPES.START_PIPELINE) {
  normalizedParams.startAgent = normalizedParams.startAgent
    || action.targetAgent
    || target.agentId
    || action.entryAgentId
    || null;
  normalizedParams.requestedTask = normalizedParams.requestedTask
    || action.task
    || context.task
    || payload.task
    || null;
  normalizedParams.loopId = normalizedParams.loopId
    || action.loopId
    || action.pipeline
    || payload.pipeline_id
    || null;
}
```

- [x] **Step 2: In `dispatchSystemAction()`, resolve missing `startAgent` and `requestedTask` from runtime contract context when legacy payloads omit them**

```js
const resolvedStartAgent = params.startAgent
  || contractData?.planningContext?.activeLoopCandidates?.[0]?.entryAgentId
  || null;
const resolvedRequestedTask = params.requestedTask
  || contractData?.task
  || null;
```

- [x] **Step 3: Re-run the normalization and consume tests and confirm GREEN**

Run:
```bash
node --test ~/.openclaw/extensions/watchdog/tests/unified-control-plane-p0.test.js --test-name-pattern "legacy contractor start_pipeline|consumeSystemAction starts pipeline"
```

Expected:
- PASS because legacy contractor payloads now resolve to a usable runtime start-pipeline request

## Task 4: Treat Accepted `start_pipeline` As Lifecycle Acceptance, Not Terminal Failure

**Files:**
- Modify: `extensions/watchdog/lib/system-action-runtime-ledger.js`
- Modify: `extensions/watchdog/lib/system-actions.js`
- Test: `extensions/watchdog/tests/unified-control-plane-p0.test.js`

- [x] **Step 1: Broaden accepted-system-action detection to cover `start_pipeline` with accepted dispatch statuses**

```js
function isAcceptedSystemAction(systemActionResult) {
  if (isDeferredSystemActionAccepted(systemActionResult)) return true;
  return systemActionResult?.actionType === INTENT_TYPES.START_PIPELINE
    && isDeferredSystemActionAcceptedStatus(systemActionResult?.status);
}
```

- [x] **Step 2: Make terminal-outcome derivation return `null` for accepted start-pipeline results**

```js
if (!systemActionResult
  || systemActionResult.status === SYSTEM_ACTION_STATUS.NO_ACTION
  || isAcceptedSystemAction(systemActionResult)) {
  return null;
}
```

- [x] **Step 3: Ensure dispatch result objects for start-pipeline preserve the normalized action type and resolved params**

```js
return {
  status: SYSTEM_ACTION_STATUS.DISPATCHED,
  actionType: INTENT_TYPES.START_PIPELINE,
  loopId,
  currentStage,
  startAgent,
};
```

- [x] **Step 4: Re-run the accepted-start-pipeline test and confirm GREEN**

Run:
```bash
node --test ~/.openclaw/extensions/watchdog/tests/unified-control-plane-p0.test.js --test-name-pattern "start_pipeline dispatched is treated as accepted"
```

Expected:
- PASS because accepted `start_pipeline` no longer emits a synthetic terminal failure

## Task 5: Always Consume Pending `system_action.json` At Agent End

**Files:**
- Modify: `extensions/watchdog/lib/agent-end-pipeline.js`
- Test: `extensions/watchdog/tests/unified-control-plane-p0.test.js`

- [x] **Step 1: Add a pending-outbox-file check for `outbox/system_action.json`**

```js
async function hasPendingSystemActionFile(agentId) {
  await access(join(agentWorkspace(agentId), "outbox", "system_action.json"));
  return true;
}
```

- [x] **Step 2: Let the `consume_system_action` stage run when either the event succeeded or the file is present**

```js
if (!context.event.success && !await hasPendingSystemActionFile(context.agentId)) return;
```

- [x] **Step 3: Re-run the agent-end gating regression and confirm GREEN**

Run:
```bash
node --test ~/.openclaw/extensions/watchdog/tests/unified-control-plane-p0.test.js --test-name-pattern "agent_end consume_system_action"
```

Expected:
- PASS because real contractor outbox actions are no longer dropped by the success gate

## Task 6: Preserve Planner Typed-Outbox Manifest Routing

**Files:**
- Modify: `extensions/watchdog/lib/router-handler-registry.js`
- Test: `extensions/watchdog/tests/unified-control-plane-p0.test.js`

- [x] **Step 1: Forward `agentId` and `manifest` into the contractor collector path**

```js
collectOutbox: ({ agentId, outboxDir, files, logger, manifest }) =>
  collectContractorOutbox({ agentId, outboxDir, files, logger, manifest })
```

- [x] **Step 2: Re-run the planner manifest regression and confirm GREEN**

Run:
```bash
node --test ~/.openclaw/extensions/watchdog/tests/unified-control-plane-p0.test.js --test-name-pattern "planner outbox manifest"
```

Expected:
- PASS because `_manifest.json` now controls which contractor artifact file is collected

## Task 7: Align Early Delegation Validation With The Normalized Protocol

**Files:**
- Modify: `extensions/watchdog/hooks/after-tool-call.js`
- Test: `extensions/watchdog/tests/unified-control-plane-p0.test.js`

- [x] **Step 1: Add a regression test for legacy `start_pipeline` payloads in the early delegation checker**

```js
test("after-tool-call early delegation check accepts legacy start_pipeline payload", () => {
  const result = deriveDelegationIntentForEarlyCheck({
    action: "start_pipeline",
    target: { agentId: "researcher" },
    pipeline: "t2-loop-platform",
  });
  assert.equal(result.intentType, INTENT_TYPES.START_PIPELINE);
  assert.equal(result.targetAgent, "researcher");
});
```

- [x] **Step 2: Make the early checker reuse `normalizeSystemIntent(...)` instead of reading raw `type` fields directly**

```js
export function deriveDelegationIntentForEarlyCheck(action) {
  const normalized = normalizeSystemIntent(action);
  return {
    intentType: normalized.type || null,
    targetAgent: normalized.params?.targetAgent
      || normalized.params?.startAgent
      || normalized.target?.agentId
      || null,
  };
}
```

- [x] **Step 3: Re-run the targeted early-check regression and confirm GREEN**

Run:
```bash
node --test ~/.openclaw/extensions/watchdog/tests/unified-control-plane-p0.test.js --test-name-pattern "after-tool-call early delegation check"
```

Expected:
- PASS because legacy payloads no longer produce a false `missing intent type` warning in the early checker

## Task 8: Make T2 Fail On Root Lifecycle Truth, Not Hidden False Positives

**Files:**
- Modify: `extensions/watchdog/tests/suite-loop-platform.js`
- Test: `extensions/watchdog/tests/unified-control-plane-p0.test.js`
- Test: `extensions/watchdog/test-runner.js`

- [x] **Step 1: Add a root-contract lifecycle checkpoint after loop elevation + entry ownership**

```js
const rootLifecycleOk = contractRuntime
  && contractRuntime.status !== "draft"
  && contractRuntime.status !== "failed"
  && contractRuntime.systemAction?.type === "start_pipeline";
```

- [x] **Step 2: Emit explicit failure codes for stale root contract lifecycle**

```js
E_ROOT_CONTRACT_STALE: {
  subsystem: "root-contract-lifecycle",
  conclusion: "loop runtime 已抬升，但根合约生命周期没有同步离开 draft / failed 旧态。",
  suggestedFix: "检查 contractor tracking bind、start_pipeline accepted 语义，以及 root contract 的 runtime 字段提交。",
}
```

- [x] **Step 3: Run the full object regression file**

Run:
```bash
node --test ~/.openclaw/extensions/watchdog/tests/unified-control-plane-p0.test.js
```

Expected:
- PASS all P0 regression tests

- [x] **Step 4: Verify the gateway process is fresh and listening before T2**

Run:
```bash
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

Expected:
- one or more `node` listeners on `*:18789` from the freshly started gateway session

- [x] **Step 5: Run the T2 loop-platform suite against the fresh gateway**

Run:
```bash
node ~/.openclaw/extensions/watchdog/test-runner.js --suite loop-platform --filter real-user-loop-start
```

Expected:
- PASS if lifecycle truth now advances with loop truth
- otherwise FAIL only with the explicit stale-lifecycle checkpoint, never with the old silent mismatch

## Final Verification

- [x] Run:
```bash
node --test ~/.openclaw/extensions/watchdog/tests/unified-control-plane-p0.test.js
lsof -nP -iTCP:18789 -sTCP:LISTEN
node ~/.openclaw/extensions/watchdog/test-runner.js --suite loop-platform --filter real-user-loop-start
```

Expected:
- Object regressions green
- Gateway confirmed alive during the run
- T2 either passes fully or fails only with an explicit fresh-runtime control-plane gap
