# Formal Test Surface Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink OpenClaw's formal test surface to the five approved presets, align frontend/backend preset semantics, and unify formal report structure around current platform business semantics.

**Architecture:** Keep raw suites available for non-default/internal use, but move formal preset truth into a shared preset catalog consumed by CLI and devtools. Normalize formal report output through a shared generator so `single`, `multi`, `concurrent`, `loop-platform`, and the redefined `direct-service` all produce the same report sections.

**Tech Stack:** Node.js, existing watchdog test runner/devtools modules, plain-text report generation.

---

### Task 1: Lock formal preset truth into one catalog

**Files:**
- Create: `extensions/watchdog/lib/formal-test-presets.js`
- Modify: `extensions/watchdog/test-runner.js`
- Modify: `extensions/watchdog/lib/test-runs.js`

- [ ] Add shared formal preset definitions for `single`, `multi`, `concurrent`, `loop-platform`, `direct-service`.
- [ ] Make CLI `--preset` resolve through that catalog instead of a hand-written map.
- [ ] Make devtools test presets read from the same catalog so frontend/backend use identical names, labels, suite bindings, and case ids.

### Task 2: Curate formal cases without deleting raw suite capabilities

**Files:**
- Modify: `extensions/watchdog/tests/suite-single.js`
- Modify: `extensions/watchdog/tests/suite-direct-service.js`
- Modify: `extensions/watchdog/tests/suite-loop-platform.js`

- [ ] Rewrite formal `single`/`multi` case metadata around current platform semantics: one fast-track, two full-path representative web cases.
- [ ] Reduce formal `concurrent` to one canonical group built from those curated web cases.
- [ ] Redefine formal `direct-service` to use only the assign-task same-session return case while leaving the raw suite available for non-default/internal use.
- [ ] Add shared report metadata (`scenario`, `businessSemantics`, `coverage`, `transportPath`, `expectedRuntimeTruth`) to formal cases.

### Task 3: Unify formal report structure

**Files:**
- Create: `extensions/watchdog/tests/formal-report.js`
- Modify: `extensions/watchdog/tests/suite-single.js`
- Modify: `extensions/watchdog/tests/suite-loop-platform.js`
- Modify: `extensions/watchdog/lib/test-runs.js`

- [ ] Introduce one formal report generator with consistent `Summary`, `Checkpoint Flow`, `Runtime Truth`, and `Coverage + Diagnosis` sections.
- [ ] Route `single`, `multi`, `concurrent`, and `direct-service` through that generator.
- [ ] Route `loop-platform` through the same generator with loop-specific diagnosis/runtime truth adapters.
- [ ] Ensure devtools run artifacts use the same report text path for the new formal presets.

### Task 4: Expose the five formal presets in devtools and keep old suites non-default

**Files:**
- Modify: `extensions/watchdog/lib/test-runs.js`
- Modify: `extensions/watchdog/test-runner.js`

- [ ] Extend devtools runner support so it can execute `loop-platform` and `direct-service` formal presets.
- [ ] Keep raw non-default suites callable through `--suite` while removing them from the formal preset map.
- [ ] Preserve existing preset names exactly so frontend labels and backend preset ids stay stable.

### Task 5: Add regression coverage for the new formal surface and verify

**Files:**
- Create: `extensions/watchdog/tests/formal-test-surface.test.js`

- [ ] Write failing tests that assert the shared formal preset catalog exposes exactly the five formal presets.
- [ ] Write failing tests that assert `direct-service` formal preset only points at the assign-task return case.
- [ ] Write failing tests that assert devtools preset listing includes the same five preset ids.
- [ ] Write failing tests that assert formal report text includes the normalized section headers.
- [ ] Run targeted `node --test` verification for the new regression file.
- [ ] Run targeted suite commands to smoke the modified preset plumbing if feasible in the current local runtime.
