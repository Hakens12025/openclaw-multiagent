# Agent-Local Progress Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the watchdog progress bar and visible phase row represent the current agent's local execution progress instead of contract-global stage completion.

**Architecture:** Keep `contract.stagePlan / stageRuntime / pipelineProgression` as canonical contract truth. Add a runtime-owned `activityProgress` object derived from the active tracking session, then route dashboard/lifecycle/operator progress displays through it.

**Tech Stack:** Node.js, watchdog runtime modules, SSE payloads, dashboard rendering, node:test

---

### Task 1: Add Runtime-Owned Agent-Local Progress

**Files:**
- Create: `extensions/watchdog/lib/activity-progress.js`
- Modify: `extensions/watchdog/lib/transport/sse.js`
- Modify: `extensions/watchdog/lib/store/tracker-store.js`
- Modify: `extensions/watchdog/lib/contract-lifecycle-view.js`
- Test: `extensions/watchdog/tests/activity-progress.test.js`
- Test: `extensions/watchdog/tests/tool-progress-payload.test.js`
- Test: `extensions/watchdog/tests/task-stage-runtime.test.js`

- [ ] Write failing tests for local progress derivation and payload propagation.
- [ ] Implement `activityProgress` derivation from current tracking-session evidence only.
- [ ] Publish `activityProgress` plus local `pct / cursor / estimatedPhase` through progress payloads and lifecycle snapshots.
- [ ] Run:
  - `node --test extensions/watchdog/tests/activity-progress.test.js`
  - `node --test extensions/watchdog/tests/tool-progress-payload.test.js`
  - `node --test extensions/watchdog/tests/task-stage-runtime.test.js`

### Task 2: Switch Dashboard Main Progress UI To Agent-Local Semantics

**Files:**
- Modify: `extensions/watchdog/dashboard.js`
- Test: `extensions/watchdog/tests/dashboard-stage-visibility.test.js`

- [ ] Write failing dashboard tests proving main phase/progress display prefers `activityProgress` over canonical contract phases during active execution.
- [ ] Update dashboard rendering and event merge logic to keep canonical stage truth available while rendering agent-local phase/progress in the main card.
- [ ] Run:
  - `node --test extensions/watchdog/tests/dashboard-stage-visibility.test.js`

### Task 3: Verify Handoff Reset Semantics

**Files:**
- Test: `extensions/watchdog/tests/dashboard-stage-visibility.test.js`
- Test: `extensions/watchdog/tests/task-stage-runtime.test.js`

- [ ] Add a failing regression showing the same contract resets to `0%` local progress when ownership moves to a new agent.
- [ ] Implement the minimal runtime/display changes needed so the new agent starts from local `0/3`.
- [ ] Run:
  - `node --test extensions/watchdog/tests/dashboard-stage-visibility.test.js`
  - `node --test extensions/watchdog/tests/task-stage-runtime.test.js`
