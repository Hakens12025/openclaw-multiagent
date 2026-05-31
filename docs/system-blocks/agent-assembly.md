# Agent Assembly

> Block ID: `agent-assembly` | Type: `core`

## Responsibility

Own how runtime identities are assembled from config, profile, policy, skills, and guidance.

## Owned Truth

- AgentBinding
- effective profile
- execution policy
- role spec
- skill exposure

## Interfaces

- agent binding store
- effective profile composer
- workspace guidance writer

## Normal Files

The canonical file ownership rules live in `extensions/watchdog/lib/dev/system-block-registry.js`. Use this page for agent handoff and use the registry for automated checks.

## Boundaries

- Keep changes inside this block unless the task is deliberately split.
- Cross-block runtime edits require an explicit split or interface-level change.

## Minimal Tests

- `extensions/watchdog/tests/agent-binding-store-runtime-interop.test.js`
- `extensions/watchdog/tests/prompt-composition-minimal.test.js`

## Agent Assignment

Assign this block when changing what an agent is allowed or instructed to be.

Before implementation, run:

```bash
node scripts/openclaw-block-check.js --primary agent-assembly
```

