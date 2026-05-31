# Verification Docs

> Block ID: `verification-docs` | Type: `support`

## Responsibility

Own repeatable test entrypoints, presets, reports, wiki, and implementation plans.

## Owned Truth

- test preset
- test report contract
- wiki concept
- implementation plan

## Interfaces

- test-runner CLI
- formal test catalog
- wiki schema

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- This block may support any primary block with tests or docs.
- It does not own runtime behavior just because a test mentions it.

## Minimal Tests

- `extensions/watchdog/tests/test-runner-cli-client.test.js`
- `extensions/watchdog/tests/formal-test-case-catalog.test.js`

## Agent Assignment

Assign this block when changing verification surfaces or project knowledge, and allow it as support for other blocks.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary verification-docs
```

