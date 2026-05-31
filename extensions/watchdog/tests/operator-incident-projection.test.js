import test from "node:test";
import assert from "node:assert/strict";

import {
  summarizeRuntimeIncident,
} from "../lib/operator/operator-snapshot-runtime.js";
import {
  summarizeWorkItem,
} from "../lib/operator/operator-snapshot-summarizers.js";

test("operator snapshot projects runtime incident without creating a second taxonomy", () => {
  const summary = summarizeRuntimeIncident({
    contractId: "TC-1",
    rootFault: "mixed_fault",
    firstFaultCode: "identical_tool_loop",
    amplifiers: ["wrong_actor_activation"],
    status: "fail_fast",
    terminationReason: "wrong_actor_activation",
  });

  assert.equal(summary.rootFault, "mixed_fault");
  assert.equal(summary.firstFaultCode, "identical_tool_loop");
  assert.deepEqual(summary.amplifiers, ["wrong_actor_activation"]);
  assert.equal(summary.terminationReason, "wrong_actor_activation");
});

test("work item summary carries runtime incident truth unchanged", () => {
  const summary = summarizeWorkItem({
    id: "TC-1",
    status: "failed",
    task: "simple contract",
    deliveryTargets: [],
    runtimeDiagnostics: {
      executionIncident: {
        contractId: "TC-1",
        rootFault: "mixed_fault",
        firstFaultCode: "identical_tool_loop",
        amplifiers: ["wrong_actor_activation"],
        status: "fail_fast",
        terminationReason: "wrong_actor_activation",
      },
    },
  });

  assert.equal(summary.incident?.rootFault, "mixed_fault");
  assert.equal(summary.incident?.firstFaultCode, "identical_tool_loop");
  assert.deepEqual(summary.incident?.amplifiers, ["wrong_actor_activation"]);
});
