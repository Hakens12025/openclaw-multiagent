# Unified Task Stage Truth Design

**Date:** 2026-03-29
**Scope:** Replace heuristic and topology-shaped phase display with one runtime-backed task-stage truth model shared by ordinary tasks and loop tasks.

## Problem

OpenClaw currently has a real stage projection mechanism but does not yet have a real stage truth model.

The current gap has three parts:

1. ordinary tasks still derive `phases` from ingress templates or contractor free-form planning text
2. loop tasks expose `researcher -> worker -> evaluator` style actor topology as if that were user-facing task phase truth
3. dashboard progress is no longer driven by tool-call heuristics, but the projected `stagePlan` is still not consistently a task-instance truth object

This violates memo 75 in a specific way: the projection layer is becoming real, but the projected object is still not the task's own semantic stage truth.

## Desired Semantics

OpenClaw should have one stage model for all task instances:

`TaskStagePlan -> currentStage -> completedStages -> gate/evidence -> progress`

This model must be shared by:

- ordinary one-shot work tasks
- graph/pipeline tasks
- loop tasks with repeated rounds

What stays unified:

- one stage truth chain
- one progress derivation rule
- one dashboard language

What does not need to be uniform:

- number of stages
- stage wording
- whether the task uses loop rounds
- which agents participate in execution

## Core Design

### 1. TaskStagePlan is a task-instance object

The real phase object should belong to the task instance, not to ingress templates, not to contractor text, and not to loop topology.

It should answer:

- what semantic stages this task is expected to go through
- what order they are in
- which stage is currently active
- which stages are completed
- whether the plan has been revised and why

`contract.phases` can survive for compatibility, but its target meaning becomes:

- serialized `TaskStagePlan.stages`
- task-instance semantic stage decomposition

It should no longer mean:

- static keyword template
- actor list
- vague planning hint only

### 2. Loop actor topology is not user-facing phase truth

Loop actor routing and user-visible stage truth must be separated.

For example:

- `researcher -> worker -> evaluator` remains a loop family execution topology
- user-visible stage truth becomes semantic task stages such as `建立比较维度 / 补证据 / 交叉比较 / 形成结论`

So loop adds:

- `round`
- repeated execution over the same or revised semantic stage plan

Loop does not define a second phase language.

### 3. Progress is derived from stage facts only

The progress bar remains, but only as a projection of runtime stage facts.

It may use:

- `stagePlan.length`
- `currentStage`
- `completedStages`
- `round`
- terminal completion state

It may not use:

- `toolCallTotal`
- `AVG_CALLS_PER_STEP`
- actor ids as phase positions
- arbitrary elapsed time or activity estimates

### 4. Stage plan revision is allowed but tightly bounded

The stage plan should be revisable during execution, but only in a bounded way so progress remains meaningful and agents do not waste time rewriting plans.

Recommended policy:

- revisions allowed only before the task crosses a configurable completion threshold, default first half
- completed stages are immutable: no rename, reorder, split, or deletion
- active stage can only receive clarification-level edits, not semantic replacement
- total stage count can only change within a narrow delta
- revision count is capped
- each revision must record a machine-readable reason

This keeps the system adaptive without turning `stagePlan` into a constantly moving target.

## Runtime Objects

### TaskStagePlan

Recommended minimum shape:

```json
{
  "id": "stages:TC-123",
  "contractId": "TC-123",
  "version": 2,
  "stages": [
    { "id": "define_axes", "label": "建立比较维度", "status": "completed" },
    { "id": "gather_evidence", "label": "补充关键证据", "status": "active" },
    { "id": "cross_compare", "label": "交叉比较权衡", "status": "pending" },
    { "id": "finalize", "label": "形成结论与建议", "status": "pending" }
  ],
  "currentStageId": "gather_evidence",
  "completedStageIds": ["define_axes"],
  "revisionCount": 1,
  "revisionPolicy": {
    "maxRevisions": 2,
    "maxStageDelta": 1,
    "freezeCompletedStages": true
  },
  "lastRevisionReason": "new_evidence_scope_refined"
}
```

