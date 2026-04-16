# Formal Full-Path Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the formal complex preset surface so it matches current OpenClaw control-plane semantics, while also fixing the real contractor `start_pipeline` validity bug and removing misleading delegation diagnostics.

**Architecture:** Keep preset names stable and preserve the reduced formal surface, but split complex full-path validation by actual runtime path. If a complex request is elevated into loop runtime, formal success is defined by accepted `start_pipeline`, loop entry ownership, and synchronized root lifecycle instead of forced `worker-*` checkpoints. In parallel, tighten contractor `start_pipeline` payload validity and resolve relative hook-time diagnostic paths.

**Tech Stack:** Node.js, watchdog runtime, formal test harness, SSE-driven runtime observation

---

### Task 1: Add regression tests for the stale formal semantics boundary

**Files:**
- Modify: `extensions/watchdog/tests/suite-single.js`
- Create or Modify: `extensions/watchdog/tests/formal-full-path-runtime.test.js`

- [ ] **Step 1: Write the failing test for loop-elevated full-path success classification**

Add a test that feeds a synthetic formal result/runtime snapshot representing:
- contractor completed
- root contract `status=completed`
- `systemAction.type=start_pipeline`
- `systemAction.status=dispatched`
- `targetAgent=researcher`

Assert that the formal complex classifier treats this as the accepted execution path instead of requiring a `worker-*` session.

- [ ] **Step 2: Run the targeted test to verify it fails for the current worker-only logic**

Run: `node --test extensions/watchdog/tests/formal-full-path-runtime.test.js`

Expected: FAIL because current complex formal logic still waits for `worker-*` checkpoints.

- [ ] **Step 3: Implement the minimal classifier/path split in formal complex handling**

Update `suite-single.js` so complex formal handling distinguishes between:
- traditional worker execution path
- loop-elevated `start_pipeline` path

Do not change simple-case logic.

- [ ] **Step 4: Re-run the targeted test and confirm it passes**

Run: `node --test extensions/watchdog/tests/formal-full-path-runtime.test.js`

Expected: PASS.

### Task 2: Add regression test for relative `system_action.json` diagnostic reads

**Files:**
- Modify: `extensions/watchdog/hooks/after-tool-call.js`
- Create or Modify: `extensions/watchdog/tests/delegation-early-check-paths.test.js`

- [ ] **Step 1: Write the failing test for relative outbox path resolution**

Add a test that simulates an agent write event with `path: "outbox/system_action.json"` and verifies the hook reads the file from that agent's workspace instead of the process cwd.

- [ ] **Step 2: Run the targeted test to verify it fails with the current raw-path read**

Run: `node --test extensions/watchdog/tests/delegation-early-check-paths.test.js`

Expected: FAIL with an `ENOENT`-style mismatch or missing receipt.

- [ ] **Step 3: Implement minimal path resolution in the hook**

Resolve relative write targets against `agentWorkspace(agentId)` before calling `readFile`, but keep receipt schema unchanged.

- [ ] **Step 4: Re-run the targeted test and confirm it passes**

Run: `node --test extensions/watchdog/tests/delegation-early-check-paths.test.js`

Expected: PASS.

### Task 3: Add regression test for contractor loop elevation validity

**Files:**
- Modify: `extensions/watchdog/lib/system-actions.js`
- Modify: planner guidance source(s) used to shape contractor payloads
- Create or Modify: `extensions/watchdog/tests/contractor-start-pipeline-validity.test.js`

- [ ] **Step 1: Write the failing test for the real `complex-02` validity hole**

Add a focused test that models a contractor-issued `start_pipeline` action in a multi-loop environment where the request is already intended for loop elevation, and assert that the final runtime parameters include a concrete `startAgent`.

- [ ] **Step 2: Run the targeted test to verify it fails under the current hole**

Run: `node --test extensions/watchdog/tests/contractor-start-pipeline-validity.test.js`

Expected: FAIL because the constructed/normalized action can still reach runtime without a valid `startAgent` for this path.

- [ ] **Step 3: Implement the narrow runtime/guidance fix**

Make the path produce explicit `startAgent`, and when applicable explicit `loopId`, without broadening protocol rules or guessing across unrelated actions.

- [ ] **Step 4: Re-run the targeted test and confirm it passes**

Run: `node --test extensions/watchdog/tests/contractor-start-pipeline-validity.test.js`

Expected: PASS.

### Task 4: Verify targeted syntax and regression coverage

**Files:**
- Modify: any files touched in Tasks 1-3

- [ ] **Step 1: Run syntax checks on touched runtime and test files**

Run:
`node --check extensions/watchdog/tests/suite-single.js`
`node --check extensions/watchdog/hooks/after-tool-call.js`
`node --check extensions/watchdog/lib/system-actions.js`
`node --check extensions/watchdog/tests/formal-full-path-runtime.test.js`
`node --check extensions/watchdog/tests/delegation-early-check-paths.test.js`
`node --check extensions/watchdog/tests/contractor-start-pipeline-validity.test.js`

Expected: all commands exit 0.

- [ ] **Step 2: Run all focused regression tests together**

Run:
`node --test extensions/watchdog/tests/formal-full-path-runtime.test.js extensions/watchdog/tests/delegation-early-check-paths.test.js extensions/watchdog/tests/contractor-start-pipeline-validity.test.js`

Expected: PASS.

### Task 5: Re-run the real formal preset surface

**Files:**
- No new file changes required if Tasks 1-4 are green

- [ ] **Step 1: Run the real `single` formal preset**

Run: `node extensions/watchdog/test-runner.js --preset single`

Expected: simple path passes; complex path results reflect the repaired semantics.

- [ ] **Step 2: Run the real `multi` formal preset**

Run: `node extensions/watchdog/test-runner.js --preset multi`

Expected: `complex-02` no longer fails from invalid `start_pipeline`; `complex-03` no longer fails from stale worker-only expectations.

- [ ] **Step 3: Run the real `concurrent` formal preset**

Run: `node extensions/watchdog/test-runner.js --preset concurrent`

Expected: the mixed concurrent template converges without misclassifying loop-elevated success as a worker timeout.

- [ ] **Step 4: Re-run control presets to ensure no regression**

Run:
`node extensions/watchdog/test-runner.js --preset loop-platform`
`node extensions/watchdog/test-runner.js --preset direct-service`

Expected: both PASS.
