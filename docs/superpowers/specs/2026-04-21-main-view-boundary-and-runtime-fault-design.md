# Main View Boundary And Runtime Fault Design

## Summary

This spec defines the next cleanup slice for OpenClaw runtime:

1. Remove control-plane, tooling, and automation objects from the main runtime role line without deleting their formal existence.
2. Keep `operator` as a real agent, but make it a hidden control-plane agent instead of a main-view runtime actor.
3. Replace timeout-shaped mixed failures with one runtime-owned fault taxonomy and one runtime-owned incident object.

The purpose is to stop three kinds of semantic drift that are currently coupled:

- main-view graph/timeline truth drifting away from the actual runtime object model
- normal task execution accidentally activating control-plane actors
- harness, CLI system, operator, and automation each forming their own failure story

This spec intentionally does **not** redesign task contract into multiple path types. The system now has one formal `task contract` semantic, and all stop/fail-fast logic in this slice must be evidence-driven rather than route-class-driven.

## Problem Statement

### 1. Main-view truth is mixed with non-runtime planes

The current system has four tightly related planes:

- `runtime`
- `CLI system`
- `operator`
- `harness / automation`

Those planes are not four parallel agent lanes. They are one continuous object chain with different owners and different visibility rules.

The current main-view behavior still leaks this distinction:

- control-plane identities can appear as if they were normal runtime actors
- formal test timelines can record control-plane sessions as if they were part of the task execution line
- dashboard graph/pipeline and runtime actor identity do not share one formal visibility predicate

That breaks the intended meaning of the main view: it should show the runtime role line, not every object that participates somewhere in the larger system.

### 2. `operator` is a real agent, but not a main-view actor

`operator` should remain a real agent. It is not being deleted.

However, it is not a normal execution-line agent and it is not a front-desk bridge. It is a higher-order control-plane agent whose formal entry is runtime operator/settings and related control-plane surfaces.

That means:

- `operator` may exist as an agent
- `operator` may execute control actions
- `operator` must not appear in the main runtime role line
- `operator` must not be auto-activated by ordinary task runtime paths

The current system violates the last two points when ordinary execution failures or heartbeat/wake paths can surface control-plane agent activity inside formal execution timelines.

### 3. Failures are flattened into timeout-shaped terminal states

Current failure behavior often collapses into a late generic timeout even when there is earlier structured evidence that:

- the model already went off the rails
- runtime kept amplifying the failure after there was no meaningful progress
- the wrong actor was activated

This makes it hard to distinguish:

- `LLM fault`
- `system fault`
- `mixed fault`
- `permission/control-plane block`
- `retryable transport failure`

Without that distinction, formal tests, runtime diagnostics, operator governance, and automation learning cannot share one stable truth.

## Goals

- Keep `operator` as a formal agent while removing it from the main runtime role line.
- Define one runtime-owned actor classification that determines main-view visibility, formal timeline visibility, and automatic activation eligibility.
- Ensure ordinary task execution cannot auto-activate control-plane agents.
- Introduce one runtime-owned fault taxonomy.
- Introduce one runtime-owned `ExecutionIncident` object as the single durable failure truth.
- Make harness, CLI system, operator, and automation consume the same incident truth instead of producing parallel diagnoses.

## Non-Goals

- No redesign of task contract into `fast`, `full-path`, `short route`, or similar semantic variants.
- No prompt-only solution for small-model unreliability.
- No deletion of `operator` as an agent.
- No new compatibility identity that keeps control-plane behavior half-hidden but still routable from ordinary runtime flows.

## Design Decisions

### A. Actor classification becomes explicit runtime truth

Every runtime-relevant actor or actor-like object should have an explicit classification with at least:

- `plane`: `runtime | control_plane | tooling | automation`
- `mainViewVisible`: boolean
- `formalTimelineVisible`: boolean
- `autoWakeEligible`: boolean

