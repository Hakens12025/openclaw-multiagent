# Runtime-Owned Stage Progress Design

**Date:** 2026-04-09
**Scope:** any contract carrying canonical `stagePlan`, with planner / `planMode` as richer stage-definition producers rather than feature gates
**Status:** proposed
**Relation to prior spec:** refines and narrows [2026-03-29-unified-task-stage-truth-design.md](./2026-03-29-unified-task-stage-truth-design.md) by defining a concrete runtime-owned mutation chain and a fixed harness boundary.

## Problem

OpenClaw already has:

- planner or `planMode` agents that can write richer stage definitions
- a canonical stage projection path for the dashboard
- runtime collection of artifacts, review verdicts, and delivery results
- shared stage-plan ingestion across standard contracts, direct requests, and loop task-stage objects

OpenClaw does not yet have a truthful stage progress source.

The current gap is structural:

1. `stagePlan` currently mixes two concerns:
   - stage definition
   - runtime progress
2. planner-extracted stage detail is lost during normalization; only labels survive
3. runtime stage mutation currently depends on agent-declared stage semantics or terminal backfill
4. terminal contracts can appear as `100%` complete even when intermediate stage completion was never truly observed

This violates Rule 12:

- agent writes content
- system extracts structure
- runtime reacts to observable signals
- agent self-report must not be the primary truth source

## Decision

Stage progress will be owned by the runtime, not by the agent and not by harness.

The canonical object chain becomes:

`StagePlan -> StageObservation -> StageCheckResult -> StageRuntime -> StageProjection`

Meaning:

- `StagePlan` defines what stages exist and what evidence each stage requires
- `StageObservation` records real runtime-observed facts
- `StageCheckResult` is the runtime's evaluation of whether the current stage witness is satisfied
- `StageRuntime` is the persisted truth of current progress
- `StageProjection` is a UI projection only

Harness may provide verifier-style building blocks, but it does not own stage truth.

## Applicability

This design must not be implemented as a planner-only lane.

The applicability rule is:

- if a contract has canonical `stagePlan`, it is eligible for runtime-owned stage progress

This means:

- standard ingress contracts are in scope
- direct-request contracts are in scope
- loop task-stage plans are in scope
- planner-produced stage plans are in scope
- `planMode` worker-produced stage plans are in scope

Planner and `planMode` are not the activation condition.

They are only richer producers of stage definitions.

The actual activation condition is the presence of canonical `stagePlan`.

This preserves one system path instead of introducing:

- planner-specific progress logic
- `planMode`-only projection logic
- role-based feature flags for stage truth

## Goals

- show truthful stage-level progress in the dashboard
- advance stages only from real runtime observations
- stop relying on agent-written `semanticStageAction`, `semanticStageId`, or `stage_result.json` as the primary truth source
- preserve planner richness such as `objective`, `deliverable`, and completion rules
- keep the design valid for both standalone planner and `planMode` worker execution
- keep one shared runtime path for all contracts that already participate in canonical stage truth

## Non-Goals

- stage-internal checkpoint progress
- tool-call heuristics as progress truth
- making `HarnessRun` the owner of contract stage progress
- reintroducing topology-shaped phases as user-facing truth
- introducing a planner-only or `planMode`-only execution lane for stage progress

## Core Objects

### 1. `contract.stagePlan`

`stagePlan` becomes a pure definition object.

Recommended shape:

```json
{
  "contractId": "TC-123",
  "version": 1,
  "stages": [
    {
      "id": "stage-1",
      "label": "建立修改方案",
      "objective": "明确改动目标和边界",
      "deliverable": "一份计划性输出",
      "witness": [
        { "kind": "artifact_exists", "pathRef": "primary_output", "nonEmpty": true }
      ]
    },
    {
      "id": "stage-2",
      "label": "完成代码修改",
      "objective": "产出实际代码变更",
      "deliverable": "代码与必要说明",
      "witness": [
        { "kind": "artifact_exists", "pathRef": "primary_output", "nonEmpty": true },
        { "kind": "review_verdict", "expected": "pass" }
      ]
    }
  ],
  "revisionPolicy": {
    "maxRevisions": 2,
    "maxStageDelta": 1
  }
}
```

Rules:

- `stagePlan` does not store `currentStageId`
- `stagePlan` does not store `completedStageIds`
- `stagePlan` does not store runtime status
- `stagePlan` keeps rich stage fields instead of collapsing to labels

