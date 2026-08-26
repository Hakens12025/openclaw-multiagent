/**
 * W2 TDD tests for automation-governance bugs:
 * 1. buildEditArgs missing --json flag
 * 2. reconcileAutomationRuntimeStates recovering a terminal round that belongs to another automation
 * (原 Bug 3 null harness defense 已随 harness 全退役删除——finalizeAutomationRound 不再产 HarnessRun，v226)
 */
import test from "node:test";
import assert from "node:assert/strict";

// ============================================================
// Bug 1: buildEditArgs (edit branch) must include --json
// Tested by exercising syncScheduleMaterialization twice:
//   - first add populates a jobId
//   - second call takes the edit branch; we capture argv
// ============================================================
import { syncScheduleMaterialization } from "../lib/schedule/schedule-materializer.js";

test("buildEditArgs (edit branch) omits --json (cron edit does not support it)", async () => {
  const scheduleId = `test-edit-json-${Date.now()}`;

  const spec = {
    id: scheduleId,
    enabled: true,
    trigger: { type: "cron", expr: "*/5 * * * *" },
    entry: { targetAgent: "controller", message: "run" },
  };

  // First call: add branch — always returns a jobId
  const addApi = {
    runtime: {
      system: {
        async runCommandWithTimeout() {
          return {
            code: 0,
            stdout: JSON.stringify({ id: `job:${scheduleId}` }),
            stderr: "",
          };
        },
      },
    },
  };
  await syncScheduleMaterialization(spec, { api: addApi });

  // Second call: edit branch — capture argv
  const capturedArgv = [];
  const editApi = {
    runtime: {
      system: {
        async runCommandWithTimeout(argv) {
          capturedArgv.push(...argv);
          return {
            code: 0,
            stdout: JSON.stringify({ id: `job:${scheduleId}` }),
            stderr: "",
          };
        },
      },
    },
  };
  await syncScheduleMaterialization(spec, { api: editApi });

  assert.ok(capturedArgv.includes("edit"), "second call must use edit branch");
  assert.ok(!capturedArgv.includes("--json"), "cron edit rejects --json (unknown option); edit branch must omit it and reuse the known jobId");
});

// ============================================================
// Bug 2: reconcileAutomationRuntimeStates must not recover a terminal round
// that belongs to a *different* automation.
//
// The original W2 bug lived in a second recovery leg that matched a concluded
// loop runtime by `runtime.activePipelineId` alone, with no automationId guard,
// so automation A could finalize a round minted by automation B. That leg was
// deleted with the loop-runtime retirement (2026-08-18): its own first gate,
// `resolveAutomationIdFromContext(loopRuntime.automationContext)`, was constantly
// null because loop runtimes never carry an automationContext, so it never ran in
// production.
//
// The surviving path (automation-reconcile.js, the `runtimeContract` block) makes
// the W2 bug class structurally impossible rather than guarded: it resolves the
// candidate through `runtime.activeContractId` -> `contractIndex.byId`, i.e. the
// contract *this* automation's own runtime state recorded. There is no cross-
// automation lookup key left to mismatch. This test locks that structure in:
// the recovery must key off activeContract*Id* + byId and call the contract-level
// finalizer, never a foreign identity.
// ============================================================
import { readFile } from "node:fs/promises";

test("reconcileAutomationRuntimeStates recovers terminal rounds through its own activeContractId, not a foreign identity", async () => {
  const reconcilePath = new URL(
    "../lib/automation/automation-reconcile.js",
    import.meta.url,
  ).pathname;

  const source = await readFile(reconcilePath, "utf8");

  const reconcileStart = source.indexOf("export async function reconcileAutomationRuntimeStates");
  assert.ok(reconcileStart >= 0, "reconcileAutomationRuntimeStates must exist");

  const reconcileBody = source.slice(reconcileStart);

  // The recovery candidate must be resolved from this automation's own runtime state.
  const lookupIdx = reconcileBody.indexOf("contractIndex.byId.get(runtime.activeContractId)");
  assert.ok(
    lookupIdx >= 0,
    "recovery candidate must be resolved via contractIndex.byId.get(runtime.activeContractId)"
    + " — that self-reference is what makes a cross-automation mismatch impossible",
  );

  // ...and it must be handed to the contract-level finalizer.
  const terminalCheckIdx = reconcileBody.indexOf("isTerminalContractStatus", lookupIdx);
  assert.ok(terminalCheckIdx >= 0, "recovery must gate on isTerminalContractStatus");

  const finalizerIdx = reconcileBody.indexOf("handleAutomationContractTerminal", terminalCheckIdx);
  assert.ok(
    finalizerIdx >= 0,
    "recovery must call handleAutomationContractTerminal after the terminal-status gate",
  );

  // No recovery leg may key off a loop/pipeline identity again.
  // Strip `//` comments first: the retirement rationale legitimately names the
  // deleted `activePipelineId` leg in prose, and this guard is about live code.
  const reconcileCode = reconcileBody.replace(/^\s*\/\/.*$/gmu, "");
  assert.ok(
    !reconcileCode.includes("activePipelineId") && !reconcileCode.includes("activeLoopId"),
    "reconcile must not reintroduce a pipeline/loop-identity recovery leg (that was the W2 bug shape)",
  );
});