These fields must be derived from one runtime-owned authority rather than duplicated across dashboard logic, timeline logic, and route logic.

Required semantics:

- `controller`
  - `plane: runtime`
  - `mainViewVisible: true`
  - `formalTimelineVisible: true`
  - `autoWakeEligible: true`
- worker/planner/researcher/reviewer/runtime bridge actors
  - `plane: runtime`
  - visible and auto-wake-eligible according to their runtime role
- `operator`
  - `plane: control_plane`
  - `mainViewVisible: false`
  - `formalTimelineVisible: false`
  - `autoWakeEligible: false` for ordinary task execution
- harness/tooling/automation objects
  - not part of the main role line even if they remain visible elsewhere

### B. Main-view surfaces use one visibility predicate

The following surfaces must all use the same predicate:

`plane === runtime && mainViewVisible === true`

Affected surfaces:

- dashboard graph
- dashboard main pipeline
- agents main list
- formal test timeline main actor lane

This does **not** mean those other planes disappear from the product. It means they appear only in their dedicated control/evidence surfaces, not as part of the main runtime role line.

### C. `operator` remains a real agent but only enters through control-plane surfaces

`operator` is preserved as an agent, but its activation path is narrowed:

- valid entry:
  - runtime operator/settings
  - `/watchdog/operator*`
  - admin/change-set/inspect/apply/verify surfaces
- invalid entry:
  - normal task contract dispatch
  - ordinary heartbeat fallback
  - pending-signal wake from task runtime
  - generic delivery recovery
  - formal test execution line

If ordinary task runtime wants escalation, it must write structured runtime diagnostics and stop. It must not auto-spawn or auto-wake `operator`.

### D. There is one formal task contract semantic

This slice assumes one formal `task contract` semantic.

Therefore:

- fail-fast logic must not branch on `short route` vs `full path`
- stop policy must be based on evidence of progress or non-progress
- runtime may still classify wake/delivery semantics, but not by pretending there are multiple task-contract classes

### E. Runtime adopts one fault taxonomy

Runtime owns the following fault classes:

- `tool_failure`
  - one tool invocation failed
- `retryable_runtime_failure`
  - transient transport/provider/runtime failure that runtime should retry
- `interaction_block`
  - permission, explicit deny, or deliberate control-plane block
- `llm_fault`
  - the actor had enough truth to proceed but behaved incorrectly
- `system_fault`
  - runtime amplified or misrouted failure despite enough evidence to stop
- `mixed_fault`
  - `llm_fault` occurred first and runtime then amplified it into `system_fault`

### F. Runtime only allows four stop-policy outcomes

For task execution, runtime should end each decision point in one of four outcomes:

- `continue`
- `retry_transport`
- `blocked`
- `terminate_with_diagnosis`

`terminate_with_diagnosis` should be preferred over late timeout if runtime already has enough evidence that the round is not making meaningful progress.

### G. Fail-fast must be evidence-driven

Because there is only one task contract semantic, fail-fast triggers should be based on runtime evidence such as:

- `identical_tool_loop`
  - same tool with identical input repeated past threshold
- `truth_reread_without_progress`
  - contract truth re-read after initial bind without formal progress
- `no_progress_budget_exhausted`
  - repeated tools with no valid output, no stage commit, no valid system action, and no recognized stage advancement
- `wrong_actor_activation`
  - ordinary execution activated a control-plane agent
- `timeout_without_termination`
  - runtime already had enough evidence to terminate but allowed timeout to occur instead

### H. Runtime owns one durable incident object

Introduce one durable runtime-owned object:

`ExecutionIncident`

Suggested fields:

- `incidentId`
- `contractId`
- `sessionKey`
- `epochKey`
- `agentId`
- `rootFault`
- `firstFaultCode`
- `amplifiers`
- `status`
  - `open | blocked | fail_fast | timed_out | completed_with_fault | resolved`
