# System Block Entrypoint Sync Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make System Blocks the default development entry discipline, not just a wiki page.

**Architecture:** Add a doc-sync regression that requires root entry docs to point to System Blocks and requires per-block handoff pages to stay aligned with `system-block-registry.js`. Update only root guidance and docs.

**Tech Stack:** Node.js ESM, `node:test`, markdown docs.

---

### Task 1: Doc Sync Regression

**Files:**
- Create: `extensions/watchdog/tests/system-block-doc-sync.test.js`

- [x] **Step 1: Write failing test**

```bash
node --test extensions/watchdog/tests/system-block-doc-sync.test.js
```

Expected before docs update: root entry docs do not all mention System Blocks.

- [x] **Step 2: Verify per-block handoff docs against registry**

The test reads `SYSTEM_BLOCKS` and checks each `docs/system-blocks/<block-id>.md` file for title, block id, owned truth, minimal tests, and check command.

### Task 2: Root Entrypoint Updates

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CODEX.md`
- Modify: `AGENTS.md`

- [x] **Step 1: Add primary System Block discipline**

Require a primary System Block before implementation and point to `wiki/concepts/system-blocks.md` plus `docs/system-blocks/`.

- [x] **Step 2: Add check command to CODEX**

```bash
node scripts/openclaw-block-check.js --primary <block-id>
```

### Task 3: Verification

**Files:**
- No production runtime files.

- [x] **Step 1: Run doc-sync test**

```bash
node --test extensions/watchdog/tests/system-block-doc-sync.test.js
```

- [x] **Step 2: Run block check**

```bash
node scripts/openclaw-block-check.js --primary verification-docs
```

- [x] **Step 3: Check status**

```bash
git status --short --branch
```
