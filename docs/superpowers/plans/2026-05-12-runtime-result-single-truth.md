# Runtime Result Single Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `stage_result.json` / `contract_result.json` outbox completion semantics with one canonical `outbox/runtime_result.json` protocol, with no compatibility reader and no prompt-level single-file/multi-file split.

**Architecture:** Runtime completion truth moves to a single JSON result file written by every contract session. The existing stage result object shape is renamed at the protocol boundary to runtime result while preserving downstream field names (`stageRunResult`, `stageCompletion`) only where they are internal runtime state, not agent-facing file names. Legacy `stage_result.json` and `contract_result.json` readers, hints, docs, and tests are removed instead of preserved as fallback paths.

**Tech Stack:** Node.js ESM, OpenClaw watchdog hooks, runtime mailbox outbox collection, protocol commit reconciliation, managed guidance/prompt generation, node:test.

---

## File Structure

- Modify `extensions/watchdog/lib/protocol-primitives.js`: add `ARTIFACT_TYPES.RUNTIME_RESULT`, remove `ARTIFACT_TYPES.STAGE_RESULT` as an agent-facing artifact type, keep internal `stageRunResult` field names untouched.
- Modify `extensions/watchdog/lib/routing/router-outbox-helpers.js`: replace `collectExplicitStageResult()` with `collectRuntimeResult()` that only reads `runtime_result.json`.
- Modify `extensions/watchdog/lib/routing/runtime-mailbox-outbox-handlers.js`: make worker outbox collection require `runtime_result.json`; remove `contract_result.json` reader and implicit markdown fallback.
- Modify `extensions/watchdog/hooks/before-tool-call.js`: path guard and hints only allow `outbox/runtime_result.json`.
- Modify `extensions/watchdog/hooks/after-tool-call.js`: tool progress tracking watches `outbox/runtime_result.json`.
- Modify `extensions/watchdog/lib/protocol-commit-reconcile.js` and `extensions/watchdog/lib/protocol-commit-observer.js`: canonical commit file becomes `runtime_result.json`; old names are rejected as non-canonical.
- Modify `extensions/watchdog/lib/contract-session-prompt-override.js`: English-only minimal prompt, remove `Role`, remove sensitive external action sentence, instruct deliverable + `outbox/runtime_result.json`.
- Modify `extensions/watchdog/lib/soul-template-builder.js` and `extensions/watchdog/lib/role-spec-registry.js`: compress execution role prompt, remove single-file/multi-file split, remove agent-facing `stage_result.json`.
- Modify `extensions/watchdog/lib/platform-doc-builder.js`, `extensions/watchdog/lib/semantic-skill-registry.js`, and `skills/platform-tools/SKILL.md`: replace `stage_result.json` / `contract_result.json` agent-facing references with `runtime_result.json`.
- Modify tests under `extensions/watchdog/tests/`: rename and update all mainline tests that write or assert `stage_result.json` / `contract_result.json`; delete compatibility expectations rather than preserving dual truth.

---

### Task 1: Define Runtime Result Protocol Constants

**Files:**
- Modify: `extensions/watchdog/lib/protocol-primitives.js`
- Test: `extensions/watchdog/tests/runtime-result-protocol.test.js`

- [ ] **Step 1: Write the failing protocol test**

Create `extensions/watchdog/tests/runtime-result-protocol.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  ARTIFACT_TYPES,
  RUNTIME_RESULT_FILE,
} from "../lib/protocol-primitives.js";

test("runtime result is the only agent-facing outbox result artifact", () => {
  assert.equal(RUNTIME_RESULT_FILE, "runtime_result.json");
  assert.equal(ARTIFACT_TYPES.RUNTIME_RESULT, "runtime_result");
  assert.equal("STAGE_RESULT" in ARTIFACT_TYPES, false);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node --test tests/runtime-result-protocol.test.js
```

Expected: FAIL because `RUNTIME_RESULT_FILE` and `ARTIFACT_TYPES.RUNTIME_RESULT` do not exist and `STAGE_RESULT` still exists.

- [ ] **Step 3: Add canonical protocol constants**