### StageProjection

Dashboard and SSE can continue to consume a projection object, but it should be a projection of `TaskStagePlan`, not a substitute for it.

The projection should answer:

- plan
- current stage
- completed stages
- cursor
- pct
- gate/evidence summary
- round
- source

### StageRevisionPolicy

This policy belongs to runtime governance, not to the agent prompt.

It decides:

- when revisions are still allowed
- what kinds of edits are legal
- how many times revisions may happen
- what becomes immutable after progress advances

## Generation and Consumption

### Ordinary tasks

Ordinary tasks should generate an initial semantic `TaskStagePlan` early, ideally at contractor planning time or equivalent runtime planning time.

The initial plan can be informed by:

- user task
- contractor decomposition
- route/intent hints

But the runtime must normalize and freeze it into the canonical task-stage object.

### Loop tasks

Loop tasks should also generate an initial semantic `TaskStagePlan`.

Loop runtime then consumes that same object while separately carrying:

- actor topology
- loop policy
- round
- evaluation and loop decision objects

This means loop execution may revisit the same stage or revise upcoming stages, but it still does so against the same task-stage truth object.

### Harness and evaluation

Harness does not define stages.

Harness provides:

- gate verdict
- evidence
- evaluation input normalization

`EvaluationResult` does not define the stage plan either.

`EvaluationResult` may influence:

- whether current stage is accepted as completed
- whether next stage is unlocked
- whether a bounded stage-plan revision is justified
- whether loop continues, reworks, or concludes

But final mutation of stage truth remains a runtime responsibility.

## Implementation Boundaries

### What should be removed

- ingress keyword templates as durable phase truth
- actor ids directly displayed as dashboard phase truth
- any remaining meaning that treats activity estimates as task progress

### What should remain

- `toolCallTotal` and recent tool labels as activity signal only
- pipeline and loop runtime objects as execution truth
- harness gate/evidence objects as execution-shaping truth
- evaluation and decision objects as governance truth

### What should be added

- canonical task-stage object stored with the task instance
- bounded revision mechanism
- runtime mutation path for stage completion and revision
- unified SSE/dashboard projection derived from canonical stage truth

## Recommended Approach

Approach A: add a canonical `TaskStagePlan` object and migrate both ordinary tasks and loop tasks to consume it. Recommended.

Pros:

- actually satisfies memo 75
- ordinary tasks and loops become one semantic model
- progress bar becomes honest
- actor topology stops leaking into user-facing phase language

Cons:

- larger refactor across contractor, stage projection, loop runtime, and dashboard

Approach B: keep current objects and just map actor topology to prettier labels.

Pros:

- small patch

Cons:

- still fake
- keeps two truths alive
- will regress again

Approach C: only fix ordinary tasks first, loops later.

Pros:

- smaller first step

Cons:

- violates the user's explicit requirement that ordinary and loop stage logic must be the same

Chosen: Approach A.

## Verification Strategy

Minimum verification for this design:

1. ordinary non-loop task produces canonical semantic stage plan and runtime-backed progress
2. loop task produces canonical semantic stage plan while hiding actor topology from user-facing phase display
3. bounded revision rule prevents large plan drift after progress has advanced
4. completed stages remain immutable across revisions
5. dashboard and lifecycle snapshot consume the same projected truth for ordinary and loop tasks

## Risks

- contractor may still emit low-quality stage plans; mitigation: normalize and validate into runtime canonical form, reject weak plans
- loop runtime may need new mapping between semantic stages and actor dispatch; mitigation: keep actor topology as execution-layer object, not phase truth
- stage revision rules may be too strict or too loose; mitigation: start with narrow caps and add tests before widening

## Final Decision

OpenClaw should move to one task-stage truth model.

The user-facing `phase` area must represent semantic task stages, not actor topology and not activity heuristics.

Ordinary tasks and loop tasks should differ in governance and repetition, but not in what a stage fundamentally is.
