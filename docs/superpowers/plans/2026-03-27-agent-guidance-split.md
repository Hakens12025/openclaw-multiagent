# Agent Guidance Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split workspace guidance into thin role/self, building directory, collaboration graph, runtime return, and platform operation docs without reintroducing mixed control-plane semantics.

**Architecture:** Keep `SOUL.md` as self/role truth, reduce `BUILDING-MAP.md` to a directory, add `COLLABORATION-GRAPH.md` and `RUNTIME-RETURN.md`, and update `AGENTS.md` plus relevant skills so startup reading becomes `SOUL -> contract -> PLATFORM-GUIDE`, with other docs read on demand. Implement through `agent-bootstrap.js` template refactoring backed by focused node tests.

**Tech Stack:** Node.js, built-in `node:test`, watchdog workspace guidance generator, markdown docs, OpenClaw skills.

---

### Task 1: Lock the New Guidance Contract with Tests

**Files:**
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/tests/contractor-routing-guidance.test.js`
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-agent-model.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/contractor-routing-guidance.test.js`

- [ ] **Step 1: Write the failing test expectations for contractor guidance split**

Add assertions that:
- `SOUL.md` still contains `单次对比、总结、报告类任务` and `标准 worker 路径`
- `BUILDING-MAP.md` no longer contains those contractor-specific routing rules
- `PLATFORM-GUIDE.md` no longer contains those contractor-specific routing rules
- `BUILDING-MAP.md` no longer contains `你可直接调用` or loop registry lines
- new docs `COLLABORATION-GRAPH.md` and `RUNTIME-RETURN.md` are generated

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `node --test /Users/hakens/.openclaw/extensions/watchdog/tests/contractor-routing-guidance.test.js`
Expected: FAIL because current guidance still puts role routing rules in `BUILDING-MAP.md` / `PLATFORM-GUIDE.md` and does not generate the new docs.

- [ ] **Step 3: Add agent model test coverage for AGENTS reading order**

Add a new case that generates workspace guidance and asserts `AGENTS.md` now says:
- read `SOUL.md`
- read current inbox input / `contract.json`
- read `PLATFORM-GUIDE.md`
- read `BUILDING-MAP.md` only when selecting collaborators
- read `COLLABORATION-GRAPH.md` only when checking explicit collaboration permissions
- read `RUNTIME-RETURN.md` only when handling return semantics

- [ ] **Step 4: Run the focused suite test to verify it fails**

Run: `node /Users/hakens/.openclaw/extensions/watchdog/test-runner.js --suite agent-model --filter planner-legacy-soul-upgrades-to-managed-template`
Expected: PASS for existing unrelated cases; newly added guidance-order case FAILS until implementation lands.

### Task 2: Refactor Guidance Generation in `agent-bootstrap.js`

**Files:**
- Modify: `/Users/hakens/.openclaw/extensions/watchdog/lib/agent-bootstrap.js`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/contractor-routing-guidance.test.js`

- [ ] **Step 1: Introduce separate template builders for graph and runtime return docs**

Implement dedicated builders so `buildBuildingMapTemplate(...)` stops embedding graph permissions and runtime return guidance. Add:
- `buildCollaborationGraphTemplate(...)`
- `buildRuntimeReturnTemplate(...)`

- [ ] **Step 2: Update `buildAgentsTemplate(...)` to the new reading order**

Change the generated `AGENTS.md` instructions to:
- `SOUL.md`
- current inbox input / `contract.json`
- `PLATFORM-GUIDE.md`
- `BUILDING-MAP.md` on collaborator selection
- `COLLABORATION-GRAPH.md` on explicit collaboration permission checks
- `RUNTIME-RETURN.md` on return semantics

- [ ] **Step 3: Move contractor-specific routing rules fully into `SOUL.md`**

Ensure planner/contractor “不要起 pipeline / 单次对比保持 worker 路径”等纠偏只留在 `SOUL.md`, not in `BUILDING-MAP.md` or `PLATFORM-GUIDE.md`.

- [ ] **Step 4: Make `BUILDING-MAP.md` a pure directory**

Keep only office directory content and “别人是谁” semantics. Remove:
- outgoing / incoming graph permissions
- registered loop list
- runtime return guidance
- contractor routing corrections

- [ ] **Step 5: Write new generated files during workspace sync**

Extend `syncAgentWorkspaceGuidance(...)` to write:
- `COLLABORATION-GRAPH.md`
- `RUNTIME-RETURN.md`

and include them in update results.

- [ ] **Step 6: Run targeted tests to verify they pass**

Run: `node --test /Users/hakens/.openclaw/extensions/watchdog/tests/contractor-routing-guidance.test.js`
Expected: PASS.

### Task 3: Align Platform Skills with the New Split

**Files:**
- Modify: `/Users/hakens/.openclaw/skills/platform-map/SKILL.md`
- Modify: `/Users/hakens/.openclaw/skills/platform-tools/SKILL.md`
- Modify: `/Users/hakens/.openclaw/skills/system-action/SKILL.md`

- [ ] **Step 1: Update `platform-map` to stop treating `BUILDING-MAP.md` as startup-first truth**

Change wording so:
- `SOUL.md` and current contract stay primary
- `BUILDING-MAP.md` is only for selecting collaborators / viewing office directory
- graph and runtime-return details point to their dedicated docs

- [ ] **Step 2: Update `system-action` to split candidate selection from permission checking**

Change wording so:
- use `BUILDING-MAP.md` to find likely collaborators
- use `COLLABORATION-GRAPH.md` to verify explicit permission
- do not claim `BUILDING-MAP.md` itself is the permission source

- [ ] **Step 3: Update `platform-tools` to use the new startup order**

Make it reflect:
- `SOUL`
- current inbox contract
- `PLATFORM-GUIDE`
- other docs on demand

- [ ] **Step 4: Run syntax and content sanity checks**

Run:
- `node --check /Users/hakens/.openclaw/extensions/watchdog/lib/agent-bootstrap.js`
- `rg -n "BUILDING-MAP.md.*出边|BUILDING-MAP.md.*你可直接调用|BUILDING-MAP.md.*runtime 自动回流" /Users/hakens/.openclaw/skills`
Expected: `node --check` PASS; search results should only show intentional descriptive references.

### Task 4: Regenerate Guidance and Run Verification

**Files:**
- Modify: `/Users/hakens/.codex/memories/openclaw-memory.md`
- Test: `/Users/hakens/.openclaw/extensions/watchdog/tests/suite-agent-model.js`

- [ ] **Step 1: Sync stable memory facts**

Update Codex memory with the stable rule:
- `SOUL` = self
- `BUILDING-MAP` = others directory
- `COLLABORATION-GRAPH` = explicit collaboration permissions
- `RUNTIME-RETURN` = hop-by-hop return semantics

- [ ] **Step 2: Run the relevant test surfaces**

Run:
- `node --test /Users/hakens/.openclaw/extensions/watchdog/tests/contractor-routing-guidance.test.js`
- `node /Users/hakens/.openclaw/extensions/watchdog/test-runner.js --suite agent-model`

Expected:
- contractor guidance test PASS
- agent-model suite PASS

- [ ] **Step 3: Summarize residual risks**

Record any remaining risk in the final summary:
- whether generated workspace docs in tracked workspaces still need manual regeneration
- whether any existing SOUL/skill text outside the touched files still references old startup order
