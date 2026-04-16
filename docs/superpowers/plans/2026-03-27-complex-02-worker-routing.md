# Complex-02 Worker Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore `complex-02` to the historical non-loop business semantic so the formal WebUI complex preset validates contractor -> worker execution, while loop behavior remains covered only by dedicated loop platform tests.

**Architecture:** Treat this as a routing-semantic regression, not a new control-plane capability. Tighten contractor/planner guidance so one-shot comparative report tasks are not casually elevated into `start_pipeline`, and narrow the formal case expectation for `complex-02` back to worker execution. Keep loop tests separate and preserve the unified transport/lifecycle primitives.

**Tech Stack:** Node.js, watchdog runtime, formal test harness, agent workspace guidance sync

---

### Task 1: Lock `complex-02` back to worker-only formal semantics

**Files:**
- Modify: `extensions/watchdog/tests/formal-full-path-runtime.test.js`
- Modify: `extensions/watchdog/tests/suite-single.js`

- [ ] **Step 1: Write the failing test**

Add a regression in `extensions/watchdog/tests/formal-full-path-runtime.test.js` asserting a case-level policy helper classifies `complex-02` as `worker_only`, while a loop-platform case remains `loop_allowed`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extensions/watchdog/tests/formal-full-path-runtime.test.js`
Expected: FAIL because no case-level runtime policy helper exists yet.

- [ ] **Step 3: Write minimal implementation**

Add a small helper in `extensions/watchdog/tests/formal-full-path-runtime.js` that answers whether a formal case allows loop elevation, then wire `suite-single.js` so `complex-02` fails if runtime classifies it as loop.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test extensions/watchdog/tests/formal-full-path-runtime.test.js`
Expected: PASS.

### Task 2: Tighten contractor guidance so one-shot comparison reports stay on worker path

**Files:**
- Modify: `extensions/watchdog/lib/contractor-service.js`
- Modify: `extensions/watchdog/lib/agent-bootstrap.js`
- Test: `extensions/watchdog/tests/suite-agent-model.js`

- [ ] **Step 1: Write the failing test**

Add/extend guidance rendering tests to assert planner-facing guidance explicitly distinguishes:
- loop: open-ended iterative research / research-execute-evaluate cycles
- worker: one-shot analysis / comparison / summary / report tasks with a direct deliverable

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extensions/watchdog/tests/suite-agent-model.js`
Expected: FAIL because current guidance only says “开放式、多阶段、研究-执行-评估类任务优先 start_pipeline”.

- [ ] **Step 3: Write minimal implementation**

Update contractor wake message and planner guidance text to make the boundary explicit: direct comparative reports, summaries, and one-shot analysis requests should remain standard worker execution unless the task truly requires iterative loop feedback.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test extensions/watchdog/tests/suite-agent-model.js`
Expected: PASS.

### Task 3: Verify targeted regression coverage and real formal behavior

**Files:**
- Modify: any files touched above

- [ ] **Step 1: Run targeted unit tests**

Run: `node --test extensions/watchdog/tests/formal-full-path-runtime.test.js extensions/watchdog/tests/suite-agent-model.js`
Expected: PASS.

- [ ] **Step 2: Run the real formal case**

Run: `node extensions/watchdog/test-runner.js --suite single --filter complex-02 --clean`
Expected: PASS with contractor -> worker path; if runtime still elevates to loop, treat as remaining routing failure.

- [ ] **Step 3: Run dedicated loop control test**

Run: `node extensions/watchdog/test-runner.js --suite loop-platform --filter real-user-loop-start`
Expected: PASS, proving loop-specific capability still works under its dedicated scenario.
