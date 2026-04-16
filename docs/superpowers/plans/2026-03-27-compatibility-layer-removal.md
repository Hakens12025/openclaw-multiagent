# Compatibility Layer Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove active legacy protocol and config compatibility layers so OpenClaw runs only on current runtime truth, then verify formal presets still pass.

**Architecture:** Cut compatibility in four layers: legacy `test` agent identity, binding/identity/router old-truth fallback, `start_pipeline` old payload and fallback semantics, and startup schema compat patching. Keep transport reliability fallback intact. Update tests so they prove current truth instead of preserving old aliases.

**Tech Stack:** Node.js, OpenClaw watchdog runtime, node:test, JSON config, shell verification.

---

### Task 1: Lock Current Compatibility Seams With Failing Tests

**Files:**
- Modify: `extensions/watchdog/tests/suite-agent-model.js`
- Modify: `extensions/watchdog/tests/unified-control-plane-p0.test.js`
- Modify: `extensions/watchdog/tests/contractor-start-pipeline-validity.test.js`
- Modify: `extensions/watchdog/tests/contractor-handoff-terminal.test.js`
- Modify: `extensions/watchdog/tests/formal-full-path-runtime.test.js`

- [ ] Write a failing test that proves `source="test"` no longer resolves to a built-in gateway agent.
- [ ] Write a failing test that proves legacy flat agent fields are no longer mirrored back out by binding persistence.
- [ ] Write a failing test that proves legacy-id fallback does not synthesize role/gateway/protected/specialized truth.
- [ ] Write a failing test that proves legacy `start_pipeline` aliases (`action`, `pipelineId`, `targetAgent`, `entryAgentId`) are no longer normalized into accepted runtime params.
- [ ] Write a failing test that proves invalid contractor `start_pipeline` no longer falls back to worker-root success semantics.
- [ ] Run the smallest relevant test commands and confirm RED before touching implementation.

### Task 2: Remove Legacy Identity And Binding Compatibility

**Files:**
- Modify: `extensions/watchdog/lib/agent-metadata.js`
- Modify: `extensions/watchdog/lib/agent-identity.js`
- Modify: `extensions/watchdog/lib/agent-binding-store.js`
- Modify: `extensions/watchdog/lib/router-handler-registry.js`

- [ ] Remove `AGENT_IDS.TEST` and any legacy gateway/source fallback tied to it.
- [ ] Remove legacy-id role/gateway/protected/specialized inference when runtime config is absent.
- [ ] Remove binding read/write mirroring between nested binding truth and flat legacy config fields.
- [ ] Remove router handler legacy role-style fallback when capability truth is absent.
- [ ] Re-run targeted agent-model tests and keep them green.

### Task 3: Remove Legacy `start_pipeline` Compatibility

**Files:**
- Modify: `extensions/watchdog/lib/protocol-primitives.js`
- Modify: `extensions/watchdog/lib/system-actions.js`
- Modify: `extensions/watchdog/lib/agent-end-pipeline.js`
- Modify: `extensions/watchdog/tests/unified-control-plane-p0.test.js`
- Modify: `extensions/watchdog/tests/contractor-start-pipeline-validity.test.js`
- Modify: `extensions/watchdog/tests/contractor-handoff-terminal.test.js`
- Modify: `extensions/watchdog/tests/formal-full-path-runtime.test.js`

- [ ] Remove legacy alias normalization for `start_pipeline` payloads.
- [ ] Require explicit current-shape params instead of deriving `startAgent` and loop truth from legacy fields.
- [ ] Remove contractor invalid-`start_pipeline` fallback-to-worker-root semantics.
- [ ] Update tests to expect strict failure when old payloads or old fallback semantics are used.
- [ ] Re-run the targeted runtime/control-plane tests and keep them green.

### Task 4: Remove Startup Schema Compat Patch

**Files:**
- Delete: `scripts/ensure-openclaw-agent-schema-compat.mjs`
- Modify: `start.sh`
- Modify: `scripts/clean-restart-gateway.sh`
- Modify: `use guide/备忘录47_[主]_Codex交接总备忘录_2026-03-17-2222.md` (only if needed later; not required for code truth)

- [ ] Remove startup references to schema compat preflight.
- [ ] Ensure startup still validates config directly without patching installed bundles.
- [ ] Run a dry startup-related verification command if possible.

### Task 5: Verify Presets And Runtime Truth

**Files:**
- No required code file if all prior tasks are green.

- [ ] Run targeted suites covering `agent-model`, `unified-control-plane-p0`, `conveyor`, `contractor-loop-permission`, and relevant loop/runtime tests.
- [ ] Run preset verification for `single`, `multi`, `concurrent`, `loop-platform`.
- [ ] If `direct-service` preset still exists, run it and record whether it remains meaningful or should be removed next.
- [ ] Report remaining non-code residue separately: old memos, old reports, and historical test names.
