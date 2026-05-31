# Local Execution

> Block ID: `local-execution` | Type: `core`

## Responsibility

Own a single agent run lifecycle and local hook behavior.

## Owned Truth

- tracking state
- tool call window
- heartbeat signal
- agent lifecycle

## Interfaces

- before/after hooks
- heartbeat gate
- runtime mailbox

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- Keep changes inside this block unless the task is deliberately split.
- Cross-block runtime edits require an explicit split or interface-level change.

## Minimal Tests

- `extensions/watchdog/tests/agent-end-deferred-release.test.js`
- `extensions/watchdog/tests/max-tool-calls-hard-stop.test.js`

## Agent Assignment

Assign this block when changing what happens inside one agent wake/run/end cycle.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary local-execution
```

