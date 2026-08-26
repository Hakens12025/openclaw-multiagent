import test from "node:test";
import assert from "node:assert/strict";

import { buildAutomationManagementTarget } from "../lib/management/capability-management-targets.js";

test("buildAutomationManagementTarget ignores stale summary fields and uses canonical automation truth", () => {
  const target = buildAutomationManagementTarget({
    id: "automation-management-truth",
    summary: {
      objectiveSummary: "stale objective",
      objectiveDomain: "stale-domain",
      targetAgent: "legacy-agent",
      runtimeStatus: "paused",
    },
    objective: {
      summary: "canonical objective",
      domain: "analysis",
    },
    entry: {
      targetAgent: "worker-a",
    },
    runtime: {
      status: "running",
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
  assert.match(target.detail || "", /analysis/);
  assert.equal((target.detail || "").includes("legacy-profile"), false);
});
