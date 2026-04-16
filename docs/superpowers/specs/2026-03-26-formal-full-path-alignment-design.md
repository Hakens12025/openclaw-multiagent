# Formal Full-Path Alignment Design

**Date:** 2026-03-26
**Scope:** Formal preset repair for complex full-path cases, contractor `start_pipeline` validity, and runtime delegation diagnostics.

## Problem

The current formal test surface mixes two different failure classes:

1. Real runtime failure: some contractor-issued `start_pipeline` actions are invalid because the final payload can miss `startAgent` in multi-loop conditions.
2. Stale formal semantics: complex formal cases still assume success means `contractor -> worker -> delivery`, while the current platform semantics allow `contractor -> start_pipeline -> loop entry agent`, with root contract lifecycle deferred and synced through runtime.
3. Diagnostic noise: early delegation diagnostics can report false `ENOENT` because hook-time validation reads relative `outbox/system_action.json` paths without resolving them against the agent workspace.

## Desired Semantics

Formal complex cases should align with memo 69 control-plane truth:

`ingress.normalize -> conveyor.dispatch -> lifecycle.commit -> loop engine`

For a complex full-path request, success is no longer defined as "a worker session must appear". Success should be defined by runtime truth:

- root contract created
- contractor observed and completed planning
- runtime accepted either planner contract promotion or `start_pipeline`
- root contract lifecycle committed consistently with the accepted runtime path
- frontend-visible terminal truth exists for the root business request

If the request is elevated into loop runtime, the first observed executor may be `researcher`, not `worker-*`.

## Non-Goals

- No large conveyor refactor in this change.
- No loop engine redesign.
- No removal of legacy tests beyond the already-reduced formal surface.
- No protocol expansion beyond enforcing existing valid `start_pipeline` requirements.

## Approach

### 1. Split formal complex validation by runtime path

Update formal single/concurrent complex templates so they do not hard-code worker-only checkpoints for all full-path traffic.

Instead:

- keep shared ingress/contractor checkpoints
- inspect contract runtime snapshot after contractor completion
- if the root contract is promoted to normal worker execution, keep existing worker checkpoints
- if runtime accepts `start_pipeline`, treat loop entry ownership and synchronized root lifecycle as the success path
- if runtime rejects the action, fail with the runtime error directly

This preserves frontend-stable preset names while aligning complex semantics with the current platform.

### 2. Make contractor `start_pipeline` generation stricter

The planner already receives loop inventory and guidance, but the live guidance is too vague in multi-loop conditions. Repair the generation path so runtime receives a valid payload with explicit `startAgent`, and preferably `loopId` when multiple active loops exist.

The change should target the effective planner prompt/guidance surface and any runtime normalization points that can safely derive missing values from planning context without guessing.

### 3. Fix early delegation path resolution

Repair hook-time delegation validation so relative writes like `outbox/system_action.json` are resolved against the acting agent workspace before reading. This should only improve diagnostics; it must not change runtime routing behavior.

## Files Expected To Change

- `extensions/watchdog/tests/suite-single.js`
- `extensions/watchdog/tests/formal-report.js` if report wording needs small alignment
- `extensions/watchdog/lib/system-actions.js`
- `extensions/watchdog/hooks/after-tool-call.js`
- planner guidance source(s): likely `extensions/watchdog/lib/agent-bootstrap.js` and/or contractor-specific guidance surfaces
- regression tests around unified control plane and formal template behavior

## Test Strategy

1. Add focused failing tests first:
   - formal complex case accepts loop-elevated success without requiring `worker-*`
   - early delegation check resolves relative `outbox/system_action.json`
   - `start_pipeline` normalization/generation yields explicit `startAgent` in the multi-loop contractor path being fixed
2. Run targeted node tests for new/updated regression coverage.
3. Re-run real formal presets:
   - `single`
   - `multi`
   - `concurrent`
   - `loop-platform`
   - `direct-service`

## Risks

- Over-correcting formal tests could hide a real runtime regression. Mitigation: keep `complex-02` failing until runtime invalid payload is actually repaired.
- Tightening planner guidance can shift contractor behavior on other open-ended tasks. Mitigation: keep the rule narrow: explicit `startAgent` and explicit `loopId` only when loop elevation is already the intended path.
- Diagnostic changes can alter runtime trace output shape. Mitigation: change only path resolution, not receipt schema.
