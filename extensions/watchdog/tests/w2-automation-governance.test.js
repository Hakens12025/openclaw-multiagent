/**
 * W2 TDD tests for automation-governance bugs:
 * 1. buildEditArgs missing --json flag
 * 2. reconcileAutomationRuntimeStates missing automationId check in concluded-loopRuntime recovery
 * 3. null harness result defense in finalizeAutomationRound (nextHarnessRun falls back to prefinalizedHarness)
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
// Bug 2: reconcileAutomationRuntimeStates must check automationId
// The bug: lines 534-540 check pipelineId+concluded but NOT automationId.
// startAutomationRound lines 106-112 has the guard; reconcile does not.
// We test by inspecting the source: the concluded-recovery if-block must
// include resolveAutomationIdFromContext(...) === spec.id on the SAME condition.
// ============================================================
import { readFile } from "node:fs/promises";

test("reconcileAutomationRuntimeStates concluded-loopRuntime recovery includes automationId guard", async () => {
  const executorPath = new URL(
    "../lib/automation/automation-reconcile.js",
    import.meta.url,
  ).pathname;

  const source = await readFile(executorPath, "utf8");

  // Locate the reconcile function
  const reconcileStart = source.indexOf("export async function reconcileAutomationRuntimeStates");
  assert.ok(reconcileStart >= 0, "reconcileAutomationRuntimeStates must exist");

  const reconcileBody = source.slice(reconcileStart);

  // Find the pipelineId-concludedStage recovery block
  // It looks like: normalizeString(runtime?.activePipelineId) ... "concluded"
  const pipelineIdCheckIdx = reconcileBody.indexOf("activePipelineId");
  assert.ok(pipelineIdCheckIdx >= 0, "reconcile must reference activePipelineId");

  const concludedCheckIdx = reconcileBody.indexOf('"concluded"', pipelineIdCheckIdx);
  assert.ok(concludedCheckIdx >= 0, 'reconcile must check === "concluded"');

  // After the fix: resolveAutomationIdFromContext must appear WITHIN the same if-condition
  // i.e., between the activePipelineId check and the closing ) of the if condition.
  // The if-block ends with ")" followed by "{". Find the closing paren of the condition.
  const ifBlockStart = reconcileBody.lastIndexOf("if (", concludedCheckIdx);
  assert.ok(ifBlockStart >= 0, "there must be an if-block containing the concluded check");

  // Find the close of the if-condition: look for ") {" or ")\n  {" after concludedCheckIdx
  const ifBodyStart = reconcileBody.indexOf(") {", concludedCheckIdx);
  assert.ok(ifBodyStart >= 0, "the if condition must close before the block body");

  const ifCondition = reconcileBody.slice(ifBlockStart, ifBodyStart + 2);

  assert.ok(
    ifCondition.includes("resolveAutomationIdFromContext"),
    "the concluded-recovery if-condition must include resolveAutomationIdFromContext for automationId guard:\n"
    + `Actual condition: ${ifCondition}`,
  );
});

// ============================================================
// Bug 3: null harness defense
// When finalizeHarnessRunModules returns null, nextHarnessRun must fall
// back to prefinalizedHarness, not be null.
// We test by inspecting the source for the fallback pattern.
// ============================================================

test("finalizeAutomationRound uses prefinalizedHarness as fallback when evaluatedHarness is null (source guard present)", async () => {
  const executorPath = new URL(
    "../lib/automation/automation-finalize.js",
    import.meta.url,
  ).pathname;

  const source = await readFile(executorPath, "utf8");

  // Find finalizeAutomationRound body
  const fnStart = source.indexOf("async function finalizeAutomationRound");
  assert.ok(fnStart >= 0, "finalizeAutomationRound must exist");

  const fnBody = source.slice(fnStart, fnStart + 3000);

  // After the fix, nextHarnessRun must include prefinalizedHarness as a fallback.
  // Valid patterns: "|| prefinalizedHarness" or "?? prefinalizedHarness"
  const hasFallback = fnBody.includes("|| prefinalizedHarness")
    || fnBody.includes("?? prefinalizedHarness");

  assert.ok(
    hasFallback,
    "finalizeAutomationRound must fall back to prefinalizedHarness when evaluatedHarness is null",
  );
});