- `terminationReason`
- `evidence`
- `controlPlane`
- `openedAt`
- `amplifiedAt`
- `terminatedAt`
- `resolvedAt`

Runtime is the only owner allowed to:

- create incidents
- upgrade incident severity
- assign `rootFault`
- assign terminal status

### I. The four planes consume one incident truth

#### Runtime

Runtime is the incident owner.

It produces:

- fault classification
- stop-policy decision
- terminal reason

#### Harness

Harness does not invent a parallel taxonomy.

It only contributes:

- evaluation evidence
- replay evidence
- formal test evidence

Those should attach to incident evidence fields rather than becoming a separate canonical diagnosis.

#### CLI system

CLI system exposes and operates on incidents through surfaces such as:

- `incident.list`
- `incident.detail`
- `incident.verify`
- `incident.resolve`
- `incident.bind_test_run`

CLI system is the operator's hand, not a second owner of incident truth.

#### Operator

`operator` consumes incidents and performs governance actions such as:

- inspect
- apply
- verify
- resolve / keep-open

Those actions belong in control-plane records, not in the main task-execution lane.

#### Automation

Automation consumes terminalized incidents and linked evidence in order to:

- adjust profiles
- spawn follow-up governance tasks
- identify recurring runtime weaknesses

Automation should not redefine failure semantics while the task is still live.

## Data Flow

### 1. Ordinary task execution

- runtime actor starts
- tool and stage evidence accumulates
- fault evaluator updates or opens `ExecutionIncident`
- runtime either continues, retries transport, blocks, or terminates with diagnosis
- if terminated, terminal surfaces and formal tests point to the same incident

### 2. Control-plane follow-up

- operator inspects incident through dedicated surfaces
- operator actions attach control-plane metadata to the incident
- those actions do not appear as main-line runtime actor events

### 3. Harness/test verification

- formal test run produces replay/evaluation evidence
- harness binds evidence to the existing incident or incident-linked record
- failure conclusion remains incident-owned

## Error Handling

- If a task runtime path targets a control-plane-only actor, runtime must fail closed and record `wrong_actor_activation`.
- If incident persistence fails, runtime should continue but emit warning diagnostics; it must not silently fall back to ad hoc summaries.
- If incident evidence binding fails in harness/operator/automation consumers, the incident remains authoritative and the consumer emits its own local warning.
- If visibility predicates drift between surfaces, tests should fail; this is a semantic regression, not cosmetic variance.

## Testing

### New tests

- actor classification drives main-view visibility consistently across dashboard graph, pipeline, and formal timeline
- `operator` remains a real agent but is excluded from main-view runtime actor lanes
- ordinary task execution cannot auto-wake or auto-spawn `operator`
- repeated identical tool calls trigger incident fault escalation instead of ending only in timeout
- wrong-actor activation yields `system_fault` or `mixed_fault`, not silent continuation
- incident records are shared across runtime, harness, CLI system, and operator surfaces

### Updated tests

- update current dashboard/timeline tests that assume any agent-like object can appear in the main role line
- update formal test run assertions so operator actions appear as metadata/control-plane context instead of main actor sessions
- update failure tests so timeout is no longer the only expected terminal shape when earlier structured evidence exists

## Migration Plan

1. Introduce one actor-classification authority.
2. Update main-view surfaces to consume that authority.
3. Remove ordinary execution eligibility from `operator`.
4. Introduce `ExecutionIncident` and runtime fault evaluator.
5. Bind terminal/runtime/test/operator surfaces to the incident object.
6. Remove old timeout-shaped implicit failure assumptions from tests and diagnostics.

## Acceptance Criteria

- `operator` still exists as an agent, but it never appears in the main runtime role line.
- ordinary task execution no longer auto-activates `operator`.
- the main dashboard and formal execution timeline show only runtime actors.
- fail-fast behavior is evidence-driven and no longer depends on deprecated task-path classes.
- runtime, harness, CLI system, operator, and automation point to the same incident truth for a failing run.
