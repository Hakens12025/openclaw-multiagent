# Stage

> Block ID: `stage` | Type: `core`

## Responsibility

Own task stage planning, stage run results, and stage projection truth.

## Owned Truth

- stage plan
- stage runtime
- stage result
- stage projection

## Interfaces

- task stage plan API
- stage result normalizer
- stage projection API

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- Keep changes inside this block unless the task is deliberately split.
- Cross-block runtime edits require an explicit split or interface-level change.

## Minimal Tests

- `extensions/watchdog/tests/task-stage-plan.test.js`
- `extensions/watchdog/tests/stage-projection.test.js`

## Agent Assignment

Assign this block when changing task stage plans, stage advancement, or stage projection.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary stage
```

