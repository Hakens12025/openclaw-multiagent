# Projection UI

> Block ID: `projection-ui` | Type: `core`

## Responsibility

Own dashboard and visual projection without owning runtime truth.

## Owned Truth

- projection state
- dashboard view model
- SSE display payload

## Interfaces

- dashboard modules
- operator UI
- work items UI

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- This block owns display and interaction, not runtime truth.
- If the source state is wrong, move the task to the truth-owning block.

## Minimal Tests

- `extensions/watchdog/tests/ui-router.test.js`
- `extensions/watchdog/tests/ui-store.test.js`

## Agent Assignment

Assign this block when changing what users see, not what the runtime decides.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary projection-ui
```

