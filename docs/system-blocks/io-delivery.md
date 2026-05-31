# IO Delivery

> Block ID: `io-delivery` | Type: `core`

## Responsibility

Own external ingress normalization and user-visible return routing.

## Owned Truth

- external source identity
- replyTo
- delivery ticket
- channel egress

## Interfaces

- ingress route payload
- delivery API
- QQ/WebUI/test source binding

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- Keep changes inside this block unless the task is deliberately split.
- Cross-block runtime edits require an explicit split or interface-level change.

## Minimal Tests

- `extensions/watchdog/tests/a2a-ingress-return.test.js`
- `extensions/watchdog/tests/delivery-semantics.test.js`

## Agent Assignment

Assign this block when changing how messages enter or leave OpenClaw.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary io-delivery
```

