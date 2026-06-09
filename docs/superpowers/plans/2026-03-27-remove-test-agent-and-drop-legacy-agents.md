# Remove Test Agent And Drop Legacy AGENTS Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the temporary `test` runtime agent from platform truth and make workspace guidance generation rely only on the managed AGENTS template.

**Architecture:** Tighten the guidance generator so AGENTS auto-upgrade only works for the managed template and the one explicit legacy marker template, not the old generic workspace template. Then remove `test` from runtime config so workspace directory generation, agent registration, and guidance sync stop treating it as a real platform node. Finally, regenerate runtime guidance and delete the obsolete `workspaces/test` directory.

**Tech Stack:** Node.js, OpenClaw watchdog runtime, node:test, JSON config, managed workspace guidance docs.

---

### Task 1: Lock Removal Behavior With Tests

**Files:**
- Modify: `extensions/watchdog/tests/suite-agent-model.js`
- Modify: `extensions/watchdog/tests/contractor-routing-guidance.test.js`

- [ ] Add a failing case proving old generic workspace `AGENTS.md` no longer auto-upgrades.
- [ ] Add/adjust assertions proving generated `BUILDING-MAP.md` no longer mentions the removed `test` agent when runtime config does not contain it.
- [ ] Run `node --test extensions/watchdog/tests/contractor-routing-guidance.test.js` and verify the new expectation fails for the intended reason.
- [ ] Run `node extensions/watchdog/test-runner.js --suite agent-model` and verify the compatibility-removal expectation fails for the intended reason.

### Task 2: Remove Compatibility Layer And Test Agent Truth

**Files:**
- Modify: `extensions/watchdog/lib/agent-bootstrap.js`
- Modify: `openclaw.json`

- [ ] Remove the old generic-workspace `AGENTS.md` compatibility predicate from the guidance writer.
- [ ] Keep managed-template updates intact and avoid broadening overwrite behavior for custom files.
- [ ] Remove the `test` agent entry from `openclaw.json` so runtime registration no longer includes it.
- [ ] Preserve test platform surfaces such as `test-inject` and `test-runs`; only the fake runtime agent is removed.

### Task 3: Verify Runtime Output And Clean Disk State

**Files:**
- Delete: `workspaces/test/**`
- Regenerate: managed workspace docs under `workspaces/*`

- [ ] Run the targeted test commands again and verify they pass.
- [ ] Regenerate runtime workspace guidance from `openclaw.json`.
- [ ] Confirm representative `BUILDING-MAP.md` files no longer mention `test` as a bridge node.
- [ ] Delete `/Users/hakens/.openclaw/workspaces/test`.
- [ ] Re-run the targeted verification commands and inspect output before reporting completion.
