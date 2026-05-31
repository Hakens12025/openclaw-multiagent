# Automation Governance

> Block ID: `automation-governance` | Type: `core`

## Responsibility

Own long-running automation, schedules, and governance decisions.

## Owned Truth

- automation registry
- automation runtime
- schedule trigger
- governance decision

## Interfaces

- automation executor
- schedule materializer
- profile lifecycle

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- Keep changes inside this block unless the task is deliberately split.
- Cross-block runtime edits require an explicit split or interface-level change.

## Minimal Tests

- `extensions/watchdog/tests/automation-store-locking.test.js`
- `extensions/watchdog/tests/schedule-materializer-locking.test.js`

## Agent Assignment

Assign this block when changing recurring work, due triggers, or policy evolution.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary automation-governance
```

