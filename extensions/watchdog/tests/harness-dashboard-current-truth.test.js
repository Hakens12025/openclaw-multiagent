import test from "node:test";
import assert from "node:assert/strict";

import { summarizeHarnessPlacement } from "../lib/harness/harness-dashboard.js";
import { normalizeHarnessRun } from "../lib/harness/harness-run.js";

function buildHarnessRun(automationId, round, status) {
  const now = Date.now();
  return normalizeHarnessRun({
    id: `harness:${automationId}:round:${round}:ts:${now}`,
    automationId,
    round,
    requestedAt: now - 1000,
    enabled: true,
    executionMode: "guarded",
    moduleRefs: ["harness:gate.artifact"],
    coverage: {
      hardShaped: ["required_artifact_gate"],
    },
    status,
    startedAt: now - 500,
    finalizedAt: status === "running" ? null : now,
    moduleRuns: [
      {
        moduleId: "harness:gate.artifact",
        kind: "gate",
        status: status === "running" ? "pending" : "passed",
      },
    ],
    decision: status === "running" ? null : "continue",
  });
}

test("summarizeHarnessPlacement ignores stale summary fields and uses canonical automation truth", () => {
  const placement = summarizeHarnessPlacement({
    id: "automation-placement-truth",
    summary: {
      objectiveSummary: "stale objective",
      objectiveDomain: "stale-domain",
      targetAgent: "legacy-agent",
      runtimeStatus: "paused",
      currentRound: 99,
      bestScore: 999,
      executionMode: "freeform",
      assuranceLevel: "low_assurance",
      harnessEnabled: false,
      harnessProfileId: "legacy-profile",
      harnessProfileTrustLevel: "experimental",
      activeHarnessGateVerdict: "failed",
      activeHarnessPendingModuleCount: 8,
      activeHarnessFailedModuleCount: 6,
      recentHarnessRunCount: 42,
    },
    objective: {
      summary: "canonical objective",
      domain: "analysis",
    },
    entry: {
      targetAgent: "worker-a",
    },
    harness: {
      moduleRefs: ["harness:gate.artifact"],
    },
    runtime: {
      status: "running",
      currentRound: 2,
      bestScore: 0.6,
      activeHarnessRun: buildHarnessRun("automation-placement-truth", 2, "running"),
      lastHarnessRun: buildHarnessRun("automation-placement-truth", 1, "completed"),
      recentHarnessRuns: [],
    },
  });

  assert.equal(placement.objectiveSummary, "canonical objective");
  assert.equal(placement.objectiveDomain, "analysis");
  assert.equal(placement.targetAgent, "worker-a");
  assert.equal(placement.runtimeStatus, "running");
  assert.equal(placement.executionMode, "guarded");
  assert.equal(placement.harnessEnabled, true);
  assert.equal(placement.harnessProfileId, null);
  assert.equal(placement.currentRound, 2);
  assert.equal(placement.bestScore, 0.6);
  assert.equal(placement.gateVerdict, "pending");
  assert.equal(placement.pendingModuleCount, 1);
  assert.equal(placement.failedModuleCount, 0);
  assert.equal(placement.recentHarnessRunCount, 0);
  assert.equal(placement.activeRun.id?.startsWith("harness:automation-placement-truth:round:2:"), true);
  assert.equal(placement.activeRun.gateVerdict, "pending");
  assert.deepEqual(placement.activeRun.pendingModuleIds, ["harness:gate.artifact"]);
  assert.equal(placement.lastRun.gateVerdict, "passed");
  assert.equal(placement.lastRun.decision, "continue");
});
