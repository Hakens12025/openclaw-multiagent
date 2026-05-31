// tests/contract-outcome-tests-passed-derivation.test.js
// TDD: Bug fix — normalizeBoolean(undefined) was returning false instead of null,
// causing deriveTestsPassed to always return false (reviewerTestsPassed != null always true),
// verdict-based fallback ("pass"→true / "fail"→false) never executed.
//
// After fix: undefined/null/non-boolean testsPassed → null, allowing verdict fallback.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import { evaluateContractOutcome } from "../lib/contract-outcome.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

// Helper: build a minimal contract with no completion criteria files
function noArtifactContract(id) {
  return {
    id,
    task: "test task",
    status: CONTRACT_STATUS.RUNNING,
    completionCriteria: {},
  };
}

// ── Core regression: verdict fallback must execute when testsPassed is absent ───

test("deriveTestsPassed: verdict=pass sets testsPassed=true when reviewerResult.testsPassed is absent", async () => {
  const outputPath = `/tmp/tpd-pass-verdict-${Date.now()}.md`;
  await writeFile(outputPath, "output content\n", "utf8");
  try {
    const outcome = await evaluateContractOutcome(
      {
        id: "TPD-PASS-VERDICT",
        task: "test",
        status: CONTRACT_STATUS.RUNNING,
        output: outputPath,
      },
      {
        collected: true,
        stageRunResult: {
          version: 1,
          status: "completed",
          artifacts: [],
        },
        reviewerResult: {
          verdict: "pass",
          // testsPassed intentionally absent — should fall through to verdict
        },
      },
    );
    // The outcome might be COMPLETED (artifact found) or FAILED (no artifact)
    // What we care about is testsPassed derived from verdict, not locked to false
    assert.equal(outcome.testsPassed, true, "verdict=pass should set testsPassed=true");
  } finally {
    await unlink(outputPath).catch(() => {});
  }
});

test("deriveTestsPassed: verdict=fail sets testsPassed=false when reviewerResult.testsPassed is absent", async () => {
  const outcome = await evaluateContractOutcome(
    noArtifactContract("TPD-FAIL-VERDICT"),
    {
      collected: true,
      stageRunResult: {
        version: 1,
        status: "completed",
        artifacts: [],
      },
      reviewerResult: {
        verdict: "fail",
        // testsPassed intentionally absent — should fall through to verdict
      },
    },
  );
  assert.equal(outcome.testsPassed, false, "verdict=fail should set testsPassed=false");
});

test("deriveTestsPassed: explicit testsPassed=true in reviewerResult takes precedence over verdict", async () => {
  const outcome = await evaluateContractOutcome(
    noArtifactContract("TPD-EXPLICIT-TRUE"),
    {
      collected: true,
      stageRunResult: {
        version: 1,
        status: "completed",
        artifacts: [],
      },
      reviewerResult: {
        verdict: "fail",
        testsPassed: true, // explicit true overrides verdict
      },
    },
  );
  assert.equal(outcome.testsPassed, true, "explicit testsPassed=true must override verdict=fail");
});

test("deriveTestsPassed: explicit testsPassed=false in reviewerResult takes precedence over verdict", async () => {
  const outputPath = `/tmp/tpd-explicit-false-${Date.now()}.md`;
  await writeFile(outputPath, "output content\n", "utf8");
  try {
    const outcome = await evaluateContractOutcome(
      {
        id: "TPD-EXPLICIT-FALSE",
        task: "test",
        status: CONTRACT_STATUS.RUNNING,
        output: outputPath,
      },
      {
        collected: true,
        stageRunResult: {
          version: 1,
          status: "completed",
          artifacts: [],
        },
        reviewerResult: {
          verdict: "pass",
          testsPassed: false, // explicit false overrides verdict
        },
      },
    );
    assert.equal(outcome.testsPassed, false, "explicit testsPassed=false must override verdict=pass");
  } finally {
    await unlink(outputPath).catch(() => {});
  }
});

test("deriveTestsPassed: testsPassed string 'true' is normalized to boolean true", async () => {
  const outputPath = `/tmp/tpd-string-true-${Date.now()}.md`;
  await writeFile(outputPath, "output content\n", "utf8");
  try {
    const outcome = await evaluateContractOutcome(
      {
        id: "TPD-STRING-TRUE",
        task: "test",
        status: CONTRACT_STATUS.RUNNING,
        output: outputPath,
      },
      {
        collected: true,
        stageRunResult: { version: 1, status: "completed", artifacts: [] },
        reviewerResult: { testsPassed: "true" },
      },
    );
    assert.equal(outcome.testsPassed, true, 'string "true" should normalize to boolean true');
  } finally {
    await unlink(outputPath).catch(() => {});
  }
});

test("deriveTestsPassed: testsPassed=null with no verdict → testsPassed absent from outcome", async () => {
  const outcome = await evaluateContractOutcome(
    noArtifactContract("TPD-NULL-NO-VERDICT"),
    {
      collected: true,
      stageRunResult: {
        version: 1,
        status: "completed",
        artifacts: [],
      },
      reviewerResult: {
        // no testsPassed, no verdict
      },
    },
  );
  // testsPassed should not appear in outcome when it cannot be derived
  assert.equal("testsPassed" in outcome, false, "testsPassed should be absent from outcome when it cannot be derived");
});

// ── Regression guard: the old bug — undefined testsPassed was locked to false ───

test("regression guard: undefined testsPassed with verdict=improved → testsPassed=true (old bug returned false)", async () => {
  const outputPath = `/tmp/tpd-improved-${Date.now()}.md`;
  await writeFile(outputPath, "output content\n", "utf8");
  try {
    const outcome = await evaluateContractOutcome(
      {
        id: "TPD-IMPROVED",
        task: "test",
        status: CONTRACT_STATUS.RUNNING,
        output: outputPath,
      },
      {
        collected: true,
        stageRunResult: { version: 1, status: "completed", artifacts: [] },
        reviewerResult: {
          verdict: "improved",
          // testsPassed absent — old bug: was locked to false because normalizeBoolean(undefined)=false
        },
      },
    );
    assert.equal(outcome.testsPassed, true, "verdict=improved should set testsPassed=true");
  } finally {
    await unlink(outputPath).catch(() => {});
  }
});