In `extensions/watchdog/lib/protocol-primitives.js`, add the file constant near `PROTOCOL_VERSION`:

```js
export const RUNTIME_RESULT_FILE = "runtime_result.json";
```

Update `ARTIFACT_TYPES`:

```js
export const ARTIFACT_TYPES = Object.freeze({
  RUNTIME_RESULT: "runtime_result",
  CONTRACT_UPDATE: "contract_update",
  RESEARCH_DIRECTION: "research_direction",
  RESEARCH_CONCLUSION: "research_conclusion",
  SEARCH_SPACE: "search_space",
  WORKFLOW_CONCLUSION: "workflow_conclusion",
  TEXT_OUTPUT: "text_output",
  DELIVERY: "delivery",
  CLARIFICATION_REQUEST: "clarification_request",
  EVALUATION_VERDICT: "evaluation_verdict",
  WORKFLOW_DECISION: "workflow_decision",
  NOTES: "notes",
});
```

Do not keep `STAGE_RESULT`. Do not add a legacy alias.

- [ ] **Step 4: Run the protocol test and verify it passes**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node --test tests/runtime-result-protocol.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/.openclaw
git add extensions/watchdog/lib/protocol-primitives.js extensions/watchdog/tests/runtime-result-protocol.test.js
git commit -m "feat: define runtime result protocol constant"
```

---

### Task 2: Replace Explicit Outbox Result Collector

**Files:**
- Modify: `extensions/watchdog/lib/routing/router-outbox-helpers.js`
- Modify: `extensions/watchdog/lib/routing/runtime-mailbox-outbox-handlers.js`
- Test: `extensions/watchdog/tests/outbox-runtime-result-truth.test.js`

- [ ] **Step 1: Write the failing collector tests**

Create `extensions/watchdog/tests/outbox-runtime-result-truth.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  collectWorkerOutbox,
} from "../lib/routing/runtime-mailbox-outbox-handlers.js";
import { agentWorkspace } from "../lib/state.js";
import {
  buildInitialTaskStagePlan,
  buildInitialTaskStageRuntime,
} from "../lib/task-stage-plan.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

async function writeActiveContract(agentId, contract) {
  const inboxDir = join(agentWorkspace(agentId), "inbox");
  await mkdir(inboxDir, { recursive: true });
  await writeFile(join(inboxDir, "contract.json"), JSON.stringify(contract, null, 2), "utf8");
}

async function cleanupWorkspace(agentId, artifactPaths = []) {
  for (const artifactPath of artifactPaths) {
    await rm(artifactPath, { force: true }).catch(() => {});
  }
  await rm(agentWorkspace(agentId), { recursive: true, force: true }).catch(() => {});
}

test("collectWorkerOutbox requires runtime_result.json and collects declared artifacts", async () => {
  const agentId = `worker-runtime-result-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-RUNTIME-RESULT-${Date.now()}`;
  const outputFileName = `${contractId}.md`;
  const stagePlan = buildInitialTaskStagePlan({
    contractId,
    stages: ["完成用户目标"],
  });
  const stageRuntime = buildInitialTaskStageRuntime({ stagePlan });
  let artifactPaths = [];

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "回答今天星期几",
      assignee: agentId,
      output: join(agentWorkspace("controller"), "output", `${contractId}.md`),
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
      stagePlan,
      stageRuntime,
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, outputFileName), "今天是星期二。\n", "utf8");
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "Answered the weekday question.",
      artifacts: [{
        type: "text_output",
        path: outputFileName,
        label: "final_answer",
        primary: true,
        required: true,
      }],
      primaryArtifactPath: outputFileName,
      completion: {
        status: "completed",
        transition: { kind: "follow_graph", reason: "completed" },
      },
    }, null, 2), "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["runtime_result.json", outputFileName],
      logger,
      manifest: null,
    });
    artifactPaths = result.artifactPaths || [];

    assert.equal(result.collected, true);
    assert.equal(result.explicitRuntimeResult, true);
    assert.equal(result.stageRunResult?.semanticStageId, stageRuntime.currentStageId);
    assert.equal(result.stageCompletion?.transition?.kind, "follow_graph");
    assert.equal(result.primaryOutputPath?.endsWith(`/${outputFileName}`), true);
  } finally {
    await cleanupWorkspace(agentId, artifactPaths);
  }
});

