# Context Retirement And Dispatch Runtime State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire `context.json` from the active watchdog runtime while consolidating all dispatch queue/busy ownership into a single runtime state module.

**Architecture:** Move the old `stage-context.js` implementation into an isolated `lib/legacy/` archive with zero production imports, then replace `worker-runtime-state.js` plus graph-router-local state with a new canonical `dispatch-runtime-state.js` owner. Graph-router becomes a pure routing decision layer, while session bootstrap, lifecycle, admin, SSE, and operator consumers all read/write one dispatch truth object.

**Tech Stack:** Node.js ESM, built-in `node:test`, OpenClaw watchdog runtime, SSE dashboard

---

### Task 1: Freeze `context.json` Retirement in Tests

**Files:**
- Create: `extensions/watchdog/tests/context-sidechannel-retirement.test.js`
- Modify: `extensions/watchdog/tests/system-action-context.test.js`
- Modify: `extensions/watchdog/tests/loop-context-cleanup.test.js`

- [ ] **Step 1: Write the failing retirement coverage**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("production runtime no longer imports stage-context sidechannel", async () => {
  const runtimeHandlerSource = await readFile(
    new URL("../lib/system-action/system-action-runtime-handlers.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(runtimeHandlerSource, /stage-context\.js/);
  assert.doesNotMatch(runtimeHandlerSource, /writeAgentInboxContext/);
});

test("legacy context implementation is archived under lib/legacy and not referenced by production code", async () => {
  const legacySource = await readFile(
    new URL("../lib/legacy/context-sidechannel/stage-context.js", import.meta.url),
    "utf8",
  );

  assert.match(legacySource, /writeAgentInboxContext/);
  assert.match(legacySource, /historical continuity mechanism/i);
});
```

- [ ] **Step 2: Rewrite the old wake-agent context test to assert retirement**

```js
test("dispatchRuntimeSystemAction wake_agent ignores legacy context payload and only requests wake", async () => {
  const result = await dispatchRuntimeSystemAction({
    type: INTENT_TYPES.WAKE_AGENT,
    params: {
      targetAgent,
      reason: "manual wake for explicit context",
      context: {
        manual: true,
        note: "legacy sidechannel should stay inactive",
      },
    },
  }, runtimeContext);

  assert.equal(result?.status, SYSTEM_ACTION_STATUS.DISPATCHED);
  await assert.rejects(
    readFile(join(agentWorkspace(targetAgent), "inbox", "context.json"), "utf8"),
    /ENOENT/,
  );
});
```

- [ ] **Step 3: Replace the old cleanup assertion with a legacy-isolation assertion**

```js
test("loop cleanup leaves no active runtime references to context sidechannel", async () => {
  const handlerSource = await readFile(
    new URL("../lib/system-action/system-action-runtime-handlers.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(handlerSource, /context\.json/);
  assert.doesNotMatch(handlerSource, /writeAgentInboxContext/);
});
```

- [ ] **Step 4: Run the focused retirement tests to verify they fail first**

Run:

```bash
cd /Users/hakens/.openclaw
node --test \
  extensions/watchdog/tests/system-action-context.test.js \
  extensions/watchdog/tests/loop-context-cleanup.test.js \
  extensions/watchdog/tests/context-sidechannel-retirement.test.js
```

Expected: FAIL because production still imports `stage-context.js`, writes `context.json`, and no archived legacy file exists yet.

- [ ] **Step 5: Commit the red test snapshot**

```bash
cd /Users/hakens/.openclaw
git add \
  extensions/watchdog/tests/system-action-context.test.js \
  extensions/watchdog/tests/loop-context-cleanup.test.js \
  extensions/watchdog/tests/context-sidechannel-retirement.test.js
git commit -m "test: freeze context sidechannel retirement"
```

### Task 2: Retire Active `context.json` and Archive the Historical Mechanism

**Files:**
- Create: `extensions/watchdog/lib/legacy/context-sidechannel/stage-context.js`
- Delete: `extensions/watchdog/lib/stage-context.js`
- Modify: `extensions/watchdog/lib/system-action/system-action-runtime-handlers.js`
- Modify: `extensions/watchdog/tests/system-action-context.test.js`
- Modify: `extensions/watchdog/tests/loop-context-cleanup.test.js`
- Test: `extensions/watchdog/tests/context-sidechannel-retirement.test.js`

- [ ] **Step 1: Archive the old sidechannel implementation under `lib/legacy/`**

```js
// extensions/watchdog/lib/legacy/context-sidechannel/stage-context.js
//
// Historical continuity mechanism retained for reference only.
// The active runtime must not import this file.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { agentWorkspace, atomicWriteFile } from "../../state.js";
import { normalizeString } from "../../core/normalize.js";

export async function writeAgentInboxContext(agentId, context, logger = null, { contextType = "context" } = {}) {
  const normalizedAgentId = normalizeString(agentId) || null;
  if (!normalizedAgentId) {
    return { agentId: null, context: null, path: null };
  }

  const inboxDir = join(agentWorkspace(normalizedAgentId), "inbox");
  await mkdir(inboxDir, { recursive: true });
  const contextPath = join(inboxDir, "context.json");
  const typedContext = {
    contextVersion: 1,
    contextType: normalizeString(contextType) || "context",
    ...(context && typeof context === "object" ? context : {}),
  };
  await atomicWriteFile(contextPath, JSON.stringify(typedContext, null, 2));
  logger?.info?.(`[legacy-context] wrote ${contextPath} for ${normalizedAgentId}`);
  return { agentId: normalizedAgentId, context: typedContext, path: contextPath };
}
```

- [ ] **Step 2: Remove the active runtime dependency from `wake_agent`**

```js
// extensions/watchdog/lib/system-action/system-action-runtime-handlers.js
async function handleWakeAgentAction(normalizedAction, {
  agentId,
  api,
  logger,
  contractData,
}) {
  const collaborationTarget = await prepareCollaborationTarget({
    actionType: normalizedAction.type,
    sourceAgentId: agentId,
    contractData,
    logger,
    targetAgent: normalizedAction.params?.targetAgent,
    missingTargetError: "wake_agent requires targetAgent",
    missingTargetStatus: SYSTEM_ACTION_STATUS.INVALID_PARAMS,
  });
  if (!collaborationTarget.ok) {
    return collaborationTarget.result;
  }

  const target = collaborationTarget.targetAgent;
  const wake = normalizeWakeDiagnostic(
    await wakeAgentDetailed(
      target,
      normalizedAction.params?.reason || "system_action wakeup",
      api,
      logger,
    ),
    {
      lane: "system_action.wake_agent",
      targetAgent: target,
    },
  );

  // keep wake behavior, ignore legacy context payload
  return {
    status: wake.ok ? SYSTEM_ACTION_STATUS.DISPATCHED : SYSTEM_ACTION_STATUS.WAKE_FAILED,
    actionType: normalizedAction.type,
    targetAgent: target,
    wake,
  };
}
```

- [ ] **Step 3: Delete the active `stage-context.js` file**

```bash
cd /Users/hakens/.openclaw
rm extensions/watchdog/lib/stage-context.js
```

- [ ] **Step 4: Run the focused retirement suite and make it pass**

Run:

```bash
cd /Users/hakens/.openclaw
node --test \
  extensions/watchdog/tests/system-action-context.test.js \
  extensions/watchdog/tests/loop-context-cleanup.test.js \
  extensions/watchdog/tests/context-sidechannel-retirement.test.js
```

Expected: PASS. Active runtime no longer writes `context.json`; archived legacy source exists under `lib/legacy/`.

- [ ] **Step 5: Commit the retirement slice**

```bash
cd /Users/hakens/.openclaw
git add \
  extensions/watchdog/lib/legacy/context-sidechannel/stage-context.js \
  extensions/watchdog/lib/system-action/system-action-runtime-handlers.js \
  extensions/watchdog/lib/stage-context.js \
  extensions/watchdog/tests/system-action-context.test.js \
  extensions/watchdog/tests/loop-context-cleanup.test.js \
  extensions/watchdog/tests/context-sidechannel-retirement.test.js
git commit -m "refactor: retire active context sidechannel"
```

### Task 3: Introduce Canonical `dispatch-runtime-state` and Remove Split Owners

**Files:**
- Create: `extensions/watchdog/lib/routing/dispatch-runtime-state.js`
- Delete: `extensions/watchdog/lib/routing/worker-runtime-state.js`
- Modify: `extensions/watchdog/lib/routing/graph-router.js`
- Modify: `extensions/watchdog/lib/session-bootstrap.js`
- Modify: `extensions/watchdog/lib/lifecycle/runtime-lifecycle.js`
- Modify: `extensions/watchdog/lib/system-action/system-actions.js`
- Modify: `extensions/watchdog/lib/lifecycle/agent-end-pipeline.js`
- Modify: `extensions/watchdog/lib/ingress/ingress-standard-route.js`
- Modify: `extensions/watchdog/lib/operator/operator-snapshot-runtime.js`
- Modify: `extensions/watchdog/lib/admin/runtime-admin.js`
- Modify: `extensions/watchdog/index.js`
- Modify: `extensions/watchdog/routes/api.js`
- Modify: `extensions/watchdog/tests/worker-runtime-state.test.js`
- Modify: `extensions/watchdog/tests/graph-router.test.js`
- Modify: `extensions/watchdog/tests/retry-suspend-runtime-lifecycle.test.js`
- Modify: `extensions/watchdog/tests/retry-suspend-crash-recovery.test.js`
- Modify: `extensions/watchdog/tests/retry-suspend-router.test.js`
- Modify: `extensions/watchdog/tests/conveyor.test.js`
- Modify: `extensions/watchdog/tests/control-plane-worker-state-consumers.test.js`

- [ ] **Step 1: Freeze the unified-owner behavior in tests**

```js
test("graph-router no longer declares local busy or queue owners", async () => {
  const source = await readFile(
    new URL("../lib/routing/graph-router.js", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /const busyAgents = new Map/);
  assert.doesNotMatch(source, /const agentQueues = new Map/);
  assert.match(source, /from "\.\/dispatch-runtime-state\.js"/);
});

test("dispatch runtime queue works for executor and planner targets alike", async () => {
  await syncDispatchTargets(["planner-a", "worker-a"], logger);

  assert.equal(enqueueDispatchContract("planner-a", "TC-PLANNER-1", {}, logger), true);
  assert.equal(enqueueDispatchContract("worker-a", "TC-WORKER-1", {}, logger), true);
  assert.equal(getDispatchQueueDepth("planner-a"), 1);
  assert.equal(getDispatchQueueDepth("worker-a"), 1);
});
```

- [ ] **Step 2: Build `dispatch-runtime-state.js` by lifting the existing worker owner into a general owner**

```js
// extensions/watchdog/lib/routing/dispatch-runtime-state.js
import { readFile } from "node:fs/promises";
import { workerPool, taskQueue, atomicWriteFile, QUEUE_STATE_FILE } from "../state.js";
import { AGENT_ROLE, listAgentIdsByRole } from "../agent/agent-identity.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { qqNotify, qqTypingStart, qqTypingStop, getQQTarget } from "../qq.js";
import { readCachedContractSnapshotById } from "../store/contract-store.js";
import { getContractPath } from "../contracts.js";

function ensureDispatchState(agentId) {
  if (!workerPool.has(agentId)) {
    workerPool.set(agentId, {
      busy: false,
      healthy: true,
      dispatching: false,
      lastSeen: Date.now(),
      currentContract: null,
      queue: [],
    });
  }
  return workerPool.get(agentId);
}

export async function syncDispatchTargetsFromRuntime(logger) {
  const targets = [
    ...listAgentIdsByRole(AGENT_ROLE.PLANNER),
    ...listAgentIdsByRole(AGENT_ROLE.EXECUTOR),
    ...listAgentIdsByRole(AGENT_ROLE.RESEARCHER),
    ...listAgentIdsByRole(AGENT_ROLE.REVIEWER),
    ...listAgentIdsByRole(AGENT_ROLE.AGENT),
  ];
  return syncDispatchTargets(targets, logger);
}
```

- [ ] **Step 3: Move queue ownership out of `graph-router.js`**

```js
import {
  dequeueDispatchContract,
  enqueueDispatchContract,
  getDispatchQueueDepth,
  hasDispatchTarget,
  isDispatchTargetBusy,
  markDispatchTargetDispatching,
  releaseDispatchTargetContract,
  rollbackDispatchTargetDispatch,
} from "./dispatch-runtime-state.js";

function isAgentBusy(agentId) {
  return hasDispatchTarget(agentId) ? isDispatchTargetBusy(agentId) : false;
}

async function enqueueForAgent(agentId, entry, logger) {
  if (entry.contractId) {
    await assignContractToAgent(entry.contractId, agentId, logger);
  }
  const queued = enqueueDispatchContract(agentId, entry.contractId, { fromAgent: entry.fromAgent }, logger);
  return { queued };
}
```

- [ ] **Step 4: Update all runtime consumers to import the canonical owner**

```js
// examples
import { claimDispatchTargetContract } from "./routing/dispatch-runtime-state.js";
import { releaseDispatchTargetContract, isDispatchTargetBusy } from "../routing/dispatch-runtime-state.js";
import { buildDispatchRuntimeSnapshot } from "../routing/dispatch-runtime-state.js";
import { clearDispatchQueue, persistDispatchRuntimeState, resetAllDispatchStates } from "../routing/dispatch-runtime-state.js";
```

- [ ] **Step 5: Rename and expand the runtime-state tests**

```js
import {
  buildDispatchRuntimeSnapshot,
  claimDispatchTargetContract,
  enqueueDispatchContract,
  getDispatchQueueDepth,
  listDispatchTargetIds,
  releaseDispatchTargetContract,
  syncDispatchTargets,
  syncDispatchTargetsFromRuntime,
} from "../lib/routing/dispatch-runtime-state.js";

test("dispatch-runtime-state no longer exposes worker-only names", async () => {
  const moduleNs = await import("../lib/routing/dispatch-runtime-state.js");
  assert.equal("buildWorkerRuntimeSnapshot" in moduleNs, false);
  assert.equal("enqueueContract" in moduleNs, false);
});
```

- [ ] **Step 6: Run the focused dispatch-state suite**

Run:

```bash
cd /Users/hakens/.openclaw
node --test \
  extensions/watchdog/tests/worker-runtime-state.test.js \
  extensions/watchdog/tests/graph-router.test.js \
  extensions/watchdog/tests/retry-suspend-runtime-lifecycle.test.js \
  extensions/watchdog/tests/retry-suspend-crash-recovery.test.js \
  extensions/watchdog/tests/retry-suspend-router.test.js \
  extensions/watchdog/tests/conveyor.test.js \
  extensions/watchdog/tests/control-plane-worker-state-consumers.test.js
```

Expected: PASS. No graph-router-local queue owner remains; all consumers import `dispatch-runtime-state.js`.

- [ ] **Step 7: Commit the unified dispatch owner slice**

```bash
cd /Users/hakens/.openclaw
git add \
  extensions/watchdog/lib/routing/dispatch-runtime-state.js \
  extensions/watchdog/lib/routing/worker-runtime-state.js \
  extensions/watchdog/lib/routing/graph-router.js \
  extensions/watchdog/lib/session-bootstrap.js \
  extensions/watchdog/lib/lifecycle/runtime-lifecycle.js \
  extensions/watchdog/lib/system-action/system-actions.js \
  extensions/watchdog/lib/lifecycle/agent-end-pipeline.js \
  extensions/watchdog/lib/ingress/ingress-standard-route.js \
  extensions/watchdog/lib/operator/operator-snapshot-runtime.js \
  extensions/watchdog/lib/admin/runtime-admin.js \
  extensions/watchdog/index.js \
  extensions/watchdog/routes/api.js \
  extensions/watchdog/tests/worker-runtime-state.test.js \
  extensions/watchdog/tests/graph-router.test.js \
  extensions/watchdog/tests/retry-suspend-runtime-lifecycle.test.js \
  extensions/watchdog/tests/retry-suspend-crash-recovery.test.js \
  extensions/watchdog/tests/retry-suspend-router.test.js \
  extensions/watchdog/tests/conveyor.test.js \
  extensions/watchdog/tests/control-plane-worker-state-consumers.test.js
git commit -m "refactor: unify dispatch runtime state ownership"
```

### Task 4: Run Cross-Slice Verification and Sweep Residual References

**Files:**
- Modify: `extensions/watchdog/tests/control-plane-worker-state-consumers.test.js`
- Modify: `extensions/watchdog/tests/context-sidechannel-retirement.test.js`
- Test: `extensions/watchdog/tests/system-action-context.test.js`
- Test: `extensions/watchdog/tests/loop-context-cleanup.test.js`
- Test: `extensions/watchdog/tests/worker-runtime-state.test.js`
- Test: `extensions/watchdog/tests/graph-router.test.js`
- Test: `extensions/watchdog/tests/retry-suspend-runtime-lifecycle.test.js`
- Test: `extensions/watchdog/tests/retry-suspend-crash-recovery.test.js`
- Test: `extensions/watchdog/tests/retry-suspend-router.test.js`
- Test: `extensions/watchdog/tests/conveyor.test.js`

- [ ] **Step 1: Add a residual-reference guard for both retired surfaces**

```js
test("production runtime has no active imports of retired context or worker runtime modules", async () => {
  const files = [
    "extensions/watchdog/lib/system-action/system-action-runtime-handlers.js",
    "extensions/watchdog/lib/routing/graph-router.js",
    "extensions/watchdog/lib/session-bootstrap.js",
    "extensions/watchdog/lib/lifecycle/runtime-lifecycle.js",
    "extensions/watchdog/lib/operator/operator-snapshot-runtime.js",
    "extensions/watchdog/lib/admin/runtime-admin.js",
    "extensions/watchdog/index.js",
    "extensions/watchdog/routes/api.js",
  ];

  for (const file of files) {
    const source = await readFile(join(process.cwd(), file), "utf8");
    assert.doesNotMatch(source, /stage-context\.js/);
    assert.doesNotMatch(source, /worker-runtime-state\.js/);
  }
});
```

- [ ] **Step 2: Run the complete targeted regression pack**

Run:

```bash
cd /Users/hakens/.openclaw
node --test \
  extensions/watchdog/tests/context-sidechannel-retirement.test.js \
  extensions/watchdog/tests/system-action-context.test.js \
  extensions/watchdog/tests/loop-context-cleanup.test.js \
  extensions/watchdog/tests/worker-runtime-state.test.js \
  extensions/watchdog/tests/graph-router.test.js \
  extensions/watchdog/tests/retry-suspend-runtime-lifecycle.test.js \
  extensions/watchdog/tests/retry-suspend-crash-recovery.test.js \
  extensions/watchdog/tests/retry-suspend-router.test.js \
  extensions/watchdog/tests/conveyor.test.js \
  extensions/watchdog/tests/control-plane-worker-state-consumers.test.js
```

Expected: PASS with no remaining active references to `stage-context.js` or `worker-runtime-state.js`.

- [ ] **Step 3: Run one smoke command through the real runtime surface**

Run:

```bash
cd /Users/hakens/.openclaw
node extensions/watchdog/test-runner.js --preset single
```

Expected: the runner starts normally, no startup import error mentions `stage-context.js` or `worker-runtime-state.js`, and dispatch/runtime boot completes.

- [ ] **Step 4: Commit the verification sweep**

```bash
cd /Users/hakens/.openclaw
git add \
  extensions/watchdog/tests/context-sidechannel-retirement.test.js \
  extensions/watchdog/tests/control-plane-worker-state-consumers.test.js
git commit -m "test: guard retired context and dispatch state residues"
```

## Spec Coverage Self-Review

- `context.json` retired from active runtime: Task 1 and Task 2 cover runtime test freeze, archive move, active import removal, and runtime behavior change.
- Legacy mechanism preserved but isolated: Task 2 archives the implementation under `lib/legacy/` and Task 4 guards against production imports.
- Single dispatch owner: Task 3 introduces `dispatch-runtime-state.js` and migrates consumers.
- Graph-router becomes routing-only: Task 3 removes `busyAgents` / `agentQueues` and rewires to canonical APIs.
- Role-aware wake preserved: Task 2 removes context sidechannel only; it does not trim role-specific wake behavior.
- Cross-runtime verification: Task 4 adds residual guards and runs a real CLI smoke path.

## Placeholder Self-Review

- No `TODO`, `TBD`, or “implement later” markers remain.
- Every task names exact files, concrete commands, expected outcomes, and commit messages.
- Later tasks reference APIs introduced in earlier tasks with matching names.