### 2. `contract.stageRuntime`

`stageRuntime` is the persisted runtime truth for progress.

Recommended shape:

```json
{
  "version": 3,
  "currentStageId": "stage-2",
  "completedStageIds": ["stage-1"],
  "status": "active",
  "lastObservationTs": 1775702400000,
  "lastSatisfiedWitnesses": [
    { "stageId": "stage-1", "kind": "artifact_exists", "source": "agent_end_outbox" }
  ],
  "history": [
    {
      "type": "stage_completed",
      "stageId": "stage-1",
      "ts": 1775702300000,
      "source": "stage_witness_engine"
    }
  ]
}
```

Rules:

- this is the only persisted progress truth
- runtime owns all writes to this object
- agents never write this object directly

### 3. `StageObservation`

`StageObservation` is a runtime-owned evidence packet built from real events.

Recommended normalized fields:

- `contractId`
- `source`
- `ts`
- `artifacts`
- `reviewerResult`
- `systemActionDelivery`
- `childContractOutcome`
- `runtimeDiagnostics`

This object may be transient, append-only, or partially persisted. The key requirement is that stage progression must be computed from observation records rather than from agent self-declared progress.

### 4. `StageCheckResult`

This is the result of evaluating the current stage's witness rules against the accumulated observations.

Recommended minimum shape:

```json
{
  "stageId": "stage-1",
  "satisfied": true,
  "matchedWitnesses": [
    { "kind": "artifact_exists", "source": "agent_end_outbox" }
  ],
  "reason": "required witness set satisfied",
  "ts": 1775702300000
}
```

This object can remain ephemeral if recorded into `stageRuntime.history`.

### 5. `contract.stageProjection`

`stageProjection` remains the dashboard-facing object.

It is derived only from:

- `stagePlan`
- `stageRuntime`
- terminal contract status

It must not derive progress from:

- tool call counts
- actor topology
- agent self-reported stage completion
- terminal auto-backfill of all unfinished stages

## Witness System

Each stage defines a `witness` array. The runtime owns evaluation.

Initial supported witness kinds should be small and hard:

1. `artifact_exists`
   - requires a concrete artifact path
   - may require `nonEmpty`
2. `artifact_json_path`
   - requires a JSON artifact and presence of configured JSON paths
3. `review_verdict`
   - requires a normalized reviewer verdict such as `pass`
4. `system_action_delivery`
   - requires a specific delivery workflow or handled result
5. `child_contract_terminal`
   - requires a delegated child contract to reach a target terminal status

Witness evaluation is stage-local:

- only the current stage is evaluated
- one successful evaluation advances at most one stage
- later-stage evidence cannot skip unfinished earlier stages

## Runtime Event Sources

The first version should only consume hard runtime observations from four places:

1. `agent-end` outbox collection
   - artifacts
   - primary output
   - normalized outbox payload
2. reviewer result arrival
   - normalized verdict
   - findings
3. system-action delivery completion
   - delivery handled or failed
   - workflow-specific return payload
4. child contract terminal outcome
   - child status
   - result artifact
   - semantic completion result

These four sources are sufficient for stage-level truthful progress without introducing heuristics.

## Progress Evaluation Rules

### Normal advance

When a new `StageObservation` is recorded:

1. load `stagePlan`
2. load `stageRuntime`
3. identify `currentStageId`
4. evaluate that stage's witness set
5. if satisfied, append a `stage_completed` history record and advance to the next stage
6. rebuild `stageProjection`

### Hold and failure

Contract-level failure or awaiting-input states do not imply stage completion.

If the contract reaches:

- `failed`
- `awaiting_input`
- `hold`

then `stageRuntime` remains at the last truly completed stage unless a current-stage witness was already satisfied before the terminal state was applied.

### Terminal completion

Terminal completion does not auto-complete all remaining stages.

If the contract ends in `completed` while only some stages were truly satisfied:

- contract terminal state remains `completed`
- `stageRuntime.completedStageIds` remains partial
- `stageProjection` reflects partial verified progress, not synthesized 100%

The UI may later add a separate terminal badge such as `contract completed / stage trail incomplete`, but runtime truth must not lie.

## Harness Boundary

This design intentionally separates ownership from evaluation style.

### What stays in the system layer

- `stagePlan`
- `stageRuntime`
- observation recording
- stage advancement
- stage projection
- contract-linked lifecycle writes

