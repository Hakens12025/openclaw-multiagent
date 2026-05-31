import test from "node:test";
import assert from "node:assert/strict";

import { evaluateRuntimeFault } from "../lib/runtime/runtime-fault-evaluator.js";

test("repeated identical truth reads escalate to llm_fault", () => {
  const incident = evaluateRuntimeFault({
    toolLoop: { sameToolSameInputCount: 3, toolName: "read" },
    progress: { hasFormalProgress: false },
    actor: { agentId: "worker", plane: "runtime" },
  });

  assert.equal(incident.rootFault, "llm_fault");
  assert.equal(incident.firstFaultCode, "identical_tool_loop");
  assert.equal(incident.terminationMode, "terminate_with_diagnosis");
});

test("control-plane activation during ordinary execution escalates to system_fault", () => {
  const incident = evaluateRuntimeFault({
    wrongActorActivation: { agentId: "operator", plane: "control_plane" },
    progress: { hasFormalProgress: false },
  });

  assert.equal(incident.rootFault, "system_fault");
  assert.equal(incident.firstFaultCode, "wrong_actor_activation");
  assert.deepEqual(incident.amplifiers, []);
});

test("wrong actor activation amplifies prior llm fault into mixed_fault", () => {
  const incident = evaluateRuntimeFault({
    wrongActorActivation: { agentId: "operator", plane: "control_plane" },
    progress: { hasFormalProgress: false },
    priorIncident: {
      rootFault: "llm_fault",
      firstFaultCode: "identical_tool_loop",
    },
  });

  assert.equal(incident.rootFault, "mixed_fault");
  assert.equal(incident.firstFaultCode, "identical_tool_loop");
  assert.deepEqual(incident.amplifiers, ["wrong_actor_activation"]);
});

test("max tool calls exhaustion without formal progress remains llm_fault", () => {
  const incident = evaluateRuntimeFault({
    hardStopReason: "max_tool_calls",
    progress: { hasFormalProgress: false },
  });

  assert.equal(incident.rootFault, "llm_fault");
  assert.equal(incident.firstFaultCode, "max_tool_calls");
  assert.equal(incident.terminationMode, "terminate_with_diagnosis");
});
