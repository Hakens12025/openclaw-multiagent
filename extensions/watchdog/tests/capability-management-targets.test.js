import test from "node:test";
import assert from "node:assert/strict";

import { buildAutomationManagementTarget } from "../lib/capability/capability-management-targets.js";
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

test("buildAutomationManagementTarget ignores stale summary fields and uses canonical automation truth", () => {
  const target = buildAutomationManagementTarget({
    id: "automation-management-truth",
    summary: {
      objectiveSummary: "stale objective",
      objectiveDomain: "stale-domain",
      targetAgent: "legacy-agent",
      runtimeStatus: "paused",
      executionMode: "freeform",
      harnessProfileId: "legacy-profile",
      activeHarnessGateVerdict: "failed",
      activeHarnessPendingModuleCount: 9,
      activeHarnessFailedModuleCount: 4,
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
      activeHarnessRun: buildHarnessRun("automation-management-truth", 2, "running"),
      lastHarnessRun: buildHarnessRun("automation-management-truth", 1, "completed"),
    },
  }, {
    inspectSurfaces: [],
    applySurfaces: [{
      id: "automations.run",
      subjectScope: "instance",
    }],
    verifySurfaces: [],
    managedAspects: [{
      aspect: "run",
      surfaceId: "automations.run",
    }],
  });

  assert.equal(target.label, "canonical objective");
  assert.match(target.meta || "", /worker-a/);
  assert.match(target.meta || "", /running/);
  assert.match(target.meta || "", /guarded/);
  assert.match(target.detail || "", /analysis/);
  assert.match(target.detail || "", /gate:pending/);
  assert.equal((target.detail || "").includes("legacy-profile"), false);
});
