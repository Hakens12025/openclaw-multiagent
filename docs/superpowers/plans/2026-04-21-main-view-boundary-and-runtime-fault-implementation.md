# Main View Boundary And Runtime Fault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove control-plane actors from the main runtime role line, keep `operator` as a hidden control-plane agent, and replace timeout-shaped mixed failures with one runtime-owned incident and fault taxonomy.

**Architecture:** Add one runtime-owned actor classification authority that threads through effective profiles, SSE tracking payloads, dashboard consumers, and test timelines. Then add one runtime-owned incident store plus one fault evaluator so runtime, harness, CLI system, operator, and automation all read the same failure truth instead of inventing parallel diagnoses.

**Tech Stack:** Node.js, watchdog runtime modules, dashboard ES modules, SSE/test harness, operator snapshot surfaces, node:test

---

## File Structure

- `extensions/watchdog/lib/agent/agent-plane-policy.js`
  Runtime-owned actor classification authority. Resolves `plane`, `mainViewVisible`, `formalTimelineVisible`, and `autoWakeEligible`.
- `extensions/watchdog/lib/effective-profile-composer.js`
  Threads actor classification into effective profiles returned by `/watchdog/agents`.
- `extensions/watchdog/lib/store/tracker-store.js`
  Adds actor-visibility fields to tracking snapshots/SSE payload inputs.
- `extensions/watchdog/dashboard.js`
  Consumes runtime actor classification for pipeline aggregation and display.
- `extensions/watchdog/dashboard-agents.js`
  Filters the main roster to runtime-visible actors only.
- `extensions/watchdog/tests/dashboard-stage-visibility.test.js`
  Guards main-view visibility semantics.
- `extensions/watchdog/tests/suite-single.js`
  Black-box formal test timeline collector; must stop recording hidden control-plane actor sessions as main-line events.
- `extensions/watchdog/lib/agent/agent-activation-policy.js`
  Runtime-owned gate for whether an actor can be auto-woken from ordinary task execution.
- `extensions/watchdog/lib/transport/runtime-wake-transport.js`
  Enforces control-plane activation policy before hooks/heartbeat wake.
- `extensions/watchdog/lib/routing/delivery-system-action-transport.js`
  Prevents delivery recovery from escalating ordinary task execution into control-plane activation.
- `extensions/watchdog/lib/runtime/execution-incident-store.js`
  Durable incident owner for runtime faults and terminal diagnosis.
- `extensions/watchdog/lib/runtime/runtime-fault-evaluator.js`
  Evidence-driven evaluator for `tool_failure`, `retryable_runtime_failure`, `interaction_block`, `llm_fault`, `system_fault`, and `mixed_fault`.
- `extensions/watchdog/lib/store/execution-trace-store.js`
  Supplies stable evidence for repeated-truth-read, no-progress, and tool-loop classification.
- `extensions/watchdog/hooks/after-tool-call.js`
  Writes runtime evidence into the fault evaluator and incident store.
- `extensions/watchdog/lib/lifecycle/agent-end-terminal.js`
  Commits incident-backed termination reasons instead of only generic timeout/failure summaries.
- `extensions/watchdog/lib/operator/operator-snapshot-runtime.js`
  Projects incident truth into operator snapshot attention/runtime summaries.
- `extensions/watchdog/tests/*`
  New/updated tests that keep actor visibility, control-plane activation, and incident projection aligned.

---

### Task 1: Add Runtime Actor Plane Classification

**Files:**
- Create: `extensions/watchdog/lib/agent/agent-plane-policy.js`
- Modify: `extensions/watchdog/lib/effective-profile-composer.js`
- Modify: `extensions/watchdog/lib/agent/agent-identity.js`
- Modify: `extensions/watchdog/lib/agent/agent-registry-view.js`
- Test: `extensions/watchdog/tests/agent-plane-policy.test.js`
- Test: `extensions/watchdog/tests/controller-split-migration.test.js`

- [ ] **Step 1: Write the failing classification tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { resolveActorPlanePolicy } from "../lib/agent/agent-plane-policy.js";

