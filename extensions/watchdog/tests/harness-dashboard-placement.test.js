import test from "node:test";
import assert from "node:assert/strict";

import { summarizeHarnessPlacement } from "../lib/harness/harness-dashboard.js";

test("summarizeHarnessPlacement does not echo invalid raw harness module refs", () => {
  const placement = summarizeHarnessPlacement({
    id: "automation-invalid-harness",
    objective: {
      summary: "invalid harness automation",
      domain: "generic",
    },
    harness: {
      enabled: true,
      mode: "guarded",
      moduleRefs: ["artifact_required_check"],
      coverage: {
        hardShaped: ["required_artifact_gate"],
      },
    },
    runtime: {},
    summary: {},
  });

  assert.deepEqual(placement.moduleRefs, []);
  assert.equal(placement.harnessEnabled, false);
  assert.equal(
    placement.stages.every((stage) => Array.isArray(stage?.lanes?.hardShaped) && stage.lanes.hardShaped.length === 0),
    true,
  );
});