test("collectWorkerOutbox rejects stage_result.json and contract_result.json as legacy dual truth", async () => {
  const agentId = `worker-runtime-result-reject-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  const contractId = `TC-RUNTIME-RESULT-REJECT-${Date.now()}`;

  try {
    await writeActiveContract(agentId, {
      id: contractId,
      task: "legacy result should not be accepted",
      assignee: agentId,
      status: "running",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    await mkdir(outboxDir, { recursive: true });
    await writeFile(join(outboxDir, "legacy.md"), "legacy output\n", "utf8");
    await writeFile(join(outboxDir, "stage_result.json"), JSON.stringify({
      version: 1,
      status: "completed",
      summary: "legacy stage result",
    }), "utf8");
    await writeFile(join(outboxDir, "contract_result.json"), JSON.stringify({
      status: "completed",
      summary: "legacy contract result",
    }), "utf8");

    const result = await collectWorkerOutbox({
      agentId,
      outboxDir,
      files: ["stage_result.json", "contract_result.json", "legacy.md"],
      logger,
      manifest: null,
    });

    assert.equal(result.collected, false);
    assert.match(result.error || "", /runtime_result\.json/);
  } finally {
    await cleanupWorkspace(agentId);
  }
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node --test tests/outbox-runtime-result-truth.test.js
```

Expected: FAIL because the collector still accepts `stage_result.json`, accepts implicit markdown fallback, and does not return `explicitRuntimeResult`.

- [ ] **Step 3: Replace the explicit result collector**

In `extensions/watchdog/lib/routing/router-outbox-helpers.js`, import `RUNTIME_RESULT_FILE`:

```js
import { ARTIFACT_TYPES, RUNTIME_RESULT_FILE } from "../protocol-primitives.js";
```

Rename `collectExplicitStageResult` to `collectRuntimeResult`. Replace the file lookup with:

```js
const runtimeResultFile = findManifestArtifactFile(
  manifest,
  ARTIFACT_TYPES.RUNTIME_RESULT,
  files,
  [RUNTIME_RESULT_FILE],
);
if (!runtimeResultFile) {
  return { collected: false, error: `missing ${RUNTIME_RESULT_FILE}` };
}
```

Read `runtimeResultFile`, normalize it with `normalizeStageRunResult(parsed, defaults)`, and keep returning the same internal runtime fields:

```js
return {
  collected: true,
  files: materialized.collected,
  artifactPaths: stageRunResult?.artifacts.map((artifact) => artifact.path) || [],
  primaryOutputPath: stageRunResult?.primaryArtifactPath || null,
  stageRunResult,
  stageCompletion: normalizeStageCompletion(parsed.completion, stageRunResult?.completion || {}),
  explicitRuntimeResult: true,
};
```

Update warnings from `stage_result` to `runtime_result`.

- [ ] **Step 4: Remove worker legacy fallback readers**

In `extensions/watchdog/lib/routing/runtime-mailbox-outbox-handlers.js`:

- Replace all `collectExplicitStageResult` imports/calls with `collectRuntimeResult`.
- Remove the whole `contract_result.json` parsing block.
- Remove implicit markdown fallback in `collectWorkerOutbox`.
- Make `collectWorkerOutbox` return the `collectRuntimeResult(...)` result directly.

The worker handler shape should be:

```js
export async function collectWorkerOutbox({ agentId, outboxDir, files, logger, manifest }) {
  return collectRuntimeResult({
    agentId,
    outboxDir,
    files,
    logger,
    manifest,
    activeContract: await readActiveInboxContract(agentId),
  });
}
```

Do not leave a fallback to `.md`, `stage_result.json`, or `contract_result.json`.

- [ ] **Step 5: Run the collector test and verify it passes**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node --test tests/outbox-runtime-result-truth.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/.openclaw
git add extensions/watchdog/lib/routing/router-outbox-helpers.js extensions/watchdog/lib/routing/runtime-mailbox-outbox-handlers.js extensions/watchdog/tests/outbox-runtime-result-truth.test.js
git commit -m "feat: make runtime_result the only worker outbox truth"
```

---

### Task 3: Update Tool Guards and Commit Observation

**Files:**
- Modify: `extensions/watchdog/hooks/before-tool-call.js`
- Modify: `extensions/watchdog/hooks/after-tool-call.js`
- Modify: `extensions/watchdog/lib/protocol-commit-reconcile.js`
- Modify: `extensions/watchdog/lib/protocol-commit-observer.js`
- Test: `extensions/watchdog/tests/before-tool-call-path-guard.test.js`
- Test: `extensions/watchdog/tests/protocol-commit-reconcile.test.js`

- [ ] **Step 1: Update failing tests for the new canonical file**

In `extensions/watchdog/tests/before-tool-call-path-guard.test.js`, change any expected allowed formal result path from:

```js
join(agentWorkspace(agentId), "outbox", "stage_result.json")
```

to:

```js
join(agentWorkspace(agentId), "outbox", "runtime_result.json")
```

Add an assertion that writing `stage_result.json` is blocked:

```js
assert.match(blockedStageResult.blockReason, /runtime_result\.json/u);
```

In `extensions/watchdog/tests/protocol-commit-reconcile.test.js`, replace setup writes and assertions for `stage_result.json` with `runtime_result.json`, and add one rejection test:

```js
test("protocol commit observer does not treat stage_result as canonical runtime result", async () => {
  const agentId = `stage-result-legacy-${Date.now()}`;
  const outboxDir = join(agentWorkspace(agentId), "outbox");
  await mkdir(outboxDir, { recursive: true });
  await writeFile(join(outboxDir, "stage_result.json"), JSON.stringify({ status: "completed" }), "utf8");

  const observed = await observeProtocolCommit({
    agentId,
    filePath: join(outboxDir, "stage_result.json"),
  });

  assert.equal(observed?.type === "runtime_result", false);
});
```

Use the actual exported observer function name in the file; do not invent a new helper if the test already has a local wrapper.

- [ ] **Step 2: Run the guard/reconcile tests and verify they fail**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node --test tests/before-tool-call-path-guard.test.js tests/protocol-commit-reconcile.test.js
```

Expected: FAIL with references to `stage_result.json` still being the accepted path.

- [ ] **Step 3: Change before-tool-call guard text and allowed path**

In `extensions/watchdog/hooks/before-tool-call.js`:

- Rename helper text to return `Write relative path outbox/runtime_result.json.`
- Replace path construction from `"stage_result.json"` to `"runtime_result.json"`.
- Replace block reasons that mention `contract.output or outbox/stage_result.json` with `outbox/runtime_result.json and declared artifacts`.
- Replace basename check from `"stage_result.json"` to `"runtime_result.json"`.
- Ensure `stage_result.json` is not treated as a valid formal result path.

- [ ] **Step 4: Change after-tool-call watcher path**

In `extensions/watchdog/hooks/after-tool-call.js`, replace:

```js
join(agentWorkspace(agentId), "outbox", "stage_result.json")
```

with:

```js
join(agentWorkspace(agentId), "outbox", "runtime_result.json")
```

- [ ] **Step 5: Change protocol commit reconciliation**

In `extensions/watchdog/lib/protocol-commit-reconcile.js` and `extensions/watchdog/lib/protocol-commit-observer.js`:

- Import or define the canonical `RUNTIME_RESULT_FILE`.
- Replace `basename(...) === "stage_result.json"` with `basename(...) === RUNTIME_RESULT_FILE`.
- Replace returned fileName values with `"runtime_result.json"`.
- Replace protocol type labels with `runtime_result` where agent-facing.
- Do not accept `stage_result.json` as an alias.

- [ ] **Step 6: Run guard/reconcile tests and verify they pass**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node --test tests/before-tool-call-path-guard.test.js tests/protocol-commit-reconcile.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd ~/.openclaw
git add extensions/watchdog/hooks/before-tool-call.js extensions/watchdog/hooks/after-tool-call.js extensions/watchdog/lib/protocol-commit-reconcile.js extensions/watchdog/lib/protocol-commit-observer.js extensions/watchdog/tests/before-tool-call-path-guard.test.js extensions/watchdog/tests/protocol-commit-reconcile.test.js
git commit -m "feat: route protocol commits through runtime_result"
```

---

### Task 4: Rewrite Agent-Facing Prompt and Guidance

**Files:**
- Modify: `extensions/watchdog/lib/contract-session-prompt-override.js`
- Modify: `extensions/watchdog/lib/soul-template-builder.js`
- Modify: `extensions/watchdog/lib/role-spec-registry.js`
- Modify: `extensions/watchdog/lib/platform-doc-builder.js`
- Modify: `extensions/watchdog/lib/semantic-skill-registry.js`
- Modify: `skills/platform-tools/SKILL.md`
- Test: `extensions/watchdog/tests/contract-session-prompt-override.test.js`
- Test: `extensions/watchdog/tests/soul-template-builder.test.js`
- Test: `extensions/watchdog/tests/delivery-semantics.test.js`
- Test: `extensions/watchdog/tests/protocol-doc-sync.test.js`

- [ ] **Step 1: Update prompt tests first**

In `extensions/watchdog/tests/contract-session-prompt-override.test.js`, assert all of the following:

```js
assert.match(prompt, /Agent: `worker`/);
assert.doesNotMatch(prompt, /Role:/);
assert.match(prompt, /Write the user-facing deliverable\./);
assert.match(prompt, /Write `outbox\/runtime_result\.json` to declare the runtime result\./);
assert.doesNotMatch(prompt, /Sensitive external actions require human confirmation/);
assert.doesNotMatch(prompt, /single-file|multi-file|simple questions|one-line answer/i);
assert.doesNotMatch(prompt, /[\u4e00-\u9fff]/u);
```

In `extensions/watchdog/tests/soul-template-builder.test.js`, add an executor prompt compression assertion:

```js
test("executor template uses runtime_result without single or multi file branches", () => {
  const soul = buildSoulTemplate("worker-x", AGENT_ROLE.EXECUTOR);
  assert.match(soul, /runtime_result\.json/);
  assert.doesNotMatch(soul, /单文件|多文件|single-file|multi-file/i);
  assert.doesNotMatch(soul, /stage_result\.json|contract_result\.json/);
});
```

- [ ] **Step 2: Run prompt tests and verify they fail**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node --test tests/contract-session-prompt-override.test.js tests/soul-template-builder.test.js
```

Expected: FAIL because current prompt still includes `Role` and old SOUL text.

- [ ] **Step 3: Rewrite contract session prompt**

In `extensions/watchdog/lib/contract-session-prompt-override.js`:

- Remove the role lookup and `Role:` line.
- Remove the sensitive external action sentence.
- Keep text English-only in the generated wrapper.
- Replace runtime task bullets with:

```js
"## Current Contract",
"",
"- Use the current wake message as the task source.",
"- Use exact paths and contract id from the current wake message.",
"- Write the user-facing deliverable.",
"- Write `outbox/runtime_result.json` to declare the runtime result.",
"- `primaryArtifactPath` points to the main user-facing artifact.",
"- After the deliverable and runtime result are written, answer with a short completion statement.",
```

Keep `SOUL.md` and `HEARTBEAT.md` inclusion unchanged for now; those files are rewritten in this task.

- [ ] **Step 4: Compress executor and planner SOUL**

In `extensions/watchdog/lib/soul-template-builder.js`:

- Remove the executor single-file/multi-file section.
- Add a concise result section:

```md
## Runtime result

- Write the deliverable artifact for this contract.
- Write `outbox/runtime_result.json` with status, summary, artifacts, primaryArtifactPath, and completion.
- Finish the current turn after the runtime result is written.
```

- Keep planner `[STAGE]` format if still needed for stage extraction, but remove simple/complex language.
- Remove agent-facing references to `stage_result.json` and `contract_result.json`.

In `extensions/watchdog/lib/role-spec-registry.js`, keep role principles short and remove file-specific dispatch instructions other than `runtime_result.json`.

- [ ] **Step 5: Update platform docs and skill registry**

In `extensions/watchdog/lib/semantic-skill-registry.js`, replace tool refs:

```js
"outbox/runtime_result.json"
```

and remove:

```js
"outbox/stage_result.json"
"outbox/contract_result.json"
```

In `skills/platform-tools/SKILL.md`, rewrite output rules:

```md
## Output rules

- Write the user-facing artifact requested by the contract.
- Write `outbox/runtime_result.json` with status, summary, artifacts, primaryArtifactPath, and completion.
- Runtime reads `runtime_result.json` for routing, delivery, harness, operator, automation, and CLI evidence.
```

In `extensions/watchdog/lib/platform-doc-builder.js`, replace any generated platform guide examples with `runtime_result.json`.

- [ ] **Step 6: Run prompt/doc tests and verify they pass**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node --test tests/contract-session-prompt-override.test.js tests/soul-template-builder.test.js tests/delivery-semantics.test.js tests/protocol-doc-sync.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd ~/.openclaw
git add extensions/watchdog/lib/contract-session-prompt-override.js extensions/watchdog/lib/soul-template-builder.js extensions/watchdog/lib/role-spec-registry.js extensions/watchdog/lib/platform-doc-builder.js extensions/watchdog/lib/semantic-skill-registry.js skills/platform-tools/SKILL.md extensions/watchdog/tests/contract-session-prompt-override.test.js extensions/watchdog/tests/soul-template-builder.test.js extensions/watchdog/tests/delivery-semantics.test.js extensions/watchdog/tests/protocol-doc-sync.test.js
git commit -m "feat: teach agents runtime_result protocol"
```

---

### Task 5: Rename Tests and Remove Legacy Expectations

**Files:**
- Modify: `extensions/watchdog/tests/outbox-stage-semantic-truth.test.js`
- Modify: `extensions/watchdog/tests/evaluator-outbox-unification.test.js`
- Modify: `extensions/watchdog/tests/runtime-loop-budget-governance.test.js`
- Modify: `extensions/watchdog/tests/loop-semantic-stage-projection.test.js`
- Modify: `extensions/watchdog/tests/contractor-handoff-terminal.test.js`
- Modify: `extensions/watchdog/tests/runtime-reset-guidance-sync.test.js`
- Modify: `extensions/watchdog/tests/evaluator-result.test.js`
- Modify: every remaining test file found by `rg -n "stage_result\\.json|contract_result\\.json" extensions/watchdog/tests`

- [ ] **Step 1: Run the full legacy reference search**

Run:

```bash
cd ~/.openclaw
rg -n "stage_result\\.json|contract_result\\.json" extensions/watchdog/tests extensions/watchdog/lib hooks skills docs
```

Expected before edits: many matches.

- [ ] **Step 2: Replace test fixtures with runtime_result**

For every test fixture that writes:

```js
await writeFile(join(outboxDir, "stage_result.json"), JSON.stringify({...}, null, 2), "utf8");
```

replace with:

```js
await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({...}, null, 2), "utf8");
```

For every `files` array containing `"stage_result.json"`, replace with `"runtime_result.json"`.

For every path guard expectation containing `outbox/stage_result.json`, replace with `outbox/runtime_result.json`.

For every assertion that `artifactRef === "stage_result.json"`, replace with `"runtime_result.json"` only if the artifact is the runtime result itself; otherwise assert the user artifact path.

- [ ] **Step 3: Delete compatibility tests**

Delete or rewrite tests whose purpose is to prove fallback acceptance of:

- bare markdown output without `runtime_result.json`
- `stage_result.json`
- `contract_result.json`

Replacement assertion: those inputs are rejected and mention `runtime_result.json`.

- [ ] **Step 4: Run the updated targeted suites**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node --test tests/outbox-stage-semantic-truth.test.js tests/evaluator-outbox-unification.test.js tests/runtime-loop-budget-governance.test.js tests/contractor-handoff-terminal.test.js tests/runtime-reset-guidance-sync.test.js tests/evaluator-result.test.js
```

Expected: PASS after fixture updates.

- [ ] **Step 5: Verify no legacy protocol references remain in active code/tests/docs**

Run:

```bash
cd ~/.openclaw
rg -n "stage_result\\.json|contract_result\\.json" extensions/watchdog/lib extensions/watchdog/hooks extensions/watchdog/tests skills docs
```

Expected: no matches, except this implementation plan file if it remains in the grep scope.

- [ ] **Step 6: Commit**

```bash
cd ~/.openclaw
git add extensions/watchdog/tests extensions/watchdog/lib extensions/watchdog/hooks skills docs
git commit -m "test: migrate result fixtures to runtime_result"
```

---

### Task 6: End-to-End Verification and Runtime Restart Check

**Files:**
- Modify only if tests expose missed references.

- [ ] **Step 1: Run protocol/prompt targeted tests**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node --test \
  tests/runtime-result-protocol.test.js \
  tests/outbox-runtime-result-truth.test.js \
  tests/contract-session-prompt-override.test.js \
  tests/soul-template-builder.test.js \
  tests/before-tool-call-path-guard.test.js \
  tests/protocol-commit-reconcile.test.js
```

Expected: PASS.

- [ ] **Step 2: Run broader runtime suites**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node --test \
  tests/delivery-semantics.test.js \
  tests/task-stage-runtime.test.js \
  tests/terminal-outcome.test.js \
  tests/terminal-truth-consumers.test.js \
  tests/agent-end-pipeline-route-ownership.test.js
```

Expected: PASS. If a test uses `mock.module`, rerun it with:

```bash
node --experimental-test-module-mocks --test <test-file>
```

- [ ] **Step 3: Sync managed guidance before live test**

Run the existing guidance sync/takeover path used by this repo to rewrite managed `SOUL.md` and `HEARTBEAT.md`. If there is no CLI helper, restart watchdog with the current workspace guidance sync enabled and verify the files:

```bash
rg -n "stage_result\\.json|contract_result\\.json|Role:|Sensitive external actions" ~/.openclaw/workspaces
```

Expected: no active managed workspace prompt contains those strings.

- [ ] **Step 4: Restart gateway**

Restart the OpenClaw gateway/watchdog service using the project’s normal command. Do not rely on hot-loaded code for this migration.

- [ ] **Step 5: Run a real `simple-01`**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node test-runner.js --case simple-01
```

Expected:

- PASS.
- Runtime route follows graph.
- Agent prompt no longer includes `Role:`.
- Agent prompt no longer includes the sensitive external action sentence.
- Outbox completion is observed through `runtime_result.json`.
- Report output does not show minBytes as answer-quality truth.

- [ ] **Step 6: Run a real complex case**

Run:

```bash
cd ~/.openclaw/extensions/watchdog
node test-runner.js --case complex-02
```

Expected:

- PASS or a real model-quality failure with preserved runtime evidence.
- No system fallback to `stage_result.json`, `contract_result.json`, or bare markdown completion.

- [ ] **Step 7: Final grep audit**

Run:

```bash
cd ~/.openclaw
rg -n "stage_result\\.json|contract_result\\.json" extensions/watchdog/lib extensions/watchdog/hooks extensions/watchdog/tests skills docs ~/.codex/memories
```

Expected: no active references. Historical memo references may remain only if clearly historical and outside runtime/prompt truth.

- [ ] **Step 8: Commit verification-only fixes if any**

If Step 1-7 required fixes:

```bash
cd ~/.openclaw
git add <changed-files>
git commit -m "fix: close runtime_result migration gaps"
```

If no fixes were required, do not create an empty commit.

---

## Self-Review

- Spec coverage: The plan covers prompt removal (`Role`, sensitive external action), English minimal wrapper, worker prompt compression, single-file/multi-file unification, `runtime_result.json` schema, runtime collector migration, path guard migration, doc/skill updates, tests, restart, and live simple/complex checks.
- Compatibility policy: The plan explicitly rejects `stage_result.json`, `contract_result.json`, and bare markdown fallback. It does not add a legacy reader or alias.
- Type consistency: The agent-facing file name is consistently `runtime_result.json`; internal runtime state remains `stageRunResult` / `stageCompletion` to avoid unnecessary downstream object churn.
