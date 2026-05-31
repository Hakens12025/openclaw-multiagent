# Loop Stage

> Block ID: `loop-stage` | Type: `core`

## Responsibility

Own repeated graph-backed progression and stage projection truth.

## Owned Truth

- LoopSpec
- LoopSession
- stage result
- stage projection

## Interfaces

- graph loop registry
- loop session store
- stage projection API

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- Keep changes inside this block unless the task is deliberately split.
- Cross-block runtime edits require an explicit split or interface-level change.

## Minimal Tests

- `extensions/watchdog/tests/loop-epoch-isolation.test.js`
- `extensions/watchdog/tests/stage-projection.test.js`

## Agent Assignment

Assign this block when changing loop progression, stages, or graph-backed repeated work.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary loop-stage
```

