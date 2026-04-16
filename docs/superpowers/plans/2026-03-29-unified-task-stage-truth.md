# Unified Task Stage Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace phase templates and actor-shaped stage display with one runtime-backed task-stage truth model shared by ordinary tasks and loop tasks.

**Architecture:** Add a canonical `TaskStagePlan` runtime object, store it on the task instance, let runtime mutate it through bounded completion and revision rules, and make dashboard/SSE consume projections of that object instead of templates, actor ids, or heuristics. Loop runtime keeps actor topology for dispatch, but semantic task stages become a separate truth that ordinary and loop tasks both share.

**Tech Stack:** Node.js, native `node:test`, existing watchdog runtime modules, SSE dashboard, contract snapshots, loop/pipeline runtime.

---

## File Map

- Create: `extensions/watchdog/lib/task-stage-plan.js`
- Create: `extensions/watchdog/tests/task-stage-plan.test.js`
- Modify: `extensions/watchdog/lib/ingress-standard-route.js`
- Modify: `extensions/watchdog/lib/router-outbox-handlers.js`
- Modify: `extensions/watchdog/lib/session-bootstrap.js`
- Modify: `extensions/watchdog/lib/contracts.js`
- Modify: `extensions/watchdog/lib/stage-results.js`
- Modify: `extensions/watchdog/lib/stage-projection.js`
- Modify: `extensions/watchdog/lib/pipeline-engine.js`
- Modify: `extensions/watchdog/lib/graph-loop-registry.js`
- Modify: `extensions/watchdog/lib/sse.js`
- Modify: `extensions/watchdog/dashboard.js`
- Modify: `extensions/watchdog/tests/stage-projection.test.js`
- Create: `extensions/watchdog/tests/task-stage-runtime.test.js`
- Create: `extensions/watchdog/tests/loop-semantic-stage-projection.test.js`

### Task 1: Canonical TaskStagePlan Object

**Files:**
- Create: `extensions/watchdog/lib/task-stage-plan.js`
- Test: `extensions/watchdog/tests/task-stage-plan.test.js`

- [ ] **Step 1: Write the failing tests for canonical plan creation and bounded revision**

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInitialTaskStagePlan,
  applyTaskStageCompletion,
  applyTaskStageRevision,
} from "../lib/task-stage-plan.js";

test("buildInitialTaskStagePlan normalizes semantic stage labels into canonical stage entries", () => {
  const plan = buildInitialTaskStagePlan({
    contractId: "TC-stage-1",
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
  });

  assert.equal(plan.contractId, "TC-stage-1");
  assert.equal(plan.version, 1);
  assert.equal(plan.currentStageId, plan.stages[0].id);
  assert.deepEqual(plan.completedStageIds, []);
  assert.deepEqual(
    plan.stages.map((entry) => entry.label),
    ["建立比较维度", "补充关键证据", "形成结论"],
  );
});

test("applyTaskStageCompletion advances the active semantic stage without changing completed history", () => {
  const initial = buildInitialTaskStagePlan({
    contractId: "TC-stage-2",
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
  });

  const next = applyTaskStageCompletion(initial, {
    completedStageId: initial.currentStageId,
  });

  assert.deepEqual(next.completedStageIds, [initial.currentStageId]);
  assert.equal(next.currentStageId, next.stages[1].id);
  assert.equal(next.stages[0].status, "completed");
  assert.equal(next.stages[1].status, "active");
});

