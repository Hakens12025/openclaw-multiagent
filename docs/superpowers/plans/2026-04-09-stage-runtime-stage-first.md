# Stage Runtime Stage-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split runtime progress out of `contract.stagePlan` by making `stagePlan` definition-only and introducing `stageRuntime` as the authoritative runtime progress object.

**Architecture:** Keep canonical `stagePlan` as the shared definition spine across ingress, tracker, SSE, and lifecycle views. Move `currentStageId`, `completedStageIds`, and runtime mutation logic into a dedicated `stageRuntime` layer, then derive `stageProjection` only from `stagePlan + stageRuntime + terminal status`.

**Tech Stack:** Node.js, built-in `node:test`, OpenClaw watchdog runtime modules

---

### Task 1: Lock the New Stage Truth Contract in Tests

**Files:**
- Modify: `extensions/watchdog/tests/task-stage-plan.test.js`
- Modify: `extensions/watchdog/tests/task-stage-runtime.test.js`
- Modify: `extensions/watchdog/tests/stage-projection.test.js`

- [ ] **Step 1: Write the failing plan-shape test**

```js
test("buildInitialTaskStagePlan returns a definition-only canonical plan", () => {
  const plan = buildInitialTaskStagePlan({
    contractId: "TC-stage-1",
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
  });

  assert.equal(plan.contractId, "TC-stage-1");
  assert.equal(plan.version, 1);
  assert.ok(!("currentStageId" in plan));
  assert.ok(!("completedStageIds" in plan));
  assert.deepEqual(
    plan.stages.map((entry) => ({ id: entry.id, label: entry.label })),
    [
      { id: "stage-1", label: "建立比较维度" },
      { id: "stage-2", label: "补充关键证据" },
      { id: "stage-3", label: "形成结论" },
    ],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/task-stage-plan.test.js
```

Expected: FAIL because the current implementation still exposes `currentStageId` and `completedStageIds` on `stagePlan`.

- [ ] **Step 3: Write the failing runtime-shape test**

```js
test("bindInboxContractEnvelope maps stageRuntime separately from definition-only stagePlan", async () => {
  // contract fixture should contain:
  // stagePlan: definition-only plan
  // stageRuntime: { currentStageId: "stage-1", completedStageIds: [] }
  // expectation: trackingState.contract.stagePlan has no runtime fields
  // expectation: trackingState.contract.stageRuntime.currentStageId === "stage-1"
});
```

- [ ] **Step 4: Run test to verify it fails**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/task-stage-runtime.test.js
```

Expected: FAIL because `session-bootstrap` does not yet preserve separate `stageRuntime`.

- [ ] **Step 5: Write the failing projection test**

```js
test("applyTrackingStageProjection derives progress from stageRuntime instead of mutating stagePlan", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:worker:projection",
    agentId: "worker",
    parentSession: null,
  });

  trackingState.contract = {
    id: "TC-STAGE-PROJECTION",
    task: "planner stage projection",
    status: CONTRACT_STATUS.RUNNING,
    stagePlan: materializeTaskStagePlan({
      contractId: "TC-STAGE-PROJECTION",
      phases: ["收集证据", "交叉比较", "形成结论"],
    }),
    stageRuntime: {
      version: 1,
      currentStageId: "stage-2",
      completedStageIds: ["stage-1"],
      revisionCount: 0,
      lastRevisionReason: null,
    },
  };

  const projection = applyTrackingStageProjection(trackingState);
  assert.deepEqual(projection.completedStages, ["收集证据"]);
  assert.equal(projection.currentStage, "stage-2");
  assert.equal(projection.currentStageLabel, "交叉比较");
});
```

- [ ] **Step 6: Run test to verify it fails**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/stage-projection.test.js
```

Expected: FAIL because `stage-projection` still mutates `stagePlan` from `stageRunResult`.

---

### Task 2: Implement Definition-Only `stagePlan` and New `stageRuntime`

**Files:**
- Modify: `extensions/watchdog/lib/task-stage-plan.js`
- Modify: `extensions/watchdog/lib/session-bootstrap.js`
- Modify: `extensions/watchdog/lib/lifecycle-stage-truth.js`

- [ ] **Step 1: Add `stageRuntime` helpers and strip runtime fields from canonical plans**

```js
export function buildInitialTaskStageRuntime({ stagePlan } = {}) {
  const firstStageId = Array.isArray(stagePlan?.stages) ? stagePlan.stages[0]?.id || null : null;
  return {
    version: 1,
    currentStageId: firstStageId,
    completedStageIds: [],
    revisionCount: 0,
    lastRevisionReason: null,
  };
}

function normalizeTaskStagePlan(plan, { contractId = null, revisionPolicy = null } = {}) {
  // keep only definition fields on the returned plan
}

export function normalizeTaskStageRuntime(runtime, stagePlan) {
  // clamp currentStageId and completedStageIds to the current plan
}
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/task-stage-plan.test.js
```

Expected: plan-shape tests pass, runtime-shape tests still fail elsewhere.

- [ ] **Step 3: Thread `stageRuntime` through bootstrap and lifecycle truth**

