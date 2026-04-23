# Agent-Local Progress Display Design

**Date:** 2026-04-23
**Scope:** watchdog tracking payloads, dashboard work-item rendering, lifecycle/operator snapshots
**Status:** proposed

## Problem

The current watchdog progress UI mixes two different truths:

- `contract.stagePlan / stageRuntime / stageProjection` describe contract-global stage truth
- the visible progress bar is read as the current agent's progress

This causes handoff ambiguity. When `worker1` reaches `80%` and the same contract moves to `worker2`, the next visible card still looks like `80%`, even though the current owner has just started.

The result is a misleading UI:

- progress bar looks agent-local
- phase row looks contract-global
- users cannot tell whether they are looking at a whole-contract completion ratio or the current agent's local execution progress

## Decision

The main progress UI becomes **agent-local**.

- progress bar is agent-local
- visible phase row is agent-local
- handoff to a new agent starts from `0%`

Contract-global truth remains runtime-owned and visible, but moves out of the main progress bar semantics:

- `stagePlan / stageRuntime / stageProjection` remain canonical contract truth
- `pipelineProgression` remains the contract/global handoff truth
- dashboard/operator/CLI/lifecycle use a new runtime-owned `activityProgress` object for the main progress display

## Runtime Shape

Active tracking payloads gain a new system-owned object:

```json
{
  "activityProgress": {
    "source": "agent_local_activity",
    "phases": ["接手", "执行", "收口"],
    "completedPhases": [],
    "currentPhase": "接手",
    "currentPhaseIndex": 0,
    "cursor": "0/3",
    "pct": 0,
    "total": 3
  }
}
```

This object is derived only from the current tracking session. It is not copied from contract-global stage truth.

## Derivation Rules

Base phases are fixed:

- `接手`
- `执行`
- `收口`

Runtime derives local progress from current-session evidence:

- no local activity yet: `0%`, current phase `接手`
- first observed activity: `20%`
- active execution established: `40%`, current phase `执行`
- closure signal observed: `80%`, current phase `收口`
- terminal success: `100%`

Signals are system-owned and local to the current tracking session:

- `toolCallTotal`
- `recentToolEvents`
- `activityCursor`
- `runtimeObservation.outputArtifact`
- terminal lifecycle status

## Surface Rules

- `buildProgressPayload()` publishes `activityProgress`
- top-level `pct / cursor / estimatedPhase` for active tracking payloads follow `activityProgress`
- dashboard main progress bar and phase row render `activityProgress`
- lifecycle/operator snapshots preserve canonical `stagePlan / stageRuntime`, but their primary progress summary follows `activityProgress`

## Non-Goals

- changing canonical contract stage truth
- changing pipeline/loop/handoff truth
- inventing agent-declared progress
- adding contract-global completion math back into the main progress bar
