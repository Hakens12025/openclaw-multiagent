# System Blocks

> Formal project blocks define long-lived ownership boundaries for code, tests, docs, and agent work.

## What It Is

System Blocks are the formal responsibility board for OpenClaw. They are not git worktrees and not runtime layers. A block answers: which part of the system owns this truth, which files are normally inside it, which interfaces it exposes, and which tests prove it still works.

Runtime layers still explain architecture truth. System Blocks organize maintenance and multi-agent code updates. One block can span several runtime layers, and one runtime layer can have several blocks.

The machine-readable source is `extensions/watchdog/lib/dev/system-block-registry.js`. The CLI check is:

```bash
node scripts/openclaw-block-check.js --primary <block-id>
```

## Board

| Block | Owns |
|-------|------|
| `runtime-core` | Contract, envelope, runtime result, stores, ledgers, locks |
| `io-delivery` | ingress, QQ/WebUI/test source identity, replyTo, delivery |
| `agent-assembly` | AgentBinding, effective profile, policy, role specs, skills, guidance |
| `local-execution` | hooks, heartbeat, tool calls, tracking state, agent lifecycle |
| `graph-dispatch-queue` | graph edge authorization, conveyor dispatch, queue, pool |
| `loop-stage` | LoopSpec, LoopSession, stage result, stage projection |
| `harness-assurance` | harness runs, evidence, failure classification, review bridge |
| `operator-cli-control` | operator snapshot, CLI system, system action, admin surfaces |
| `automation-governance` | automation runtime, schedule triggers, governance decisions |
| `projection-ui` | dashboard, visual projection, SSE display state |
| `verification-docs` | test runner, presets, reports, wiki, plans, docs |

## Rules

- Every implementation task declares one primary block before code changes.
- `verification-docs` may support another primary block, but it does not own runtime truth.
- Cross-block runtime edits are a split signal, not a normal convenience.
- Tasks touching three or more non-support blocks must be split before implementation.
- Projection fixes belong to `projection-ui` only when runtime truth is already correct.
- If a block needs another block's behavior, change through the published interface or split the task.

## Agent Assignment

Use the per-block docs in `docs/system-blocks/` as agent handoff pages:

```text
docs/system-blocks/<block-id>.md
```

Each page states:

- responsibilities
- owned truth
- interfaces
- normal files
- boundaries
- minimal tests
- assignment wording

## Relationship To Other Concepts

| Concept | Relationship |
|---------|--------------|
| [System Layering](system-layering.md) | Runtime architecture truth; blocks organize maintenance ownership |
| [Conveyor Belt](conveyor-belt.md) | Transport truth mainly belongs to `graph-dispatch-queue` and `io-delivery` |
| [Harness](harness.md) | Harness internals belong to `harness-assurance`; harness does not own queue truth |
| [CLI System](cli-system.md) | Formal control surface belongs to `operator-cli-control` |
| [Dashboard](dashboard.md) | Visual expression belongs to `projection-ui` |
| [Test System](test-system.md) | Test runner and formal test surfaces belong to `verification-docs` |

## Current Status

Active. This page supersedes using memo 87 lanes as the primary project organization. Worktrees remain optional execution isolation; System Blocks are the formal board.
