# Context Retirement And Dispatch Runtime State Design

## Summary

This spec covers the next cleanup slice for watchdog runtime:

1. Retire `context.json` from the active runtime path without deleting the historical mechanism.
2. Replace split queue/busy ownership with one canonical dispatch runtime state owner.

The purpose is to remove two remaining sources of semantic drift in the current runtime:

- side-channel context delivery that competes with exact-session delivery
- split dispatch state ownership between executor-specific runtime state and graph-router-local maps

This spec intentionally does **not** redesign external direct activation through arbitrary agents. That remains a separate follow-up topic after this cleanup lands.

## Problem Statement

### 1. `context.json` still exists as an active side channel

`context.json` was introduced to preserve continuity when the old routing model could not reliably resume the same agent session. That historical need was real: loop, review, and follow-up work often looked like a fresh start even when it should have been progressive continuation.

The current runtime now has stronger primitives:

- exact `sessionKey` wake
- `targetSessionKey` delivery
- `returnContext`
- `serviceSession`
- `delivery:system_action.*`

Those runtime-owned return paths now cover the continuity problem more correctly than `context.json`. Keeping `context.json` active creates a second continuation mechanism and reintroduces dual truth.

### 2. Queue/busy state still has two owners

Current graph dispatch distinguishes:

- executor agents: state owned by `worker-runtime-state.js`
- non-executor agents: state owned by local `busyAgents` / `agentQueues` inside `graph-router.js`

This produces a structural split:

- queue behavior differs by role class
- state snapshoting is partly centralized, partly local
- dashboard/operator/runtime consumers cannot rely on a single dispatch truth object

The current system works, but it still encodes “executor lane is special” inside the dispatch state model.

## Goals

- Remove `context.json` from all active runtime paths.
- Preserve the old mechanism as isolated legacy source so it is not forgotten.
- Create one canonical owner for dispatch queue/busy/claim/release state.
- Make graph-router consume dispatch state through API only.
- Keep role-aware wake behavior, but stop using queue ownership differences as a proxy for role semantics.

## Non-Goals

- No redesign of arbitrary external activation through any agent in this slice.
- No new semantic matcher or rule tower.
- No compatibility facade that keeps old and new runtime paths alive simultaneously.
- No deletion of historical context implementation knowledge; it should be archived, not continue running.

## Design Decisions

### A. `context.json` is retired, not forgotten

The active runtime will no longer:

- write `inbox/context.json`
- read `inbox/context.json`
- treat wake-time context injection as a valid runtime transport

Instead, the existing implementation is moved into a clearly isolated legacy location, for example:

- `lib/legacy/context-sidechannel/`

This legacy location is documentation-grade code, not active runtime code.

Rules:

- no production file may import from `lib/legacy/`
- tests for active runtime must not rely on `context.json`
- legacy code should include a short note explaining why it once existed

Rationale:

- exact-session delivery now solves the original continuity problem more correctly
- the historical mechanism is worth preserving for future reference
- preserving it as dead-isolated legacy avoids both forgetting and accidental live reuse

### B. Wake remains role-aware, but not context-carrying

This cleanup does **not** remove role-aware wake behavior.

Planner, executor, reviewer, and other roles still need different runtime wake semantics. For example, planner wake must still steer the agent to plan-first behavior rather than raw execution.

What changes is only the payload boundary:

- wake may carry role startup guidance
- wake may carry session targeting
- wake may not carry business context side-channel state

In other words:

- “how to start” may stay in wake semantics
- “what the task is” and “what historical context must continue” must live in formal runtime objects

### C. Dispatch state gets a single owner

A new canonical owner replaces the current executor-vs-non-executor split:

- `lib/routing/dispatch-runtime-state.js`

This module owns dispatch state for **all** agents that participate in runtime dispatch.

It becomes the only runtime owner of:

- target registration
- busy state
- dispatching state
- current contract claim
- per-agent queue
- runtime snapshot emission
- persistence for runtime queue state

Suggested public API:

