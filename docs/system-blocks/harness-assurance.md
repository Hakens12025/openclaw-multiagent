# Harness Assurance

> Block ID: `harness-assurance` | Type: `core`

## Responsibility

Own execution shaping, evidence capture, failure classification, and review bridge.

## Owned Truth

- HarnessRun
- module evidence
- failure classification
- review bridge payload

## Interfaces

- harness module contract
- harness runner
- evaluation bridge

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- This block observes and shapes execution evidence.
- It does not own dispatch queue truth, delivery truth, or automation governance.

## Minimal Tests

- `extensions/watchdog/tests/harness-module-contract.test.js`
- `extensions/watchdog/tests/harness-module-runner.test.js`

## Agent Assignment

Assign this block when changing how execution is observed, shaped, or judged as evidence.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary harness-assurance
```

