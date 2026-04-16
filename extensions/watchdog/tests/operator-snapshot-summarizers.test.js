import test from "node:test";
import assert from "node:assert/strict";

import { summarizeAutomation } from "../lib/operator/operator-snapshot-summarizers.js";

test("summarizeAutomation ignores stale summary fields and reads canonical automation state", () => {
  const summary = summarizeAutomation({
    id: "automation-canonical",
    summary: {
      objectiveSummary: "stale summary",
      objectiveDomain: "stale-domain",
      targetAgent: "legacy-agent",
      wakeType: "manual",
      wakeScheduleId: "legacy-schedule",
      runtimeStatus: "paused",
      currentRound: 99,
      bestScore: 999,
      childAutomationCount: 7,
    },
    objective: {
      summary: "canonical objective",
      domain: "research",
    },
    adapters: {
      domain: "analysis",
    },
    entry: {
      targetAgent: "worker-a",
    },
    wakePolicy: {
      type: "event",
      scheduleId: "schedule-real",
    },
    runtime: {
      status: "running",
      currentRound: 2,
      bestScore: 0.7,
      childAutomationIds: ["child-1"],
    },
    harness: {
      enabled: true,
      moduleRefs: ["harness:gate.artifact"],
    },
  });

  assert.equal(summary.objectiveSummary, "canonical objective");
  assert.equal(summary.objectiveDomain, "analysis");
  assert.equal(summary.targetAgent, "worker-a");
  assert.equal(summary.wakeType, "event");
  assert.equal(summary.wakeScheduleId, "schedule-real");
  assert.equal(summary.runtimeStatus, "running");
  assert.equal(summary.currentRound, 2);
  assert.equal(summary.bestScore, 0.7);
  assert.equal(summary.childAutomationCount, 1);
  assert.equal(summary.executionMode, "guarded");
  assert.equal(summary.harnessEnabled, true);
  assert.equal(summary.harnessProfileId, null);
});
