# System Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish formal project blocks so OpenClaw can assign maintenance work by responsibility domain instead of by ad hoc worktree or broad mega-project edits.

**Architecture:** `extensions/watchdog/lib/dev/system-block-registry.js` is the machine-readable source for block definitions and file ownership. `scripts/openclaw-block-check.js` reads git status and validates changes against a declared primary block. `wiki/concepts/system-blocks.md` and `docs/system-blocks/*.md` are the human-facing handoff layer.

**Tech Stack:** Node.js ESM, `node:test`, git CLI, existing wiki/docs structure.

---

### Task 1: Registry And Tests

**Files:**
- Create: `extensions/watchdog/lib/dev/system-block-registry.js`
- Create: `extensions/watchdog/tests/system-block-registry.test.js`

- [x] **Step 1: Write failing tests**

```bash
node --test extensions/watchdog/tests/system-block-registry.test.js
```

Expected before implementation: module not found.

- [x] **Step 2: Implement the registry**

Add 11 formal blocks: `runtime-core`, `io-delivery`, `agent-assembly`, `local-execution`, `graph-dispatch-queue`, `loop-stage`, `harness-assurance`, `operator-cli-control`, `automation-governance`, `projection-ui`, `verification-docs`.

- [x] **Step 3: Verify registry behavior**

```bash
node --test extensions/watchdog/tests/system-block-registry.test.js
```

Expected: 5 tests pass.

### Task 2: CLI Check

**Files:**
- Create: `scripts/openclaw-block-check.js`

- [x] **Step 1: Add CLI**

The CLI accepts `--primary <block-id>` and reports changed files by block.

- [x] **Step 2: Verify current change set**

```bash
node scripts/openclaw-block-check.js --primary verification-docs
```

Expected: current docs/dev-tool changes pass as `verification-docs`.

### Task 3: Human-Facing Board

**Files:**
- Create: `wiki/concepts/system-blocks.md`
- Create: `docs/system-blocks/*.md`
- Modify: `wiki/index.md`
- Modify: `wiki/log.md`
- Modify: `SYSTEM_MAP.md`

- [x] **Step 1: Add wiki concept**

Explain System Blocks as formal project responsibility domains, not runtime layers and not worktrees.

- [x] **Step 2: Add per-block handoff pages**

Generate one page per block with responsibility, owned truth, interfaces, boundaries, minimal tests, and agent assignment guidance.

- [x] **Step 3: Link the concept from entry points**

Add links from `wiki/index.md` and `SYSTEM_MAP.md`.

### Task 4: Verification

**Files:**
- No production runtime files.

- [x] **Step 1: Run registry tests**

```bash
node --test extensions/watchdog/tests/system-block-registry.test.js
```

- [x] **Step 2: Run block check**

```bash
node scripts/openclaw-block-check.js --primary verification-docs
```

- [x] **Step 3: Check status**

```bash
git status --short --branch
```
