# Runtime Dispatch Queue

> Runtime-owned contract dispatch queue and claim authority.

## Position

`runtime-dispatch-queue` owns the transition from a graph-selected next hop to a claimed execution contract session.

The queue is runtime truth. CLI system surfaces expose it for inspection.

## Owned Truth

- `control-plane/queue-state.json` stores target queue state.
- `dispatch-runtime-state` owns runtime target reservation: `idle`, `dispatching`, `busy`, `currentContract`, and FIFO queue entries. Runtime queue targets are graph-routed contract agents.
- `dispatch-graph-policy` owns graph next-hop selection, enqueue, drain, claim timeout handling, and retry scheduling.
- `routeInbox` owns staging the exact shared contract into the target workspace inbox.
- `tracker-store` owns whether a target session has actually claimed the contract.

## Claim Rule

A dispatch is successful only after the target contract session claims the same contract id.

```text
graph edge -> queue target -> stage exact contract -> wake exact session -> tracker claims contract
```

When the exact session claim times out:

- dispatch-state rolls back the transient reservation
- any unclaimed no-contract tracker for that exact session is removed
- the queue entry can be retried by the drain path
- runtime emits a claim-timeout diagnostic

## Drain Rule

Queue drain runs after the ending agent session has committed terminal tracking and released its tracker entry.

```text
agent terminal -> track_end/history -> delete tracker -> release/drain dispatch target -> stage next graph-selected contract
```

The previous running tracker is released before the next queued contract is staged. If drain observes the previous bound tracker, exact staging preserves the inbox and the queue enters claim-timeout retry.

## Staging Rule

Exact contract staging is stronger than stale unbound tracker residue.

This means a no-contract ghost tracking session yields to a later exact contract wake.

Exact contract staging is weaker than a real bound running tracker.

This means runtime preserves an agent inbox while that agent already has a different contract-bound running session.

## Four-Layer Boundary

- `Harness` verifies queue behavior through formal tests and runtime evidence. It does not mutate queue truth.
- `CLI system` exposes queue state, target reservations, tracking sessions, and split-brain diagnostics through stable inspect surfaces.
- `Operator` consumes queue diagnostics and uses formal reset or admin surfaces when intervention is needed. Queue files stay runtime-owned.
- `Automation` consumes runtime queue and harness outcomes as formal evidence. Queue state comes from runtime inspect surfaces.

Control-plane sessions are observability records. Runtime queue targets are graph-routed contract sessions that claim execution contracts.

Control-plane action starts from formal pending signals. Operator entry stays behind the control surface.

## Required Diagnostics

Runtime inspect surfaces must expose:

- running tracking sessions without contract
- idle targets with non-empty queue
- target queue depth and next queued contract
- claim timeout events

These diagnostics are runtime evidence for harness, operator, and automation decisions.