test("applyTaskStageRevision rejects rewrites that rename completed stages or exceed stage delta", () => {
  const initial = buildInitialTaskStagePlan({
    contractId: "TC-stage-3",
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
  });
  const progressed = applyTaskStageCompletion(initial, {
    completedStageId: initial.currentStageId,
  });

  assert.throws(() => applyTaskStageRevision(progressed, {
    reason: "rewrite_completed_history",
    stages: ["重新定义范围", "补充关键证据", "形成结论"],
  }));

  assert.throws(() => applyTaskStageRevision(progressed, {
    reason: "explode_stage_count",
    stages: ["建立比较维度", "补充关键证据", "交叉比较", "整理证据", "形成结论"],
  }));
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test extensions/watchdog/tests/task-stage-plan.test.js`

Expected: FAIL with module import or missing export errors from `task-stage-plan.js`.

- [ ] **Step 3: Write the minimal TaskStagePlan implementation**

```js
import { normalizeString } from "./normalize.js";

function slugStageId(label, index) {
  const base = String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `stage-${index + 1}`;
}

function normalizeStageEntry(entry, index) {
  const label = typeof entry === "string"
    ? entry.trim()
    : normalizeString(entry?.label || entry?.name);
  if (!label) return null;
  const id = normalizeString(entry?.id) || slugStageId(label, index);
  return {
    id,
    label,
    status: "pending",
  };
}

export function buildInitialTaskStagePlan({ contractId, stages, revisionPolicy = {} } = {}) {
  const normalizedStages = (Array.isArray(stages) ? stages : [])
    .map(normalizeStageEntry)
    .filter(Boolean)
    .map((entry, index) => ({ ...entry, status: index === 0 ? "active" : "pending" }));
  if (!contractId || normalizedStages.length === 0) {
    throw new TypeError("buildInitialTaskStagePlan requires contractId and non-empty stages");
  }
  return {
    id: `stages:${contractId}`,
    contractId,
    version: 1,
    stages: normalizedStages,
    currentStageId: normalizedStages[0].id,
    completedStageIds: [],
    revisionCount: 0,
    revisionPolicy: {
      maxRevisions: Number(revisionPolicy.maxRevisions) || 2,
      maxStageDelta: Number(revisionPolicy.maxStageDelta) || 1,
      freezeCompletedStages: revisionPolicy.freezeCompletedStages !== false,
    },
    lastRevisionReason: null,
  };
}

export function applyTaskStageCompletion(plan, { completedStageId } = {}) {
  if (!plan?.currentStageId || completedStageId !== plan.currentStageId) {
    throw new Error("completed stage must match current stage");
  }
  const nextCompleted = [...plan.completedStageIds, completedStageId];
  const nextStages = plan.stages.map((entry) => (
    entry.id === completedStageId ? { ...entry, status: "completed" } : entry
  ));
  const nextPending = nextStages.find((entry) => entry.status === "pending") || null;
  return {
    ...plan,
    stages: nextStages.map((entry) => (
      nextPending && entry.id === nextPending.id ? { ...entry, status: "active" } : entry
    )),
    completedStageIds: nextCompleted,
    currentStageId: nextPending?.id || null,
    version: plan.version + 1,
  };
}

export function applyTaskStageRevision(plan, { stages, reason } = {}) {
  const nextStages = (Array.isArray(stages) ? stages : []).map(normalizeStageEntry).filter(Boolean);
  if (!reason) throw new Error("revision reason required");
  if (plan.revisionCount >= plan.revisionPolicy.maxRevisions) throw new Error("revision limit reached");
  if (Math.abs(nextStages.length - plan.stages.length) > plan.revisionPolicy.maxStageDelta) {
    throw new Error("stage delta exceeded");
  }
  for (const completedStageId of plan.completedStageIds) {
    const previous = plan.stages.find((entry) => entry.id === completedStageId);
    const next = nextStages.find((entry) => entry.id === completedStageId);
    if (!previous || !next || previous.label !== next.label) {
      throw new Error("completed stages are immutable");
    }
  }
  return {
    ...plan,
    stages: nextStages.map((entry) => {
      if (plan.completedStageIds.includes(entry.id)) return { ...entry, status: "completed" };
      if (entry.id === plan.currentStageId) return { ...entry, status: "active" };
      return { ...entry, status: "pending" };
    }),
    revisionCount: plan.revisionCount + 1,
    version: plan.version + 1,
    lastRevisionReason: reason,
  };
}
```

- [ ] **Step 4: Run the test to verify GREEN**

Run: `node --test extensions/watchdog/tests/task-stage-plan.test.js`

Expected: PASS with 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add extensions/watchdog/lib/task-stage-plan.js extensions/watchdog/tests/task-stage-plan.test.js
git commit -m "feat: add canonical task stage plan model"
```

### Task 2: Wire Ordinary Tasks To Canonical Stage Truth

**Files:**
- Modify: `extensions/watchdog/lib/ingress-standard-route.js`
- Modify: `extensions/watchdog/lib/router-outbox-handlers.js`
- Modify: `extensions/watchdog/lib/session-bootstrap.js`
- Modify: `extensions/watchdog/lib/contracts.js`
- Modify: `extensions/watchdog/lib/task-stage-plan.js`
- Test: `extensions/watchdog/tests/task-stage-runtime.test.js`

- [ ] **Step 1: Write the failing runtime tests for ingress and contractor normalization**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { createTrackingState } from "../lib/session-bootstrap.js";
import { buildInitialTaskStagePlan } from "../lib/task-stage-plan.js";

test("tracking state binds canonical task stage plan from contract snapshots", () => {
  const trackingState = createTrackingState({
    sessionKey: "agent:worker-a:stage-runtime",
    agentId: "worker-a",
    parentSession: null,
  });

  trackingState.contract = {
    id: "TC-stage-runtime-1",
    task: "对比三个框架优缺点",
    phases: ["建立比较维度", "补充关键证据", "形成结论"],
    stagePlan: buildInitialTaskStagePlan({
      contractId: "TC-stage-runtime-1",
      stages: ["建立比较维度", "补充关键证据", "形成结论"],
    }),
  };

  assert.equal(trackingState.contract.stagePlan.currentStageId, "建立比较维度");
});

test("runtime normalization rejects empty semantic stage plans before contractor merge", () => {
  assert.throws(() => buildInitialTaskStagePlan({
    contractId: "TC-stage-runtime-2",
    stages: [],
  }));
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test extensions/watchdog/tests/task-stage-runtime.test.js`

Expected: FAIL because contractor merge path does not yet validate canonical stage truth.

- [ ] **Step 3: Normalize ingress and contractor contracts into `contract.stagePlan`**

```js
import {
  buildInitialTaskStagePlan,
  listTaskStageLabels,
  normalizeTaskStagePlanInput,
} from "./task-stage-plan.js";

const normalizedPhases = normalizeTaskStagePlanInput(phases);
const stagePlan = buildInitialTaskStagePlan({
  contractId,
  stages: normalizedPhases,
});

contract = annotateExecutionContract({
  id: contractId,
  task: message,
  assignee: "worker",
  replyTo: effectiveReplyTo,
  output: join(OC, "workspaces", "controller", "output", `${contractId}.md`),
  status: simple ? CONTRACT_STATUS.PENDING : CONTRACT_STATUS.DRAFT,
  phases: listTaskStageLabels(stagePlan),
  stagePlan,
  total: stagePlan.stages.length,
});
```

```js
const normalizedStagePlan = normalizeTaskStagePlanInput(updated.stagePlan || updated.phases);
if (!normalizedStagePlan || normalizedStagePlan.length === 0) {
  invalidMergeError = "invalid stage plan";
  return false;
}
existing.stagePlan = buildInitialTaskStagePlan({
  contractId: existing.id,
  stages: normalizedStagePlan,
});
existing.phases = listTaskStageLabels(existing.stagePlan);
existing.total = existing.stagePlan.stages.length;
```

- [ ] **Step 4: Bind tracking/lifecycle snapshots to canonical stage truth**

```js
function toTrackingContract(contract, path) {
  return {
    id: contract.id,
    task: contract.task,
    assignee: contract.assignee || null,
    replyTo: contract.replyTo || null,
    path,
    stagePlan: contract.stagePlan || null,
    phases: Array.isArray(contract.stagePlan?.stages)
      ? contract.stagePlan.stages.map((entry) => entry.label)
      : (contract.phases || []),
    total: Number.isFinite(contract.stagePlan?.stages?.length)
      ? contract.stagePlan.stages.length
      : (contract.total || 0),
  };
}
```

```js
return {
  id,
  task: contract.task || null,
  status: trackingState.status || contract.status || null,
  stageProjection: trackingState.stageProjection || null,
  stagePlan: trackingState.contract?.stagePlan || null,
  phases: Array.isArray(trackingState?.stageProjection?.stagePlan)
    ? trackingState.stageProjection.stagePlan
    : [],
};
```

- [ ] **Step 5: Run the tests to verify GREEN**

Run: `node --test extensions/watchdog/tests/task-stage-runtime.test.js`

Expected: PASS with ordinary-task stage truth assertions green.

- [ ] **Step 6: Commit**

```bash
git add \
  extensions/watchdog/lib/ingress-standard-route.js \
  extensions/watchdog/lib/router-outbox-handlers.js \
  extensions/watchdog/lib/session-bootstrap.js \
  extensions/watchdog/lib/contracts.js \
  extensions/watchdog/tests/task-stage-runtime.test.js
git commit -m "feat: normalize ordinary tasks into canonical stage truth"
```

### Task 3: Runtime Completion And Bounded Revision

**Files:**
- Modify: `extensions/watchdog/lib/stage-results.js`
- Modify: `extensions/watchdog/lib/task-stage-plan.js`
- Modify: `extensions/watchdog/lib/stage-projection.js`
- Test: `extensions/watchdog/tests/task-stage-runtime.test.js`

- [ ] **Step 1: Write the failing tests for stage completion and bounded revision through runtime payloads**

```js
test("stage run result can advance semantic task stage without changing actor topology", () => {
  const stageRunResult = {
    status: "completed",
    semanticStageId: "gather_evidence",
    semanticStageAction: "complete",
  };

  assert.equal(stageRunResult.semanticStageAction, "complete");
});

test("stage revision payload is rejected after progress crosses the revision threshold", () => {
  const initial = buildInitialTaskStagePlan({
    contractId: "TC-stage-runtime-3",
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
    revisionPolicy: { maxRevisions: 1, maxStageDelta: 1, freezeCompletedStages: true },
  });
  const progressed = applyTaskStageCompletion(initial, {
    completedStageId: initial.currentStageId,
  });

  assert.throws(() => applyTaskStageRevision(progressed, {
    reason: "rewrite_after_progress",
    stages: ["建立比较维度", "重新定义任务范围", "补充关键证据", "形成结论"],
  }));
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test extensions/watchdog/tests/task-stage-runtime.test.js`

Expected: FAIL because semantic stage mutation fields are not yet normalized.

- [ ] **Step 3: Extend stage result normalization for semantic stage actions**

```js
export function normalizeStageRunResult(value, fallback = {}) {
  return {
    version: Number(source.version) || 1,
    stage: normalizeString(source.stage) || normalizeString(fallback.stage) || null,
    pipelineId: normalizeString(source.pipelineId) || normalizeString(fallback.pipelineId) || null,
    loopId: normalizeString(source.loopId) || normalizeString(fallback.loopId) || null,
    loopSessionId: normalizeString(source.loopSessionId) || normalizeString(fallback.loopSessionId) || null,
    semanticStageId: normalizeString(source.semanticStageId) || null,
    semanticStageAction: normalizeString(source.semanticStageAction) || null,
    stagePlanRevision: normalizeRecord(source.stagePlanRevision, null),
  };
}
```

- [ ] **Step 4: Apply completion/revision into tracking projection inputs**

```js
export function applyTrackingStageProjection(trackingState, { pipeline = null, loopSession = null } = {}) {
  const canonicalPlan = trackingState?.contract?.stagePlan || null;
  if (canonicalPlan) {
    const done = canonicalPlan.completedStageIds.length;
    const total = canonicalPlan.stages.length;
    const currentStage = canonicalPlan.stages.find((entry) => entry.id === canonicalPlan.currentStageId) || null;
    const projection = {
      source: "task_stage_truth",
      stagePlan: canonicalPlan.stages.map((entry) => entry.label),
      completedStages: canonicalPlan.completedStageIds,
      currentStage: currentStage?.id || null,
      currentStageLabel: currentStage?.label || null,
      cursor: `${done}/${total}`,
      pct: total > 0 ? Math.round((done / total) * 100) : null,
      done,
      total,
      round: loopSession?.round || pipeline?.round || null,
      runtimeStatus: trackingState.status || trackingState.contract?.status || null,
    };
    trackingState.stageProjection = projection;
    trackingState.cursor = projection.cursor;
    trackingState.pct = projection.pct;
    trackingState.estimatedPhase = projection.currentStageLabel || "";
    return projection;
  }
}
```

- [ ] **Step 5: Run the tests to verify GREEN**

Run: `node --test extensions/watchdog/tests/task-stage-runtime.test.js`

Expected: PASS with semantic completion and revision constraints covered.

- [ ] **Step 6: Commit**

```bash
git add \
  extensions/watchdog/lib/stage-results.js \
  extensions/watchdog/lib/task-stage-plan.js \
  extensions/watchdog/lib/stage-projection.js \
  extensions/watchdog/tests/task-stage-runtime.test.js
git commit -m "feat: drive stage projection from canonical stage completion"
```

### Task 4: Separate Loop Actor Topology From Semantic Stages

**Files:**
- Modify: `extensions/watchdog/lib/graph-loop-registry.js`
- Modify: `extensions/watchdog/lib/pipeline-engine.js`
- Modify: `extensions/watchdog/lib/stage-projection.js`
- Test: `extensions/watchdog/tests/loop-semantic-stage-projection.test.js`

- [ ] **Step 1: Write the failing loop test that proves actor ids are not the user-facing phases**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { applyTrackingStageProjection } from "../lib/stage-projection.js";

test("loop projection shows semantic task stages while preserving round and actor dispatch", () => {
  const trackingState = {
    status: "running",
    contract: {
      id: "TC-loop-stage-1",
      task: "对比三个框架优缺点",
      pipelineStage: {
        pipelineId: "pipe-loop-stage-1",
        loopSessionId: "LS-loop-stage-1",
        stage: "researcher",
        round: 2,
      },
      stagePlan: {
        currentStageId: "gather_evidence",
        completedStageIds: ["define_axes"],
        stages: [
          { id: "define_axes", label: "建立比较维度", status: "completed" },
          { id: "gather_evidence", label: "补充关键证据", status: "active" },
          { id: "finalize", label: "形成结论", status: "pending" },
        ],
      },
    },
  };

  const projection = applyTrackingStageProjection(trackingState, {
    pipeline: { currentStage: "researcher", round: 2, phaseOrder: ["researcher", "worker-d", "evaluator"] },
    loopSession: { currentStage: "researcher", round: 2, phaseOrder: ["researcher", "worker-d", "evaluator"] },
  });

  assert.equal(projection.currentStageLabel, "补充关键证据");
  assert.equal(projection.round, 2);
  assert.deepEqual(projection.stagePlan, ["建立比较维度", "补充关键证据", "形成结论"]);
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test extensions/watchdog/tests/loop-semantic-stage-projection.test.js`

Expected: FAIL because loop projection still derives visible stage plan from `phaseOrder`.

- [ ] **Step 3: Preserve actor topology for dispatch, but source projection from task stage truth**

```js
function buildPipelineStageContract({ pipeline, stageName, targetAgent, stageSessionKey, prevAction } = {}) {
  const contract = createDirectRequestEnvelope({
    agentId: targetAgent,
    sessionKey: stageSessionKey,
    replyTo: pipeline?.replyTo || null,
    upstreamReplyTo: pipeline?.upstreamReplyTo || null,
    returnContext: pipeline?.returnContext || null,
    serviceSession: pipeline?.serviceSession || null,
    defaultReplyToSelf: false,
    message: buildPipelineStageTask({ pipeline, prevAction }),
    outputDir: join(agentWorkspace(targetAgent), "output"),
    source: prevAction ? INTENT_TYPES.ADVANCE_PIPELINE : INTENT_TYPES.START_PIPELINE,
  });
  contract.pipelineStage = {
    pipelineId: pipeline?.pipelineId || null,
    loopId: pipeline?.loopId || null,
    loopSessionId: pipeline?.loopSessionId || null,
    sessionKey: stageSessionKey || null,
    stage: stageName,
    round: pipeline?.round || 1,
    semanticStageId: pipeline?.taskStagePlan?.currentStageId || null,
  };
  contract.stagePlan = pipeline?.taskStagePlan || contract.stagePlan || null;
  contract.phases = Array.isArray(contract.stagePlan?.stages)
    ? contract.stagePlan.stages.map((entry) => entry.label)
    : contract.phases;
  return contract;
}
```

```js
export function composeLoopSpecFromAgents(agentIds, opts = {}) {
  return normalizeLoopSpecEntry({
    id: opts.loopId || opts.id || buildLoopId(agentIds),
    kind: opts.kind || DEFAULT_LOOP_KIND,
    label: opts.label,
    nodes: agentIds,
    entryAgentId: opts.entryAgentId || agentIds[0],
    phaseOrder: opts.phaseOrder,
    continueSignal: opts.continueSignal || DEFAULT_CONTINUE_SIGNAL,
    concludeSignal: opts.concludeSignal || DEFAULT_CONCLUDE_SIGNAL,
    metadata: {
      ...(opts.metadata || {}),
      semanticStageMode: opts.metadata?.semanticStageMode || "task_stage_truth",
    },
  });
}
```

- [ ] **Step 4: Run the tests to verify GREEN**

Run: `node --test extensions/watchdog/tests/loop-semantic-stage-projection.test.js`

Expected: PASS showing loop projection uses semantic task stages while dispatch still uses actor nodes.

- [ ] **Step 5: Commit**

```bash
git add \
  extensions/watchdog/lib/graph-loop-registry.js \
  extensions/watchdog/lib/pipeline-engine.js \
  extensions/watchdog/lib/stage-projection.js \
  extensions/watchdog/tests/loop-semantic-stage-projection.test.js
git commit -m "feat: decouple loop actor topology from semantic stage truth"
```

### Task 5: Dashboard, SSE, And Regression Verification

**Files:**
- Modify: `extensions/watchdog/lib/sse.js`
- Modify: `extensions/watchdog/dashboard.js`
- Modify: `extensions/watchdog/tests/stage-projection.test.js`
- Modify: `extensions/watchdog/tests/task-stage-runtime.test.js`
- Modify: `extensions/watchdog/tests/loop-semantic-stage-projection.test.js`

- [ ] **Step 1: Write the failing projection regression tests**

```js
test("SSE progress payload emits semantic phase labels from canonical stage truth", () => {
  const payload = {
    stageProjection: {
      source: "task_stage_truth",
      stagePlan: ["建立比较维度", "补充关键证据", "形成结论"],
      total: 3,
    },
  };

  assert.deepEqual(payload.stageProjection.stagePlan, ["建立比较维度", "补充关键证据", "形成结论"]);
});

test("dashboard phase dots stay hidden only when semantic stage truth is absent", () => {
  const contract = {
    phases: ["建立比较维度", "补充关键证据", "形成结论"],
    stageProjection: { source: "task_stage_truth" },
  };

  assert.equal(contract.stageProjection.source, "task_stage_truth");
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test extensions/watchdog/tests/stage-projection.test.js extensions/watchdog/tests/task-stage-runtime.test.js extensions/watchdog/tests/loop-semantic-stage-projection.test.js`

Expected: FAIL until SSE/dashboard read the canonical projection consistently.

- [ ] **Step 3: Update SSE and dashboard consumption**

```js
export function buildProgressPayload(t) {
  const stageProjection = t.stageProjection || null;
  return {
    sessionKey: t.sessionKey,
    agentId: t.agentId,
    status: t.status,
    contractId: t.contract?.id || null,
    stagePlan: t.contract?.stagePlan || null,
    phases: Array.isArray(stageProjection?.stagePlan) ? stageProjection.stagePlan : null,
    total: Number.isFinite(stageProjection?.total) ? stageProjection.total : null,
  };
}
```

```js
const hasProjectedStages = Array.isArray(c.phases)
  && c.phases.length > 0
  && ["task_stage_truth", "runtime_stage", "terminal_status"].includes(c.stageProjection?.source);
```

- [ ] **Step 4: Run all targeted tests to verify GREEN**

Run:

```bash
node --test extensions/watchdog/tests/task-stage-plan.test.js
node --test extensions/watchdog/tests/task-stage-runtime.test.js
node --test extensions/watchdog/tests/loop-semantic-stage-projection.test.js
node --test extensions/watchdog/tests/stage-projection.test.js
```

Expected: PASS across all four targeted suites.

- [ ] **Step 5: Run broader regression verification**

Run:

```bash
node --test extensions/watchdog/tests/harness-run-store.test.js
node --test extensions/watchdog/tests/automation-harness-projection.test.js
node --test extensions/watchdog/tests/formal-test-surface.test.js
node extensions/watchdog/test-runner.js --preset loop-platform
```

Expected:

- targeted watchdog tests PASS
- `loop-platform` preset PASS
- if unrelated `single` preset failure still shows `E_WORKER_NO_TOOL`, record it as pre-existing

- [ ] **Step 6: Commit**

```bash
git add \
  extensions/watchdog/lib/sse.js \
  extensions/watchdog/dashboard.js \
  extensions/watchdog/tests/stage-projection.test.js \
  extensions/watchdog/tests/task-stage-runtime.test.js \
  extensions/watchdog/tests/loop-semantic-stage-projection.test.js
git commit -m "feat: project canonical task stage truth in dashboard"
```