### What may reuse harness-style ideas

- modular witness kinds
- artifact and schema verifiers
- verdict normalizers
- failure classification helpers

### What must not happen

- `HarnessRun` becoming the source of truth for stage progress
- stage progression depending on harness profile enablement
- harness deciding contract routing, delivery targets, or collaboration topology

This follows the existing OpenClaw boundary: harness is execution shaping and evidence infrastructure, not a platform truth owner.

## Migration and Cleanup

### Existing system fit

This design is intentionally shaped to match the current OpenClaw stage spine instead of creating a parallel path.

Existing shared path today:

- ingress already seeds canonical `stagePlan`
- direct-request envelopes already seed canonical `stagePlan`
- loop state already carries `taskStagePlan`
- agent-end marker extraction already writes back into `contract.stagePlan`
- tracker, lifecycle view, and SSE already consume stage truth primarily through `contract.stagePlan`

So the migration target is not a new lane.

The migration target is:

- preserve the existing shared `stagePlan` backbone
- separate definition truth from runtime progress truth
- replace current mixed semantics with `stagePlan + stageRuntime`

### Activation rule during cutover

During implementation, the runtime should determine whether to run stage progress logic by checking:

- canonical `stagePlan` exists and contains at least one stage

It should not branch on:

- role id
- planner identity
- `planMode` identity
- whether the stage plan came from ingress defaults, planner output, or direct-request initialization

This keeps the system on one semantic path.

### Must preserve

- planner or `planMode` stage richness from marker extraction
- bounded revision policy for future stage-plan revision support
- existing dashboard contract rendering path based on projection
- shared stage-plan consumption across ingress, direct-request, tracker, SSE, lifecycle view, and loop task-stage objects

### Must change

1. preserve rich stage entries during plan normalization
2. split progress fields out of `stagePlan`
3. introduce `stageRuntime`
4. introduce a runtime-owned stage witness evaluator
5. derive projection from `stagePlan + stageRuntime`
6. keep compatibility fields such as `phases` and `total` as derived projections rather than alternative truth lanes

### Must remove

- `semanticStageAction` as the primary stage truth input
- `semanticStageId` as the primary stage truth input
- `stage_result.json` as the canonical stage-advance mechanism
- terminal fallback that marks all stages completed without evidence

## Code Impact

Primary modules expected to change:

- `extensions/watchdog/lib/stage-marker-parser.js`
- `extensions/watchdog/lib/task-stage-plan.js`
- `extensions/watchdog/lib/stage-projection.js`
- `extensions/watchdog/lib/lifecycle/agent-end-pipeline.js`
- `extensions/watchdog/lib/routing/router-outbox-handlers.js`
- `extensions/watchdog/lib/contract-outcome.js`

Recommended new module:

- `extensions/watchdog/lib/stage-witness-engine.js`

Responsibilities of the new module:

- normalize `StageObservation`
- evaluate witness kinds
- produce `StageCheckResult`
- mutate `stageRuntime`

## Testing

The implementation is not complete without the following tests:

1. planner-extracted stage detail survives normalization
2. artifact witness advances exactly one stage
3. reviewer verdict witness advances exactly one stage
4. system-action delivery witness advances exactly one stage
5. child contract terminal witness advances exactly one stage
6. later-stage evidence cannot skip current stage
7. completed contract without satisfied witnesses does not render false `100%`
8. agent self-reported stage fields alone do not advance progress

## Recommended Approach

Approach A: system-owned stage truth with harness-style verifier library. Recommended.

Pros:

- matches Rule 12
- keeps platform truth unified
- absorbs the useful part of harness design without turning harness into a mega orchestrator
- gives the dashboard honest progress

Cons:

- requires a real object split and removal of older stage semantics

Approach B: move stage completion into harness proper.

Pros:

- superficially similar to existing gate/evidence patterns

Cons:

- violates the fixed boundary between harness and platform truth
- makes stage progress optional or profile-shaped
- risks creating a hidden platform controller inside harness

Approach C: continue with agent-declared stage completion plus better normalization.

Pros:

- smaller refactor

Cons:

- still depends on self-report
- still violates the desired truth model
- does not solve the real problem

## Final Recommendation

Build stage-level progress as a runtime truth object chain owned by the system. Reuse harness-style verifier design where useful, but do not make harness the owner of stage progression.
