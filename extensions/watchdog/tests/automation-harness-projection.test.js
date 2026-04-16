import test from "node:test";
import assert from "node:assert/strict";

import { upsertAutomationSpec, deleteAutomationSpec } from "../lib/automation/automation-registry.js";
import {
  deleteAutomationRuntimeState,
  ensureAutomationRuntimeState,
  summarizeAutomationRuntimeRegistry,
  upsertAutomationRuntimeState,
} from "../lib/automation/automation-runtime.js";
import { projectAutomationHarnessSummary } from "../lib/automation/automation-harness-projection.js";
import { buildOperatorSnapshot } from "../lib/operator/operator-snapshot.js";

function buildAutomationId(label) {
  return `automation-harness-projection-${label}-${Date.now()}`;
}

function buildHarnessCoverage() {
  return {
    hardShaped: ["artifact_capture", "required_artifact_gate"],
    softGuided: ["experiment_memo"],
    freeform: ["research_reasoning"],
  };
}

function buildHarnessRun(automationId, round, status) {
  const now = Date.now();
  return {
    id: `harness:${automationId}:round:${round}:ts:${now}`,
    automationId,
    round,
    requestedAt: now - 1000,
    enabled: true,
    executionMode: "hybrid",
    profileId: "experiment.research_cycle",
    profileTrustLevel: "provisional",
    moduleRefs: [
      "harness:collector.artifact",
      "harness:gate.artifact",
      "harness:gate.schema",
    ],
    coverage: buildHarnessCoverage(),
    coverageCounts: {
      hardShaped: 2,
      softGuided: 1,
      freeform: 1,
    },
    status,
    startedAt: now - 500,
    finalizedAt: status === "running" ? null : now,
    moduleRuns: [
      {
        moduleId: "harness:collector.artifact",
        kind: "collector",
        status: "passed",
      },
      {
        moduleId: "harness:gate.artifact",
        kind: "gate",
        status: status === "running" ? "pending" : "passed",
      },
      {
        moduleId: "harness:gate.schema",
        kind: "gate",
        status: status === "running" ? "pending" : "passed",
      },
    ],
    decision: status === "running" ? null : "continue",
  };
}

test("projectAutomationHarnessSummary derives canonical harness fields from runtime truth", () => {
  const projection = projectAutomationHarnessSummary({
    harness: {
      enabled: true,
      mode: "hybrid",
      profileId: "experiment.research_cycle",
      profileTrustLevel: "provisional",
      moduleRefs: [
        "harness:collector.artifact",
        "harness:gate.artifact",
        "harness:gate.schema",
      ],
      coverage: buildHarnessCoverage(),
    },
    runtime: {
      activeHarnessSpec: {
        automationId: "automation-projection",
        round: 7,
        requestedAt: Date.now() - 2000,
        enabled: true,
        executionMode: "hybrid",
      },
      activeHarnessRun: buildHarnessRun("automation-projection", 7, "running"),
      lastHarnessRun: buildHarnessRun("automation-projection", 6, "completed"),
      recentHarnessRuns: [buildHarnessRun("automation-projection", 6, "completed")],
    },
    summary: {
      activeHarnessStatus: "failed",
      activeHarnessGateVerdict: "failed",
      recentHarnessRunCount: 99,
    },
  });

  assert.equal(projection.executionMode, "hybrid");
  assert.equal(projection.harnessEnabled, true);
  assert.equal(projection.harnessProfileId, "experiment.research_cycle");
  assert.equal(projection.harnessProfileTrustLevel, "provisional");
  assert.equal(projection.harnessModuleCount, 7);
  assert.deepEqual(projection.harnessCoverageCounts, {
    hardShaped: 18,
    softGuided: 3,
    freeform: 3,
  });
  assert.equal(projection.activeHarnessStatus, "running");
  assert.equal(projection.activeHarnessRound, 7);
  assert.equal(projection.activeHarnessGateVerdict, "pending");
  assert.equal(projection.activeHarnessPendingModuleCount, 2);
  assert.equal(projection.activeHarnessFailedModuleCount, 0);
  assert.equal(projection.lastHarnessStatus, "completed");
  assert.equal(projection.lastHarnessDecision, "continue");
  assert.equal(projection.lastHarnessGateVerdict, "passed");
  assert.equal(projection.lastHarnessFailedModuleCount, 0);
  assert.equal(projection.recentHarnessRunCount, 1);
});