test("controller is runtime-visible and auto-wake eligible", () => {
  assert.deepEqual(
    resolveActorPlanePolicy({
      agentId: "controller",
      role: "bridge",
      gateway: true,
      ingressSource: "webui",
    }),
    {
      plane: "runtime",
      mainViewVisible: true,
      formalTimelineVisible: true,
      autoWakeEligible: true,
    },
  );
});

test("operator is a hidden control-plane agent", () => {
  assert.deepEqual(
    resolveActorPlanePolicy({
      agentId: "operator",
      role: "agent",
      gateway: false,
      ingressSource: null,
    }),
    {
      plane: "control_plane",
      mainViewVisible: false,
      formalTimelineVisible: false,
      autoWakeEligible: false,
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extensions/watchdog/tests/agent-plane-policy.test.js`

Expected: FAIL because `agent-plane-policy.js` does not exist and no actor classification fields are exposed.

- [ ] **Step 3: Implement the classification authority**

```js
// extensions/watchdog/lib/agent/agent-plane-policy.js
import { normalizeString } from "../core/normalize.js";

export function resolveActorPlanePolicy({
  agentId,
  role,
  gateway = false,
  ingressSource = null,
} = {}) {
  const id = normalizeString(agentId) || "";
  const normalizedRole = normalizeString(role)?.toLowerCase() || "agent";
  const source = normalizeString(ingressSource)?.toLowerCase() || null;

  if (id === "operator") {
    return {
      plane: "control_plane",
      mainViewVisible: false,
      formalTimelineVisible: false,
      autoWakeEligible: false,
    };
  }

  if (normalizedRole === "bridge" || gateway === true || source) {
    return {
      plane: "runtime",
      mainViewVisible: true,
      formalTimelineVisible: true,
      autoWakeEligible: true,
    };
  }

  return {
    plane: "runtime",
    mainViewVisible: true,
    formalTimelineVisible: true,
    autoWakeEligible: true,
  };
}
```

```js
// extensions/watchdog/lib/effective-profile-composer.js
import { resolveActorPlanePolicy } from "./agent/agent-plane-policy.js";

const actorPolicy = resolveActorPlanePolicy({
  agentId: binding.agentId,
  role: binding.roleRef,
  gateway: binding.policies?.gateway === true,
  ingressSource: binding.policies?.ingressSource || null,
});

return {
  // existing fields...
  plane: actorPolicy.plane,
  mainViewVisible: actorPolicy.mainViewVisible,
  formalTimelineVisible: actorPolicy.formalTimelineVisible,
  autoWakeEligible: actorPolicy.autoWakeEligible,
};
```

- [ ] **Step 4: Run tests to verify the profile projection passes**

Run:

```bash
node --test extensions/watchdog/tests/agent-plane-policy.test.js
node --test extensions/watchdog/tests/controller-split-migration.test.js
```

Expected: PASS, with `operator` still treated as an agent but projected as hidden control-plane.

- [ ] **Step 5: Commit**

```bash
git add \
  extensions/watchdog/lib/agent/agent-plane-policy.js \
  extensions/watchdog/lib/effective-profile-composer.js \
  extensions/watchdog/lib/agent/agent-identity.js \
  extensions/watchdog/lib/agent/agent-registry-view.js \
  extensions/watchdog/tests/agent-plane-policy.test.js \
  extensions/watchdog/tests/controller-split-migration.test.js
git commit -m "feat: add runtime actor plane classification"
```

### Task 2: Filter Main View And Formal Timeline By Runtime Visibility

**Files:**
- Modify: `extensions/watchdog/dashboard.js`
- Modify: `extensions/watchdog/dashboard-agents.js`
- Modify: `extensions/watchdog/dashboard-graph.js`
- Modify: `extensions/watchdog/dashboard-pipeline.js`
- Modify: `extensions/watchdog/lib/store/tracker-store.js`
- Modify: `extensions/watchdog/tests/suite-single.js`
- Test: `extensions/watchdog/tests/dashboard-stage-visibility.test.js`
- Test: `extensions/watchdog/tests/formal-timeline-visibility.test.js`

- [ ] **Step 1: Write the failing visibility tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { shouldDisplayDashboardAgentRecord } from "../dashboard.js";

test("main roster hides control-plane operator", () => {
  assert.equal(
    shouldDisplayDashboardAgentRecord({
      id: "operator",
      plane: "control_plane",
      mainViewVisible: false,
    }),
    false,
  );
});

test("formal test timeline drops hidden control-plane events", () => {
  const timeline = [];
  const sse = {
    events: [
      {
        type: "track_start",
        receivedAt: 10,
        data: { agentId: "operator", formalTimelineVisible: false },
      },
    ],
  };
  const lastObserved = drainSSEEvents(sse, 0, null, timeline);
  assert.equal(lastObserved, 0);
  assert.deepEqual(timeline, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test extensions/watchdog/tests/dashboard-stage-visibility.test.js
node --test extensions/watchdog/tests/formal-timeline-visibility.test.js
```

Expected: FAIL because dashboard consumers and `suite-single.js` currently accept any agent-like event into the main line.

- [ ] **Step 3: Implement visibility filtering using runtime-owned fields**

```js
// extensions/watchdog/dashboard.js
export function shouldDisplayDashboardAgentRecord(agent) {
  if (!agent || typeof agent !== "object") return false;
  if (agent.mainViewVisible === false) return false;
  return agent.plane === "runtime";
}
```

```js
// extensions/watchdog/lib/store/tracker-store.js
return {
  agentId: trackingState?.agentId || null,
  plane: trackingState?.actorPolicy?.plane || "runtime",
  mainViewVisible: trackingState?.actorPolicy?.mainViewVisible !== false,
  formalTimelineVisible: trackingState?.actorPolicy?.formalTimelineVisible !== false,
  // existing fields...
};
```

```js
// extensions/watchdog/tests/suite-single.js
if (evt.type === "track_start") {
  if (evt.data?.formalTimelineVisible === false) continue;
  timeline.push({ at: evt.receivedAt, event: "agent session start", agentId: evt.data?.agentId });
}
```

- [ ] **Step 4: Run tests to verify the runtime role line is clean**

Run:

```bash
node --test extensions/watchdog/tests/dashboard-stage-visibility.test.js
node --test extensions/watchdog/tests/formal-timeline-visibility.test.js
node --test extensions/watchdog/tests/formal-test-surface.test.js
```

Expected: PASS, with dashboard main view and formal test timelines both excluding hidden control-plane agents.

- [ ] **Step 5: Commit**

```bash
git add \
  extensions/watchdog/dashboard.js \
  extensions/watchdog/dashboard-agents.js \
  extensions/watchdog/dashboard-graph.js \
  extensions/watchdog/dashboard-pipeline.js \
  extensions/watchdog/lib/store/tracker-store.js \
  extensions/watchdog/tests/suite-single.js \
  extensions/watchdog/tests/dashboard-stage-visibility.test.js \
  extensions/watchdog/tests/formal-timeline-visibility.test.js
git commit -m "feat: filter main view and formal timeline by runtime visibility"
```

### Task 3: Block Ordinary Task Runtime From Activating Operator

**Files:**
- Create: `extensions/watchdog/lib/agent/agent-activation-policy.js`
- Modify: `extensions/watchdog/lib/transport/runtime-wake-transport.js`
- Modify: `extensions/watchdog/lib/routing/delivery-system-action-transport.js`
- Modify: `extensions/watchdog/lib/runtime/pending-signal-registry.js`
- Modify: `extensions/watchdog/lib/test-runs.js`
- Test: `extensions/watchdog/tests/control-plane-activation-policy.test.js`
- Test: `extensions/watchdog/tests/runtime-wake-envelope.test.js`

- [ ] **Step 1: Write the failing activation-boundary tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { canAutoWakeForTaskRuntime } from "../lib/agent/agent-activation-policy.js";

test("ordinary task runtime cannot auto-wake operator", () => {
  assert.equal(
    canAutoWakeForTaskRuntime({
      agentId: "operator",
      plane: "control_plane",
      autoWakeEligible: false,
    }),
    false,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test extensions/watchdog/tests/control-plane-activation-policy.test.js
node --test extensions/watchdog/tests/runtime-wake-envelope.test.js
```

Expected: FAIL because ordinary wake transport still accepts arbitrary agent ids and does not reject control-plane actors.

- [ ] **Step 3: Implement an explicit auto-wake gate**

```js
// extensions/watchdog/lib/agent/agent-activation-policy.js
export function canAutoWakeForTaskRuntime(actorPolicy) {
  return actorPolicy?.plane === "runtime" && actorPolicy?.autoWakeEligible === true;
}
```

```js
// extensions/watchdog/lib/transport/runtime-wake-transport.js
const actorPolicy = getAgentIdentitySnapshot(agentId);
if (!canAutoWakeForTaskRuntime(actorPolicy)) {
  return normalizeWakeDiagnostic({
    ok: false,
    requested: false,
    reason: "control_plane_activation_blocked",
    error: `ordinary task runtime cannot auto-wake ${agentId}`,
  }, {
    lane: "runtime_wake",
    targetAgent: agentId,
  });
}
```

```js
// extensions/watchdog/lib/routing/delivery-system-action-transport.js
if (!canAutoWakeForTaskRuntime(getAgentIdentitySnapshot(targetAgent))) {
  return {
    ok: false,
    requested: false,
    reason: "control_plane_activation_blocked",
    error: `delivery recovery cannot escalate into ${targetAgent}`,
  };
}
```

- [ ] **Step 4: Run activation-boundary tests**

Run:

```bash
node --test extensions/watchdog/tests/control-plane-activation-policy.test.js
node --test extensions/watchdog/tests/runtime-wake-envelope.test.js
node --test extensions/watchdog/tests/pending-signal-registry.test.js
```

Expected: PASS, with operator remaining addressable from control-plane surfaces only.

- [ ] **Step 5: Commit**

```bash
git add \
  extensions/watchdog/lib/agent/agent-activation-policy.js \
  extensions/watchdog/lib/transport/runtime-wake-transport.js \
  extensions/watchdog/lib/routing/delivery-system-action-transport.js \
  extensions/watchdog/lib/runtime/pending-signal-registry.js \
  extensions/watchdog/lib/test-runs.js \
  extensions/watchdog/tests/control-plane-activation-policy.test.js \
  extensions/watchdog/tests/runtime-wake-envelope.test.js
git commit -m "feat: block ordinary runtime from activating operator"
```

### Task 4: Add Runtime-Owned Incident Store And Fault Evaluator

**Files:**
- Create: `extensions/watchdog/lib/runtime/execution-incident-store.js`
- Create: `extensions/watchdog/lib/runtime/runtime-fault-evaluator.js`
- Modify: `extensions/watchdog/lib/store/execution-trace-store.js`
- Modify: `extensions/watchdog/hooks/after-tool-call.js`
- Modify: `extensions/watchdog/lib/lifecycle/agent-end-terminal.js`
- Test: `extensions/watchdog/tests/execution-incident-store.test.js`
- Test: `extensions/watchdog/tests/runtime-fault-evaluator.test.js`
- Test: `extensions/watchdog/tests/max-tool-calls-hard-stop.test.js`

- [ ] **Step 1: Write the failing incident and fault tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { evaluateRuntimeFault } from "../lib/runtime/runtime-fault-evaluator.js";

test("repeated identical truth reads escalate to llm_fault", () => {
  const incident = evaluateRuntimeFault({
    toolLoop: { sameToolSameInputCount: 3, toolName: "read" },
    progress: { hasFormalProgress: false },
    actor: { agentId: "worker", plane: "runtime" },
  });
  assert.equal(incident.rootFault, "llm_fault");
  assert.equal(incident.firstFaultCode, "identical_tool_loop");
});

test("control-plane activation during ordinary execution escalates to system_fault", () => {
  const incident = evaluateRuntimeFault({
    wrongActorActivation: { agentId: "operator", plane: "control_plane" },
    progress: { hasFormalProgress: false },
  });
  assert.equal(incident.rootFault, "system_fault");
  assert.equal(incident.firstFaultCode, "wrong_actor_activation");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test extensions/watchdog/tests/execution-incident-store.test.js
node --test extensions/watchdog/tests/runtime-fault-evaluator.test.js
```

Expected: FAIL because there is no incident store and runtime still only records trace/loop evidence piecemeal.

- [ ] **Step 3: Implement the incident store and evaluator**

```js
// extensions/watchdog/lib/runtime/runtime-fault-evaluator.js
export function evaluateRuntimeFault(input) {
  if (input?.wrongActorActivation) {
    return {
      rootFault: "system_fault",
      firstFaultCode: "wrong_actor_activation",
      amplifiers: [],
      terminationMode: "terminate_with_diagnosis",
    };
  }

  if ((input?.toolLoop?.sameToolSameInputCount || 0) >= 3 && input?.progress?.hasFormalProgress === false) {
    return {
      rootFault: "llm_fault",
      firstFaultCode: "identical_tool_loop",
      amplifiers: [],
      terminationMode: "terminate_with_diagnosis",
    };
  }

  return {
    rootFault: null,
    firstFaultCode: null,
    amplifiers: [],
    terminationMode: "continue",
  };
}
```

```js
// extensions/watchdog/lib/runtime/execution-incident-store.js
const incidents = new Map();

export function upsertExecutionIncident(incident) {
  const key = incident.epochKey || incident.sessionKey;
  const current = incidents.get(key) || null;
  const next = current ? { ...current, ...incident } : incident;
  incidents.set(key, next);
  return next;
}
```

```js
// extensions/watchdog/hooks/after-tool-call.js
const incidentVerdict = evaluateRuntimeFault({
  toolLoop: { sameToolSameInputCount: loopSignal === "hard_stop" ? 3 : 0, toolName },
  progress: {
    hasFormalProgress: Boolean(
      canonicalCommitInfo
      || observedStageResultCommit
      || traceVerdict?.outputCommitted
      || traceVerdict?.systemActionSeen
    ),
  },
  actor: {
    agentId,
    plane: t?.actorPolicy?.plane || "runtime",
  },
});

if (incidentVerdict.rootFault) {
  upsertExecutionIncident({
    sessionKey,
    epochKey,
    agentId,
    contractId: t?.contract?.id || null,
    rootFault: incidentVerdict.rootFault,
    firstFaultCode: incidentVerdict.firstFaultCode,
    amplifiers: incidentVerdict.amplifiers,
    status: incidentVerdict.terminationMode === "terminate_with_diagnosis" ? "fail_fast" : "open",
  });
}
```

- [ ] **Step 4: Run the incident tests and affected regressions**

Run:

```bash
node --test extensions/watchdog/tests/execution-incident-store.test.js
node --test extensions/watchdog/tests/runtime-fault-evaluator.test.js
node --test extensions/watchdog/tests/loop-detection.test.js
node --test extensions/watchdog/tests/max-tool-calls-hard-stop.test.js
```

Expected: PASS, with repeated identical tool loops and wrong-actor activation classified before late timeout.

- [ ] **Step 5: Commit**

```bash
git add \
  extensions/watchdog/lib/runtime/execution-incident-store.js \
  extensions/watchdog/lib/runtime/runtime-fault-evaluator.js \
  extensions/watchdog/lib/store/execution-trace-store.js \
  extensions/watchdog/hooks/after-tool-call.js \
  extensions/watchdog/lib/lifecycle/agent-end-terminal.js \
  extensions/watchdog/tests/execution-incident-store.test.js \
  extensions/watchdog/tests/runtime-fault-evaluator.test.js \
  extensions/watchdog/tests/max-tool-calls-hard-stop.test.js
git commit -m "feat: add runtime incident store and fault evaluator"
```

### Task 5: Project Incident Truth Into Harness, CLI System, Operator, And Automation

**Files:**
- Modify: `extensions/watchdog/lib/operator/operator-snapshot-runtime.js`
- Modify: `extensions/watchdog/lib/operator/operator-snapshot.js`
- Modify: `extensions/watchdog/lib/test-runs.js`
- Modify: `extensions/watchdog/tests/suite-single.js`
- Modify: `extensions/watchdog/tests/formal-report.js`
- Modify: `extensions/watchdog/tests/automation-harness-projection.test.js`
- Test: `extensions/watchdog/tests/operator-incident-projection.test.js`
- Test: `extensions/watchdog/tests/formal-timeline-visibility.test.js`

- [ ] **Step 1: Write the failing projection tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { summarizeRuntimeIncident } from "../lib/operator/operator-snapshot-runtime.js";

test("operator snapshot projects runtime incident without creating a second taxonomy", () => {
  const summary = summarizeRuntimeIncident({
    contractId: "TC-1",
    rootFault: "mixed_fault",
    firstFaultCode: "identical_tool_loop",
    amplifiers: ["wrong_actor_activation"],
    status: "fail_fast",
  });

  assert.equal(summary.rootFault, "mixed_fault");
  assert.deepEqual(summary.amplifiers, ["wrong_actor_activation"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test extensions/watchdog/tests/operator-incident-projection.test.js
node --test extensions/watchdog/tests/automation-harness-projection.test.js
```

Expected: FAIL because operator snapshot and formal reports do not yet consume incident-backed failure truth.

- [ ] **Step 3: Project incident truth instead of parallel diagnoses**

```js
// extensions/watchdog/lib/operator/operator-snapshot-runtime.js
export function summarizeRuntimeIncident(incident) {
  if (!incident) return null;
  return {
    contractId: incident.contractId || null,
    rootFault: incident.rootFault || null,
    firstFaultCode: incident.firstFaultCode || null,
    amplifiers: Array.isArray(incident.amplifiers) ? incident.amplifiers : [],
    status: incident.status || null,
    terminationReason: incident.terminationReason || null,
  };
}
```

```js
// extensions/watchdog/lib/test-runs.js
return {
  // existing fields...
  incident: result.executionIncident || null,
};
```

```js
// extensions/watchdog/tests/formal-report.js
if (result.incident?.rootFault) {
  lines.push(`    rootFault: ${result.incident.rootFault}`);
  lines.push(`    firstFault: ${result.incident.firstFaultCode || "--"}`);
}
```

- [ ] **Step 4: Run the projection suite**

Run:

```bash
node --test extensions/watchdog/tests/operator-incident-projection.test.js
node --test extensions/watchdog/tests/automation-harness-projection.test.js
node --test extensions/watchdog/tests/formal-test-surface.test.js
```

Expected: PASS, with runtime, harness, CLI/test surfaces, and operator snapshot all pointing to the same incident-backed fault truth.

- [ ] **Step 5: Commit**

```bash
git add \
  extensions/watchdog/lib/operator/operator-snapshot-runtime.js \
  extensions/watchdog/lib/operator/operator-snapshot.js \
  extensions/watchdog/lib/test-runs.js \
  extensions/watchdog/tests/suite-single.js \
  extensions/watchdog/tests/formal-report.js \
  extensions/watchdog/tests/automation-harness-projection.test.js \
  extensions/watchdog/tests/operator-incident-projection.test.js
git commit -m "feat: project runtime incidents across operator harness and tests"
```

## Self-Review

- Spec coverage:
  - hidden control-plane `operator` boundary: covered in Tasks 1-3
  - main-view runtime-only projection: covered in Tasks 1-2
  - single task contract / evidence-driven fail-fast: covered in Task 4
  - one incident truth for runtime/harness/CLI/operator/automation: covered in Tasks 4-5
- Placeholder scan:
  - no `TBD`, `TODO`, or “similar to task N” placeholders remain
  - every task includes exact files, test names, commands, and commit targets
- Type consistency:
  - actor visibility fields are always `plane`, `mainViewVisible`, `formalTimelineVisible`, `autoWakeEligible`
  - incident fields are always `rootFault`, `firstFaultCode`, `amplifiers`, `status`, `terminationReason`