- `syncDispatchTargetsFromRuntime(logger)`
- `syncDispatchTargets(targetIds, logger)`
- `hasDispatchTarget(agentId)`
- `isDispatchTargetBusy(agentId)`
- `markDispatchTargetDispatching(agentId, contractId)`
- `claimDispatchTargetContract({ agentId, contractId, logger })`
- `releaseDispatchTargetContract({ agentId, logger })`
- `enqueueDispatchContract(agentId, contractId, meta, logger)`
- `dequeueDispatchContract(agentId)`
- `getDispatchQueueDepth(agentId)`
- `buildDispatchRuntimeSnapshot()`
- `emitDispatchRuntimeSnapshot()`
- `persistDispatchRuntimeState(logger)`
- `loadDispatchRuntimeState(logger)`

### D. Role-specific side effects stay below the owner boundary

Executor-specific side effects such as QQ typing do not justify a second owner.

Instead:

- dispatch runtime state remains the sole owner
- role-specific release/claim side effects are internal policy branches inside the owner module

This keeps one truth while still allowing executor-specific behavior.

### E. Graph-router becomes a pure routing decision layer

After the change, `graph-router.js` should no longer own:

- local `busyAgents`
- local `agentQueues`

Graph-router should only decide:

- which target to dispatch to
- whether dispatch succeeds or queues
- when to ask runtime state to mark busy, release, enqueue, or dequeue

This restores graph-router to its intended role:

- routing owner
- not runtime state owner

## Data Flow

### 1. Shared contract dispatch

Before:

- graph-router decides target
- executor targets use centralized runtime state
- non-executor targets use local busy/queue maps

After:

- graph-router decides target
- graph-router asks dispatch-runtime-state whether target is busy
- if busy, graph-router enqueues through dispatch-runtime-state
- if idle, graph-router marks dispatching through dispatch-runtime-state
- session bootstrap claims through dispatch-runtime-state
- runtime lifecycle / crash recovery release through dispatch-runtime-state

### 2. `wake_agent` system action

Before:

- may write `context.json`
- then wake target

After:

- no `context.json` write
- wake remains allowed
- if future designs need structured context continuation, they must use a formal runtime delivery object rather than wake-time file injection

### 3. Artifact/review paths

This slice does not redesign artifact lanes, but they must stop depending on `context.json` existence assumptions. Review and delivery continue through their formal artifact and delivery surfaces only.

## Error Handling

- If dispatch target registration is missing, dispatch must fail closed rather than silently falling back to local maps.
- If state persistence fails, runtime continues but emits warning diagnostics.
- If claim/release side effects fail, the state mutation should still complete unless the failure corrupts runtime truth.
- Legacy context code must be unreachable from production imports; any accidental import should fail tests.

## Testing

### New tests

- active runtime no longer writes `inbox/context.json`
- `wake_agent` ignores/removes runtime context-sidechannel behavior
- graph-router no longer defines local queue/busy owners
- runtime consumers use `dispatch-runtime-state.js`
- dispatch queue behavior is identical for executor and non-executor agents
- claim/release behavior still emits executor side effects correctly

### Updated tests

- rewrite existing `system-action-context` coverage to assert context-sidechannel retirement
- remove active-runtime assertions that inspect `context.json`
- migrate worker-runtime-state tests to dispatch-runtime-state semantics

## Migration Plan

1. Move current `stage-context.js` implementation into `lib/legacy/context-sidechannel/`.
2. Remove all active imports and tests that depend on runtime `context.json`.
3. Introduce `dispatch-runtime-state.js`.
4. Move worker-runtime-state logic into the new canonical owner.
5. Update graph-router to consume only canonical dispatch state APIs.
6. Update session bootstrap, runtime lifecycle, admin/operator/dashboard consumers.
7. Remove old owner names and references rather than keeping compatibility exports.

## Risks

### Risk 1: planner/reviewer behavior regresses if wake text is over-trimmed

Mitigation:

- keep role-aware wake guidance
- only remove side-channel task/context transport

### Risk 2: queue semantics change for non-executor agents

Mitigation:

- add parity tests across executor and non-executor targets
- validate on graph-router dispatch and on-agent-done drain behavior

### Risk 3: hidden production reliance on `context.json`

Mitigation:

- search-based test coverage
- fail tests if production code imports from `lib/legacy/`

## Acceptance Criteria

- Production runtime never reads or writes `inbox/context.json`.
- `context.json` survives only as isolated legacy source with zero production imports.
- Graph-router no longer owns local queue/busy maps.
- All dispatch queue/busy state is owned by a single runtime module.
- Executor and non-executor dispatch targets follow the same queue/busy state model.
- Existing role-aware wake behavior continues to steer planner/reviewer/executor correctly.