test("projectAutomationHarnessSummary ignores invalid raw harness module refs instead of echoing them", () => {
  const projection = projectAutomationHarnessSummary({
    harness: {
      enabled: true,
      mode: "guarded",
      moduleRefs: ["artifact_required_check"],
      coverage: {
        hardShaped: ["required_artifact_gate"],
      },
    },
    runtime: {},
  });

  assert.equal(projection.executionMode, "freeform");
  assert.equal(projection.harnessEnabled, false);
  assert.equal(projection.harnessModuleCount, 0);
  assert.deepEqual(projection.harnessCoverageCounts, {
    hardShaped: 0,
    softGuided: 0,
    freeform: 0,
  });
});

test("automation runtime summary and operator snapshot share the same harness projection", async () => {
  const automationId = buildAutomationId("aligned");
  try {
    const automation = await upsertAutomationSpec({
      id: automationId,
      objective: {
        summary: "Harness projection alignment",
        instruction: "verify harness projection alignment",
        domain: "generic",
      },
      entry: {
        targetAgent: "controller",
      },
      wakePolicy: {
        type: "result",
        onResult: true,
        cooldownSeconds: 30,
      },
      harness: {
        profileId: "experiment.research_cycle",
      },
      systemActionDelivery: {
        agentId: "controller",
      },
    });
    const runtime = await ensureAutomationRuntimeState(automation);
    const activeHarnessRun = buildHarnessRun(automationId, 7, "running");
    const lastHarnessRun = buildHarnessRun(automationId, 6, "completed");
    await upsertAutomationRuntimeState({
      ...runtime,
      status: "running",
      currentRound: 7,
      activeHarnessSpec: {
        automationId,
        round: 7,
        requestedAt: Date.now() - 1500,
        enabled: true,
        executionMode: "hybrid",
        profileId: "experiment.research_cycle",
        profileTrustLevel: "provisional",
        moduleRefs: [
          "harness:collector.artifact",
          "harness:gate.artifact",
          "harness:gate.schema",
        ],
        coverage: buildHarnessCoverage(),
      },
      activeHarnessRun,
      lastHarnessRun,
      recentHarnessRuns: [lastHarnessRun],
    });

    const registry = await summarizeAutomationRuntimeRegistry();
    const runtimeAutomation = registry.automations.find((entry) => entry.id === automationId);
    const snapshot = await buildOperatorSnapshot({ listLimit: 10 });
    const snapshotAutomation = snapshot.automations.recent.find((entry) => entry.id === automationId);

    assert.ok(runtimeAutomation, "runtime registry should include target automation");
    assert.ok(snapshotAutomation, "operator snapshot should include target automation");
    assert.equal(snapshotAutomation.executionMode, runtimeAutomation.summary.executionMode);
    assert.equal(snapshotAutomation.harnessEnabled, runtimeAutomation.summary.harnessEnabled);
    assert.equal(snapshotAutomation.harnessProfileId, runtimeAutomation.summary.harnessProfileId);
    assert.equal(snapshotAutomation.harnessProfileTrustLevel, runtimeAutomation.summary.harnessProfileTrustLevel);
    assert.deepEqual(snapshotAutomation.harnessCoverageCounts, runtimeAutomation.summary.harnessCoverageCounts);
    assert.equal(snapshotAutomation.activeHarnessStatus, runtimeAutomation.summary.activeHarnessStatus);
    assert.equal(snapshotAutomation.activeHarnessRound, runtimeAutomation.summary.activeHarnessRound);
    assert.equal(snapshotAutomation.activeHarnessRunId, runtimeAutomation.summary.activeHarnessRunId);
    assert.equal(snapshotAutomation.activeHarnessGateVerdict, runtimeAutomation.summary.activeHarnessGateVerdict);
    assert.equal(snapshotAutomation.activeHarnessPendingModuleCount, runtimeAutomation.summary.activeHarnessPendingModuleCount);
    assert.equal(snapshotAutomation.activeHarnessFailedModuleCount, runtimeAutomation.summary.activeHarnessFailedModuleCount);
    assert.equal(snapshotAutomation.lastHarnessStatus, runtimeAutomation.summary.lastHarnessStatus);
    assert.equal(snapshotAutomation.lastHarnessDecision, runtimeAutomation.summary.lastHarnessDecision);
    assert.equal(snapshotAutomation.lastHarnessGateVerdict, runtimeAutomation.summary.lastHarnessGateVerdict);
    assert.equal(snapshotAutomation.lastHarnessFailedModuleCount, runtimeAutomation.summary.lastHarnessFailedModuleCount);
    assert.equal(snapshotAutomation.recentHarnessRunCount, runtimeAutomation.summary.recentHarnessRunCount);
  } finally {
    await deleteAutomationRuntimeState(automationId);
    await deleteAutomationSpec(automationId);
  }
});
