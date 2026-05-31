# Operator CLI Control

> Block ID: `operator-cli-control` | Type: `core`

## Responsibility

Own formal control surfaces for runtime inspection and controlled system action.

## Owned Truth

- operator snapshot
- CLI surface
- system action
- admin change set

## Interfaces

- operator snapshot API
- CLI system registry
- system action runtime
- admin surface

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- Keep changes inside this block unless the task is deliberately split.
- Cross-block runtime edits require an explicit split or interface-level change.

## Minimal Tests

- `extensions/watchdog/tests/cli-system-surface-basic.test.js`
- `extensions/watchdog/tests/operator-snapshot-summarizers.test.js`

## Agent Assignment

Assign this block when changing system control, inspect/apply/verify, or operator-facing surfaces.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary operator-cli-control
```

