# Runtime Core

> Block ID: `runtime-core` | Type: `core`

## Responsibility

Own runtime truth objects and persistence primitives.

## Owned Truth

- contract
- message envelope
- runtime result
- ledger
- lock/store

## Interfaces

- contract store API
- runtime result protocol
- control-plane store paths

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- Keep changes inside this block unless the task is deliberately split.
- Cross-block runtime edits require an explicit split or interface-level change.

## Minimal Tests

- `extensions/watchdog/tests/contract-store.test.js`
- `extensions/watchdog/tests/runtime-result-protocol.test.js`

## Agent Assignment

Assign this block when the task changes what the system considers true.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary runtime-core
```

