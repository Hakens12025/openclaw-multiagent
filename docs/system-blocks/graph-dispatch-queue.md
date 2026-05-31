# Graph Dispatch Queue

> Block ID: `graph-dispatch-queue` | Type: `core`

## Responsibility

Own graph authorization, conveyor dispatch, queueing, and pool claim/release.

## Owned Truth

- graph edge authorization
- conveyor dispatch
- runtime queue
- worker pool claim/release

## Interfaces

- agent graph API
- dispatch API
- queue state
- pool claim lifecycle

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- Keep changes inside this block unless the task is deliberately split.
- Cross-block runtime edits require an explicit split or interface-level change.

## Minimal Tests

- `extensions/watchdog/tests/dispatch-graph-policy.test.js`
- `extensions/watchdog/tests/dispatch-queue-maintenance.test.js`

## Agent Assignment

Assign this block when changing who can send work to whom, or when work waits.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary graph-dispatch-queue
```

