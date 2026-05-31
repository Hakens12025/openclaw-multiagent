import test from "node:test";
import assert from "node:assert/strict";

import {
  clearAllExecutionIncidents,
  getExecutionIncident,
  upsertExecutionIncident,
} from "../lib/runtime/execution-incident-store.js";

test.beforeEach(() => {
  clearAllExecutionIncidents();
});

test("incident store merges later amplification onto the same contract incident", () => {
  upsertExecutionIncident({
    contractId: "TC-1",
    epochKey: "agent:worker:main:run-a",
    sessionKey: "agent:worker:main",
    agentId: "worker",
    rootFault: "llm_fault",
    firstFaultCode: "identical_tool_loop",
    amplifiers: [],
    status: "open",
  });

  const incident = upsertExecutionIncident({
    contractId: "TC-1",
    agentId: "operator",
    rootFault: "mixed_fault",
    amplifiers: ["wrong_actor_activation"],
    status: "fail_fast",
    terminationReason: "wrong_actor_activation",
  });

  assert.equal(incident.contractId, "TC-1");
  assert.equal(incident.rootFault, "mixed_fault");
  assert.equal(incident.firstFaultCode, "identical_tool_loop");
  assert.deepEqual(incident.amplifiers, ["wrong_actor_activation"]);
  assert.equal(incident.status, "fail_fast");
  assert.equal(
    getExecutionIncident({ contractId: "TC-1" })?.terminationReason,
    "wrong_actor_activation",
  );
});