```js
const stagePlan = materializeTaskStagePlan({ ... });
const stageRuntime = materializeTaskStageRuntime({
  contractId: contract.id,
  stagePlan,
  stageRuntime: contract.stageRuntime,
  stageRunResult: contract.stageRunResult,
});

const trackingContract = {
  // ...
  stagePlan,
  stageRuntime,
  phases: deriveCompatibilityPhases(stagePlan),
  total: deriveCompatibilityTotal(stagePlan),
};
```

- [ ] **Step 4: Run runtime-shape tests**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/task-stage-runtime.test.js
```

Expected: bootstrap/lifecycle tests move to green; projection tests still fail.

---

### Task 3: Move Projection Logic to `stageRuntime`

**Files:**
- Modify: `extensions/watchdog/lib/stage-projection.js`
- Modify: `extensions/watchdog/lib/transport/sse.js`
- Modify: `extensions/watchdog/lib/contract-lifecycle-view.js`

- [ ] **Step 1: Replace plan mutation projection with runtime-backed projection**

```js
function buildStagePlanProjection(trackingState, contract) {
  const canonicalPlan = materializeTaskStagePlan({ ... });
  const stageRuntime = materializeTaskStageRuntime({
    contractId: contract?.id || null,
    stagePlan: canonicalPlan,
    stageRuntime: contract?.stageRuntime,
    stageRunResult: contract?.stageRunResult,
  });

  const completedSet = new Set(stageRuntime?.completedStageIds || []);
  const currentStageId = stageRuntime?.currentStageId || null;
  // derive projection from plan + runtime only
}
```

- [ ] **Step 2: Keep terminal behavior explicit**

```js
if (trackingState.status === CONTRACT_STATUS.COMPLETED && completedSet.size === 0) {
  // terminal fallback remains projection-only, not a write-back into stagePlan/stageRuntime
}
```

- [ ] **Step 3: Run focused projection tests**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/stage-projection.test.js
```

Expected: projection tests pass with `stageRuntime` inputs.

- [ ] **Step 4: Run the full stage runtime suite**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/task-stage-runtime.test.js
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/task-stage-plan.test.js
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/stage-projection.test.js
```

Expected: all three files PASS.

---

### Task 4: Update Producers to Stop Re-collapsing Plan Semantics

**Files:**
- Modify: `extensions/watchdog/lib/lifecycle/agent-end-pipeline.js`

- [ ] **Step 1: Preserve rich stage definition when writing stage plans back**

```js
const rawPlan = buildStagePlanFromMarkers(context._outputContent);
const stagePlan = rawPlan?.stages?.length > 0
  ? materializeTaskStagePlan({ contractId, stagePlan: { stages: rawPlan.stages } })
  : null;
```

- [ ] **Step 2: Run the stage runtime suite again**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/task-stage-runtime.test.js
```

Expected: PASS with no regression in marker-backed stage plan behavior.

---

### Task 5: Verify End-to-End Stage Truth Consumers

**Files:**
- Modify: `extensions/watchdog/tests/task-stage-runtime.test.js`
- Modify: `extensions/watchdog/tests/dashboard-stage-visibility.test.js` (if needed)

- [ ] **Step 1: Add or update a lifecycle/SSE assertion**

```js
assert.deepEqual(payload.stagePlan.stages.map((entry) => entry.label), ["收集证据", "交叉比较", "形成结论"]);
assert.equal(payload.stageRuntime.currentStageId, "stage-2");
```

- [ ] **Step 2: Run the end-to-end consumer tests**

Run:

```bash
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/task-stage-runtime.test.js
node --test /Users/hakens/.openclaw/extensions/watchdog/tests/dashboard-stage-visibility.test.js
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git -C /Users/hakens/.openclaw add \
  docs/superpowers/plans/2026-04-09-stage-runtime-stage-first.md \
  extensions/watchdog/lib/task-stage-plan.js \
  extensions/watchdog/lib/session-bootstrap.js \
  extensions/watchdog/lib/lifecycle-stage-truth.js \
  extensions/watchdog/lib/stage-projection.js \
  extensions/watchdog/lib/transport/sse.js \
  extensions/watchdog/lib/contract-lifecycle-view.js \
  extensions/watchdog/lib/lifecycle/agent-end-pipeline.js \
  extensions/watchdog/tests/task-stage-plan.test.js \
  extensions/watchdog/tests/task-stage-runtime.test.js \
  extensions/watchdog/tests/stage-projection.test.js
git -C /Users/hakens/.openclaw commit -m "refactor: split stage runtime truth from stage plan"
```

---

## Self-Review

- Spec coverage: this plan covers the selected `Stage-first` slice only: definition-only `stagePlan`, new `stageRuntime`, and projection/lifecycle consumer migration. It intentionally leaves `ExecutionObservation` and `TerminalOutcome` for the next slice.
- Placeholder scan: no `TODO` / `TBD` placeholders remain; each task names exact files and commands.
- Type consistency: `stagePlan`, `stageRuntime`, and projection consumers all use the same names across tasks.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-09-stage-runtime-stage-first.md`. The user already asked to start work immediately, so this session will execute the plan inline.
